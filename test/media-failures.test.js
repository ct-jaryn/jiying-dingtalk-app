import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNotificationDelivery } from "../src/delivery.js";
import { runDws } from "../src/dws.js";
import { createMediaError, imageSendError, mediaError } from "../src/media-errors.js";
import { downloadImageUrl, MEDIA_REQUEST_TIMEOUT_MS } from "../src/media.js";
import { emptyTopics } from "../src/topics.js";

const privateUrl = "https://fixture.invalid/image.png?signature=PRIVATE_SIGNED_VALUE";
const event = { message_id: "fixture-image-message", conversation_id: "fixture-image-conversation", sender: "测试同事", content: "[图片消息](mediaId=%24fixture-image)" };
const image = { type: "image", mediaId: "$fixture-image", caption: "**测试同事**：" };

function fixture(options = {}) {
  const calls = [];
  const topics = emptyTopics();
  topics.byDingTalk[event.conversation_id] = { kind: "group", name: "测试群", topicId: "fixture-image-topic" };
  const delivery = createNotificationDelivery({
    chat: { request: async (method, payload) => {
      calls.push({ method, payload });
      return { message: { id: "sent" } };
    } },
    userId: "fixture-owner", topics,
    saveTopics: async () => {}, resolveName: async () => "测试群",
    downloadImage: async () => privateUrl,
    ...options,
  });
  return { delivery, calls };
}

test("永久图片错误只保留固定摘要和稳定错误码，不携带远端原文或签名地址", () => {
  for (const [original, code] of [
    [Object.assign(new Error(`raw ${privateUrl}`), { data: { error: { server_error_code: "NO_PERMISSION" } } }), "MEDIA_PERMISSION_DENIED"],
    [new Error(`INVALID_MEDIA_ID ${privateUrl}`), "MEDIA_RESOURCE_INVALID"],
    [new Error(`HTTP 404 <Code>NoSuchKey</Code> ${privateUrl}`), "MEDIA_RESOURCE_MISSING"],
    [new Error(`图片格式不支持 ${privateUrl}`), "MEDIA_FORMAT_UNSUPPORTED"],
  ]) {
    const error = mediaError(original);
    assert.equal(error.code, code);
    assert.equal(error.permanent, true);
    assert.equal(error.mediaFailure, true);
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(error.message + JSON.stringify(error), /signature|PRIVATE_SIGNED_VALUE|https?:/);
  }
});

test("图片下载的网络和超时错误保持可重试，不能当成资源永久失效", () => {
  for (const [original, code] of [
    [Object.assign(new Error(`timeout ${privateUrl}`), { code: "ETIMEDOUT" }), "MEDIA_TIMEOUT"],
    [new Error(`TLS certificate unknown authority ${privateUrl}`), "MEDIA_NETWORK"],
    [Object.assign(new Error("connection lost"), { code: "ECONNRESET" }), "MEDIA_NETWORK"],
  ]) {
    const error = mediaError(original);
    assert.equal(error.code, code);
    assert.equal(error.mediaFailure, true);
    assert.equal(error.permanent, false);
    assert.doesNotMatch(error.message, /signature|PRIVATE_SIGNED_VALUE|https?:/);
  }
});

test("即应连接故障不计为媒体错误，明确图片格式拒绝才归类", async () => {
  for (const error of [new Error("即应连接未就绪"), Object.assign(new Error("message.send 超时"), { code: "timeout" }), new Error("TLS connection failed")]) {
    assert.equal(imageSendError(error), error);
    const { delivery } = fixture({ chat: { request: async () => { throw error; } } });
    await assert.rejects(delivery.send(image, { event, reason: "group" }), (actual) => actual === error && !actual.mediaFailure);
  }
  const { delivery } = fixture({ chat: { request: async () => { throw new Error(`图片格式不支持 ${privateUrl}`); } } });
  await assert.rejects(delivery.send(image, { event, reason: "group" }), (error) => error.code === "MEDIA_FORMAT_UNSUPPORTED" && error.permanent === true);
});

test("下载必须的临时文件成功后清理，媒体请求只有一次受控预算", async () => {
  let output;
  const url = await downloadImageUrl({ messageId: event.message_id, conversationId: event.conversation_id, mediaId: image.mediaId }, {
    query: async (args, options) => {
      assert.deepEqual(args.slice(0, 3), ["chat", "message", "download-media"]);
      assert.equal(options.timeoutMs, MEDIA_REQUEST_TIMEOUT_MS);
      assert.equal(options.retries, 0);
      output = args[args.indexOf("--output") + 1];
      assert.ok(output.startsWith(tmpdir()));
      await writeFile(output, "fixture image");
      assert.equal(await readFile(output, "utf8"), "fixture image");
      return { data: { downloadUrl: privateUrl } };
    },
  });
  assert.equal(url, privateUrl);
  await assert.rejects(stat(output), { code: "ENOENT" });
});

test("下载失败也清理临时文件，并不将下载器异常或签名 URL 传给队列", async () => {
  let output;
  await assert.rejects(downloadImageUrl({ messageId: event.message_id, conversationId: event.conversation_id, mediaId: image.mediaId }, {
    query: async (args) => {
      output = args[args.indexOf("--output") + 1];
      await writeFile(output, "partial image");
      throw new Error(`NO_PERMISSION ${privateUrl}`);
    },
  }), (error) => error.code === "MEDIA_PERMISSION_DENIED" && !error.message.includes(privateUrl));
  await assert.rejects(stat(output), { code: "ENOENT" });
});

test("图片请求超时会终止实际子进程，不继续后台下载或等待原60秒预算", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jiying-media-timeout-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, "dws");
  const completed = join(directory, "download-completed");
  await writeFile(bin, `#!${process.execPath}\nimport { writeFileSync } from "node:fs";setTimeout(()=>writeFileSync(${JSON.stringify(completed)},"done"),500);\n`);
  await chmod(bin, 0o755);
  const started = performance.now();
  await assert.rejects(downloadImageUrl({ messageId: event.message_id, conversationId: event.conversation_id, mediaId: image.mediaId }, {
    timeoutMs: 50,
    query: (args, options) => runDws(args, { ...options, bin }),
  }), (error) => error.code === "MEDIA_TIMEOUT" && error.permanent === false);
  assert.ok(performance.now() - started < 1500);
  await new Promise((resolve) => setTimeout(resolve, 600));
  await assert.rejects(stat(completed), { code: "ENOENT" });
});

test("永久元数据错误仍渲染已知正文和可归档的图片失败分块", async () => {
  const { delivery, calls } = fixture({ query: async (_args, options) => {
    assert.equal(options.timeoutMs, MEDIA_REQUEST_TIMEOUT_MS);
    assert.equal(options.retries, 0);
    throw new Error(`NO_PERMISSION ${privateUrl}`);
  } });
  const received = { ...event, content: "请确认\n[图片消息]" };
  const parts = await delivery.render(received, "group");
  assert.equal(parts[0], "**测试同事**：请确认\n[图片消息]");
  assert.deepEqual(parts[1], { type: "image", mediaId: "", caption: "", failureCode: "MEDIA_PERMISSION_DENIED" });
  await delivery.send(parts[0], { event: received, reason: "group" });
  assert.equal(calls[0].payload.message.content, parts[0]);
  await assert.rejects(delivery.send(parts[1], { event: received, reason: "group" }), (error) => error.code === "MEDIA_PERMISSION_DENIED" && error.permanent === true);
  assert.equal(calls.length, 1, "失败图片不重复发送先前正文");
  assert.doesNotMatch(JSON.stringify(parts), /signature|PRIVATE_SIGNED_VALUE|https?:/);
});

test("元数据暂时失败且正文没有资源ID时保持未渲染，下一次可以恢复", async () => {
  let failed = true;
  const { delivery } = fixture({ query: async () => {
    if (failed) throw Object.assign(new Error(`timeout ${privateUrl}`), { code: "ETIMEDOUT" });
    return { data: { messages: [{ resources: [{ contentType: "image", resourceIdType: "mediaId", resourceId: image.mediaId }] }] } };
  } });
  const received = { ...event, content: "正文仍保留\n[图片消息]" };
  await assert.rejects(delivery.render(received, "group"), (error) => error.mediaFailure === true && error.permanent === false);
  failed = false;
  const parts = await delivery.render(received, "group");
  assert.equal(parts[0], "**测试同事**：正文仍保留\n[图片消息]");
  assert.deepEqual(parts[1], { type: "image", mediaId: image.mediaId, caption: "" });
});

test("元数据查询失败但正文资源ID可用时继续正常渲染图片", async () => {
  const { delivery } = fixture({ query: async () => { throw new Error("NO_PERMISSION"); } });
  assert.deepEqual(await delivery.render(event, "group"), [image]);
});

test("占位说明保留纯图片发送人或我方向，并仅展示固定安全原因", () => {
  const { delivery } = fixture();
  const error = createMediaError("MEDIA_PERMISSION_DENIED");
  assert.equal(delivery.failurePart(image, { event, reason: "group", error }), "**测试同事**：[图片暂无法转发：没有读取图片的权限，请到钉钉查看原消息]");
  assert.match(delivery.failurePart({ ...image, caption: "**我**：" }, { event, reason: "dm", error }), /^\*\*我\*\*：/);
  assert.doesNotMatch(delivery.failurePart(image, { error: new Error(`raw ${privateUrl}`) }), /signature|PRIVATE_SIGNED_VALUE|https?:/);
});
