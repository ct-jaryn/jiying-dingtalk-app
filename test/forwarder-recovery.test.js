import assert from "node:assert/strict";
import test from "node:test";
import { createPushForwarder } from "../src/forwarder.js";

const event = (id, cid = id) => ({ message_id: id, conversation_id: cid, content: "正文", sender: "同事" });
const image = { type: "image", mediaId: "fixture-image", caption: "" };
const key = (value) => JSON.stringify(["dingtalk", value.conversation_id, value.message_id]);
const pending = (value, extra = {}) => ({ key: key(value), event: value, reason: "group", parts: [value.content], nextPart: 0, attempts: 0, mediaAttempts: 0, nextAttemptAt: 0, ...extra });
const mediaError = (permanent = false) => Object.assign(new Error("signed URL or raw error must not be logged"), { code: "MEDIA_UNAVAILABLE", mediaFailure: true, permanent });

function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

async function until(check) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("等待本地队列状态超时");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function fixture(t, { cleanup, ...options } = {}) {
  const state = options.state || { pending: [], delivered: {} };
  const sent = [];
  const saved = [];
  const forwarder = createPushForwarder({
    state,
    saveState: async (snapshot) => { saved.push(structuredClone(snapshot)); },
    render: (value) => [value.content],
    send: async (part, metadata) => { sent.push({ part, ...metadata }); },
    retryDelayMs: 60_000,
    maxRetryDelayMs: 60_000,
    ...options,
  });
  t.after(async () => { cleanup?.(); forwarder.stop(); await forwarder.waitForIdle(); });
  return { state, sent, saved, forwarder };
}

test("慢图片在途时，新入队的其他会话文字立即获得独立工作位", async (t) => {
  const blocked = gate();
  const sent = [];
  const first = event("slow-image");
  const state = { pending: [pending(first, { parts: [image], attempts: 2 })], delivered: {} };
  const app = fixture(t, {
    state, cleanup: blocked.release,
    send: async (part, { event: value }) => { sent.push(value.message_id); if (part.type === "image") await blocked.promise; },
  });
  await until(() => sent.includes("slow-image"));
  await app.forwarder.enqueue(event("new-text"), "dm");
  await until(() => sent.includes("new-text"));
  assert.equal(state.pending.some((value) => value.event.message_id === "slow-image"), true);
  blocked.release();
  await app.forwarder.waitForIdle();
  assert.equal(state.pending.length, 0);
});

test("同会话在途消息保持串行，不同会话能够同时投递", async (t) => {
  const blocked = gate();
  const started = [];
  const app = fixture(t, {
    cleanup: blocked.release,
    send: async (_part, { event: value }) => { started.push(value.message_id); if (value.message_id === "first") await blocked.promise; },
  });
  await app.forwarder.enqueue(event("first", "same-cid"), "group");
  await until(() => started.includes("first"));
  await app.forwarder.enqueue(event("second", "same-cid"), "group");
  await app.forwarder.enqueue(event("other-cid"), "group");
  await until(() => started.includes("other-cid"));
  assert.equal(started.includes("second"), false);
  blocked.release();
  await app.forwarder.waitForIdle();
  assert.deepEqual(started, ["first", "other-cid", "second"]);
});

test("工作位有界，默认三个会话并发", async (t) => {
  const gates = [gate(), gate(), gate(), gate()];
  const started = [];
  const values = gates.map((_value, index) => event(`text-${index}`));
  const app = fixture(t, {
    state: { pending: values.map((value) => pending(value)), delivered: {} },
    cleanup: () => gates.forEach((value) => value.release()),
    send: async (_part, { event: value }) => { const index = Number(value.message_id.slice(-1)); started.push(index); await gates[index].promise; },
  });
  await until(() => started.length === 3);
  assert.deepEqual(started, [0, 1, 2]);
  gates[0].release();
  await until(() => started.includes(3));
  gates.forEach((value) => value.release());
  await app.forwarder.waitForIdle();
});

test("多个首发图片也仅占一个工作位，文字不等待图片下载结束", async (t) => {
  const blocked = gate();
  const started = [];
  const app = fixture(t, {
    state: { pending: [1, 2, 3].map((id) => pending(event(`image-${id}`), { parts: [image] })), delivered: {} },
    cleanup: blocked.release,
    send: async (part, { event: value }) => { started.push(value.message_id); if (part.type === "image") await blocked.promise; },
  });
  await until(() => started.includes("image-1"));
  await app.forwarder.enqueue(event("text"), "mention");
  await until(() => started.includes("text"));
  assert.deepEqual(started, ["image-1", "text"]);
  blocked.release();
  await app.forwarder.waitForIdle();
  assert.equal(app.state.pending.length, 0);
});

test("旧重试最多占一个工作位，新任务优先且连续十个后仍给旧重试机会", async (t) => {
  const started = [];
  const retry = pending(event("retry"), { attempts: 4 });
  const fresh = Array.from({ length: 14 }, (_value, id) => pending(event(`fresh-${id}`)));
  const app = fixture(t, {
    concurrency: 1, state: { pending: [retry, ...fresh], delivered: {} },
    send: async (_part, { event: value }) => { started.push(value.message_id); },
  });
  await app.forwarder.waitForIdle();
  assert.equal(started.indexOf("retry"), 10);
  assert.equal(started.length, 15);
});

test("多个旧重试不能同时占满工作位，新文字始终可加入", async (t) => {
  const blocked = gate();
  const started = [];
  const app = fixture(t, {
    state: { pending: [1, 2, 3].map((id) => pending(event(`retry-${id}`), { attempts: 1 })), delivered: {} },
    cleanup: blocked.release,
    send: async (_part, { event: value }) => { started.push(value.message_id); if (value.message_id.startsWith("retry")) await blocked.promise; },
  });
  await until(() => started.includes("retry-1"));
  await app.forwarder.enqueue(event("text"), "dm");
  await until(() => started.includes("text"));
  assert.deepEqual(started, ["retry-1", "text"]);
  blocked.release();
  await app.forwarder.waitForIdle();
});

test("明确永久图片失败先原子归档再发说明，保留此前文字进度并继续后续分块", async (t) => {
  const received = event("permanent");
  const delivered = [];
  let archived = false;
  const sent = [];
  const app = fixture(t, {
    state: { pending: [pending(received, { parts: ["已经发过", image, "后续文字"], nextPart: 1 })], delivered: {} },
    saveState: async (snapshot) => { if (snapshot.failed?.length) archived = true; },
    onFailurePart: () => "图片转发失败，请在钉钉查看",
    onDelivered: (_event, _reason, result) => { delivered.push(result); },
    send: async (part) => { if (part.type === "image") throw mediaError(true); assert.equal(archived, true); sent.push(part); },
  });
  await app.forwarder.waitForIdle();
  assert.deepEqual(sent, ["图片转发失败，请在钉钉查看", "后续文字"]);
  assert.equal(app.state.pending.length, 0);
  assert.equal(app.state.failed.length, 1);
  assert.deepEqual(app.state.failed[0].event, received);
  assert.deepEqual(app.state.failed[0].part, image);
  assert.equal(app.state.failed[0].partIndex, 1);
  assert.deepEqual(app.state.failed[0].error, { code: "MEDIA_UNAVAILABLE", permanent: true });
  assert.deepEqual(delivered, [{ partial: true, failedParts: 1 }]);
});

test("失败归档无法落盘时保留原图，不发说明，恢复后可重新归档投递", async (t) => {
  let storageFails = true;
  let imageCalls = 0;
  const sent = [];
  const received = event("archive-failure");
  const app = fixture(t, {
    state: { pending: [pending(received, { parts: [image] })], delivered: {} },
    saveState: async (snapshot) => { if (snapshot.failed?.length && storageFails) throw new Error("磁盘故障"); },
    onFailurePart: () => "图片失败说明",
    send: async (part) => { if (part.type === "image") { imageCalls++; throw mediaError(true); } sent.push(part); },
  });
  await app.forwarder.waitForIdle();
  assert.deepEqual(app.state.pending[0].parts, [image]);
  assert.equal(app.state.failed, undefined);
  assert.deepEqual(sent, []);
  storageFails = false;
  app.forwarder.wake();
  await app.forwarder.waitForIdle();
  assert.equal(imageCalls, 2);
  assert.deepEqual(sent, ["图片失败说明"]);
  assert.equal(app.state.failed.length, 1);
});

test("失败说明断线后重启只续发说明，原图不会重复下载或重复归档", async (t) => {
  let imageCalls = 0;
  const first = fixture(t, {
    state: { pending: [pending(event("placeholder-restart"), { parts: [image] })], delivered: {} },
    onFailurePart: () => "图片失败说明",
    send: async (part) => { if (part.type === "image") { imageCalls++; throw mediaError(true); } throw new Error("WS离线"); },
  });
  await first.forwarder.waitForIdle();
  assert.equal(first.state.pending[0].parts[0], "图片失败说明");
  assert.equal(first.state.failed.length, 1);
  assert.equal(Object.keys(first.state.delivered).length, 0);
  first.forwarder.stop();
  const second = fixture(t, {
    state: structuredClone(first.state),
    send: async (part) => { assert.equal(typeof part, "string"); },
  });
  second.forwarder.wake();
  await second.forwarder.waitForIdle();
  assert.equal(imageCalls, 1);
  assert.equal(second.state.pending.length, 0);
  assert.equal(second.state.failed.length, 1);
});

test("临时即应断线不消耗图片预算，只有媒体失败达到上限才降级", async (t) => {
  let networkFails = true;
  let calls = 0;
  const app = fixture(t, {
    maxMediaAttempts: 2,
    state: { pending: [pending(event("media-budget"), { parts: [image] })], delivered: {} },
    onFailurePart: () => "图片失败说明",
    send: async (part) => { if (typeof part === "string") return; calls++; if (networkFails) throw new Error("WS离线"); throw mediaError(); },
  });
  await app.forwarder.waitForIdle();
  for (let i = 0; i < 2; i++) { app.forwarder.wake(); await app.forwarder.waitForIdle(); }
  assert.equal(app.state.pending[0].attempts, 3);
  assert.equal(app.state.pending[0].mediaAttempts, 0);
  assert.equal(app.state.failed, undefined);
  networkFails = false;
  app.forwarder.wake(); await app.forwarder.waitForIdle();
  assert.equal(app.state.pending[0].mediaAttempts, 1);
  assert.equal(app.state.failed, undefined);
  app.forwarder.wake(); await app.forwarder.waitForIdle();
  assert.equal(calls, 5);
  assert.equal(app.state.pending.length, 0);
  assert.equal(app.state.failed[0].mediaAttempts, 2);
});

test("旧版数万次重试图片需再次确认媒体失败后立即归档，不盲目重新下载五次", async (t) => {
  const old = pending(event("legacy-image"), { parts: [image], attempts: 20000 });
  delete old.mediaAttempts;
  let calls = 0;
  const app = fixture(t, {
    state: { pending: [old], delivered: {} },
    onFailurePart: () => "旧图片已失效",
    send: async (part) => { if (part.type === "image") { calls++; throw mediaError(); } },
  });
  await app.forwarder.waitForIdle();
  assert.equal(calls, 1);
  assert.equal(app.state.pending.length, 0);
  assert.equal(app.state.failed[0].attempts, 20001);
});

test("重连的非强制wake保留退避，显式wake也不重置失败次数", async (t) => {
  let now = 1000;
  let calls = 0;
  const app = fixture(t, {
    now: () => now,
    state: { pending: [pending(event("backoff"), { attempts: 10, nextAttemptAt: 2000 })], delivered: {} },
    send: async () => { calls++; throw new Error("仍离线"); },
  });
  app.forwarder.wake({ force: false });
  await app.forwarder.waitForIdle();
  assert.equal(calls, 0);
  app.forwarder.wake();
  await app.forwarder.waitForIdle();
  assert.equal(calls, 1);
  assert.equal(app.state.pending[0].attempts, 11);
  now = app.state.pending[0].nextAttemptAt;
  app.forwarder.wake({ force: false });
  await app.forwarder.waitForIdle();
  assert.equal(calls, 2);
  assert.equal(app.state.pending[0].attempts, 12);
});

test("失败日志按次数稀疏记录，异常原文和签名地址不写入日志或归档摘要", async (t) => {
  const logs = [];
  const app = fixture(t, {
    onLog: (message, error) => logs.push(`${message}:${error?.message || ""}`),
    send: async () => { throw new Error("https://private.invalid/image?signature=fixture-secret"); },
  });
  await app.forwarder.enqueue(event("logs"), "dm");
  await app.forwarder.waitForIdle();
  for (let i = 0; i < 7; i++) { app.forwarder.wake(); await app.forwarder.waitForIdle(); }
  assert.equal(logs.length, 4);
  assert.doesNotMatch(logs.join("\n"), /private\.invalid|fixture-secret/);
  assert.match(logs.join("\n"), /NOTIFICATION_FAILED/);
});
