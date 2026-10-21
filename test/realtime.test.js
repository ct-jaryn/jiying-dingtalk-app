import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WebSocketServer } from "ws";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pause = (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms));

async function waitFor(check, description, diagnostics = () => "", timeoutMs = 8000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await pause(20);
  }
  throw new Error(`等待 ${description} 超时\n${diagnostics()}`);
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const { port } = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function fixture(t, {
  events = [], mentions = [], port = 0, initiallyOffline = false, failOnce = "", push,
  groupSettings = { "fixture-muted-group": 1, "fixture-open-group": 0 },
}) {
  const directory = await mkdtemp(join(tmpdir(), "jiying-realtime-test-"));
  const servers = [];
  const requests = [];
  const delivered = [];
  const deliveries = [];
  const failed = new Set();
  const sockets = new Set();
  let nextMessage = 0;
  let nextTopic = 0;
  let nextEvent = 0;
  let child;
  let output = "";
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolveClose) => child.once("close", resolveClose));
      child.kill("SIGTERM");
      let timer;
      const timeout = new Promise((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(false), 4500); });
      const exited = await Promise.race([closed.then(() => true), timeout]);
      clearTimeout(timer);
      if (!exited) { child.kill("SIGKILL"); await closed; }
    }
    // Also clean up the fixture listener if an assertion required killing the
    // parent before its own graceful shutdown could stop dws.
    try {
      const pid = Number(await readFile(join(directory, "event.pid"), "utf8"));
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGTERM");
    } catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error; }
    for (const server of servers) {
      for (const client of server.clients) client.terminate();
      await new Promise((resolveClose) => server.close(() => resolveClose()));
    }
    await rm(directory, { recursive: true, force: true });
  });

  await cp(join(project, "src"), join(directory, "src"), { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }));
  await symlink(join(project, "node_modules"), join(directory, "node_modules"), "dir");
  await mkdir(join(directory, "bin"));
  await writeFile(join(directory, "events.json"), JSON.stringify(events));
  await writeFile(join(directory, "mentions.json"), JSON.stringify(mentions));
  await writeFile(join(directory, "group-settings.json"), JSON.stringify(groupSettings));
  const fakeDws = join(directory, "bin", "dws");
  await writeFile(fakeDws, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const root = process.env.REALTIME_FIXTURE_ROOT;
appendFileSync(join(root, "calls.jsonl"), JSON.stringify(args) + "\\n");
if (args[0] === "event" && args[1] === "consume") {
  writeFileSync(join(root, "event.pid"), String(process.pid));
  process.stderr.write("[event] ready event_count=3\\n");
  for (const event of JSON.parse(readFileSync(join(root, "events.json"), "utf8"))) {
    process.stdout.write(JSON.stringify(event) + "\\n");
  }
  setInterval(() => {}, 1000);
} else if (args[0] === "chat" && args[1] === "+at-me") {
  process.stdout.write(JSON.stringify({ items: JSON.parse(readFileSync(join(root, "mentions.json"), "utf8")), complete: true }));
} else if (args[0] === "chat" && args[1] === "+conversation-info") {
  process.stdout.write(JSON.stringify({ conversationInfo: { title: "集成验证群" } }));
} else if (args[0] === "chat" && args[1] === "group" && args[2] === "user-settings" && args[3] === "query") {
  const groupId = args[args.indexOf("--groups") + 1];
  const settings = JSON.parse(readFileSync(join(root, "group-settings.json"), "utf8"));
  process.stdout.write(JSON.stringify({ result: { settings: [{ openConversationId: groupId, success: true, notificationOff: settings[groupId] ?? 1 }] } }));
} else if (args[0] === "chat" && args[1] === "+messages-mget") {
  process.stdout.write(JSON.stringify({ messages: [{ resources: [{ contentType: "image", resourceIdType: "mediaId", resourceId: "fixture-image-resource" }] }] }));
} else if (args[0] === "chat" && args[1] === "message" && args[2] === "download-media") {
  process.stdout.write(JSON.stringify({ downloadUrl: "https://fixture.invalid/image.png" }));
} else if (args[0] === "chat" && args[1] === "+messages-send") {
  process.stdout.write(JSON.stringify({ success: true, result: { messageId: "msgFixtureRelayedMessage" } }));
} else if (args[0] === "chat" && args[1] === "+messages-create-text-emotion") {
  process.stdout.write(JSON.stringify({ success: true, result: { emotionId: "fixture-emotion-id" } }));
} else if (args[0] === "chat" && args[1] === "+messages-add-text-emotion") {
  process.stdout.write(JSON.stringify({ success: true }));
} else {
  process.stdout.write(JSON.stringify({ success: false, errorMsg: "不应调用的 fixture 命令: " + args.join(" ") }));
  process.exitCode = 9;
}
`);
  await chmod(fakeDws, 0o755);

  async function startServer(selectedPort = port) {
    const server = new WebSocketServer({ host: "127.0.0.1", port: selectedPort });
    servers.push(server);
    await new Promise((resolveListen, reject) => {
      server.once("listening", resolveListen);
      server.once("error", reject);
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("message", (raw) => {
        const envelope = JSON.parse(raw.toString());
        requests.push(envelope);
        const content = envelope.payload?.message?.content || "";
        const shouldFail = envelope.method === "message.send" && failOnce && content.includes(failOnce) && !failed.has(failOnce);
        if (shouldFail) failed.add(failOnce);
        else if (envelope.method === "message.send" && envelope.payload?.target?.type === "topic") {
          delivered.push(content);
          deliveries.push(envelope.payload);
        }
        let payload = {};
        if (envelope.method === "message.send") {
          payload = {
            conversation: { id: envelope.payload.target.conversation_id || "fixture-parent" },
            message: { id: `fixture-message-${++nextMessage}` },
          };
        } else if (envelope.method === "conversation.topic.create") {
          payload = { conversation: { id: `fixture-topic-${++nextTopic}` } };
        }
        socket.send(JSON.stringify({
          v: 1, kind: "response", reply_to: envelope.id, ok: !shouldFail,
          ...(shouldFail ? { error: { code: "FIXTURE_TRANSIENT", message: "本地测试瞬时发送失败" } } : { payload }),
        }));
      });
    });
    return server.address().port;
  }

  const selectedPort = initiallyOffline ? port : await startServer();
  await writeFile(join(directory, "config.yaml"), JSON.stringify({
    anthropic: { base_url: "http://127.0.0.1:1", model: "dummy-model", api_key: "dummy-model-key" },
    magicchat: { ws_url: `ws://127.0.0.1:${selectedPort}`, app_id: "dummy-app", app_secret: "dummy-secret", user_id: "dummy-user" },
    ...(push ? { push } : {}),
  }));
  child = spawn(process.execPath, ["src/index.js"], {
    cwd: directory,
    env: { ...process.env, PATH: `${join(directory, "bin")}:${process.env.PATH || ""}`, REALTIME_FIXTURE_ROOT: directory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (text) => { output += text; });
  child.stderr.on("data", (text) => { output += text; });
  child.on("error", (error) => { output += `\n${error.stack}`; });
  const diagnostics = () => `child exit=${child.exitCode} signal=${child.signalCode}\n${output}`;
  return {
    directory, delivered, deliveries, requests, failed, diagnostics, startServer,
    readOutbox: () => readJson(join(directory, "data", "push-outbox.json"), null),
    async emitMessage({ topicId, text, senderId = "dummy-user", messageId = `fixture-inbound-${++nextEvent}` }) {
      await waitFor(() => sockets.size > 0, "即应客户端连接", diagnostics);
      const cursor = `fixture-cursor-${++nextEvent}`;
      const envelope = {
        v: 1, kind: "event", event: "message.created", cursor,
        payload: {
          conversation: { id: topicId, type: "topic", parent: { id: "fixture-parent", type: "app" } },
          sender: { id: senderId },
          message: { id: messageId, body: { type: "text", content: text } },
        },
      };
      for (const socket of sockets) socket.send(JSON.stringify(envelope));
      await waitFor(() => requests.some((item) => item.method === "events.ack" && item.payload?.cursor === cursor), "即应事件处理并确认", diagnostics);
    },
    async calls() {
      try { return (await readFile(join(directory, "calls.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); }
      catch (error) { if (error.code === "ENOENT") return []; throw error; }
    },
  };
}

const group = (message_id, content, type = "user_im_message_receive_group_all", conversation_id = "fixture-muted-group") => ({
  type, message_id, conversation_id, sender: "测试同事", content, timestamp: 1_792_539_000_000,
});

test("真实进程通过群事件补查 @，去重并向即应实时投递，发送失败自动重试", { timeout: 15_000 }, async (t) => {
  const app = await fixture(t, {
    push: { all_group_messages: false },
    events: [
      group("fallback", "TARGET_FALLBACK 请处理"),
      group("ordinary", "ORDINARY_DO_NOT_NOTIFY"),
      group("native", "NATIVE_DUPLICATE", "user_im_message_receive_at"),
      group("native", "NATIVE_DUPLICATE"),
      group("all", "@所有人 ALL_BROADCAST"),
      group("dm", "DIRECT_MESSAGE_RETRY", "user_im_message_receive_o2o_all"),
    ],
    mentions: [
      { messageId: "fallback", conversationId: "fixture-muted-group", conversation: { name: "集成验证群" } },
      { messageId: "native", conversationId: "fixture-muted-group", conversation: { name: "集成验证群" } },
    ],
    failOnce: "DIRECT_MESSAGE_RETRY",
  });
  await waitFor(async () => {
    const outbox = await app.readOutbox();
    return app.delivered.length === 4 && Object.keys(outbox?.delivered || {}).length === 4;
  }, "四类相关通知落盘完成", app.diagnostics);
  for (const marker of ["TARGET_FALLBACK", "NATIVE_DUPLICATE", "ALL_BROADCAST", "DIRECT_MESSAGE_RETRY"]) {
    assert.equal(app.delivered.filter((text) => text.includes(marker)).length, 1, marker);
  }
  assert.equal(app.delivered.some((text) => text.includes("ORDINARY_DO_NOT_NOTIFY")), false);
  assert.ok(app.requests.some((item) => item.method === "message.send" && item.payload.target.type === "user" && item.payload.message.content === "集成验证群"), "用群名创建话题锚点");
  assert.ok(app.deliveries.every((item) => item.target.type === "topic"), "实际通知进入话题");
  assert.equal(app.failed.size, 1);
  assert.equal(app.requests.filter((item) => item.method === "message.send" && item.payload.message.content.includes("DIRECT_MESSAGE_RETRY")).length, 2);
  const calls = await app.calls();
  assert.ok(calls.some((args) => args[0] === "event" && args[1] === "consume"));
  assert.ok(calls.some((args) => args[0] === "chat" && args[1] === "+at-me"));
  assert.equal(calls.some((args) => args.includes("user-settings")), false, "@通知不受群免打扰查询阻挡");
});

test("默认转发非免打扰群全量消息，免打扰群仍转发精确匹配的 @ 与原生 @", { timeout: 15_000 }, async (t) => {
  const app = await fixture(t, {
    events: [
      group("open-ordinary", "OPEN_GROUP_ORDINARY", undefined, "fixture-open-group"),
      group("open-ordinary", "OPEN_GROUP_ORDINARY", undefined, "fixture-open-group"),
      group("muted-ordinary", "MUTED_ORDINARY_DO_NOT_NOTIFY"),
      group("muted-fallback", "MUTED_FALLBACK_MENTION"),
      group("muted-native", "MUTED_NATIVE_MENTION", "user_im_message_receive_at", "fixture-muted-native-only"),
      group("muted-all", "@所有人 MUTED_AT_ALL", undefined, "fixture-muted-all-only"),
    ],
    mentions: [{ messageId: "muted-fallback", conversationId: "fixture-muted-group" }],
    groupSettings: {
      "fixture-open-group": 0,
      "fixture-muted-group": 1,
      "fixture-muted-native-only": 1,
      "fixture-muted-all-only": 1,
    },
  });
  await waitFor(async () => {
    const outbox = await app.readOutbox();
    return app.delivered.length === 4 && Object.keys(outbox?.delivered || {}).length === 4;
  }, "开放群普通消息与免打扰群的三类 @ 通知完成", app.diagnostics);
  for (const marker of ["OPEN_GROUP_ORDINARY", "MUTED_FALLBACK_MENTION", "MUTED_NATIVE_MENTION", "MUTED_AT_ALL"]) {
    assert.equal(app.delivered.filter((text) => text.includes(marker)).length, 1, marker);
  }
  assert.equal(app.delivered.some((text) => text.includes("MUTED_ORDINARY_DO_NOT_NOTIFY")), false);
  const calls = await app.calls();
  const settingsQueries = calls.filter((args) => args[1] === "group" && args[2] === "user-settings" && args[3] === "query");
  assert.ok(settingsQueries.some((args) => args.includes("fixture-open-group")), "普通群消息按免打扰设置过滤");
  assert.ok(settingsQueries.some((args) => args.includes("fixture-muted-group")), "免打扰群普通消息经过设置查询");
  assert.equal(settingsQueries.some((args) => args.includes("fixture-muted-native-only") || args.includes("fixture-muted-all-only")), false, "原生 @ 与 @所有人直接通知");
  assert.ok(calls.some((args) => args[1] === "+at-me" && args.includes("fixture-muted-group")), "免打扰群普通事件仍按消息 ID 补查 @");
});

test("即应初始离线时真实进程先收取并持久化，连接恢复后自动投递", { timeout: 15_000 }, async (t) => {
  const port = await unusedPort();
  const app = await fixture(t, {
    port, initiallyOffline: true,
    events: [group("offline-dm", "OFFLINE_PENDING", "user_im_message_receive_o2o_all")],
  });
  await waitFor(async () => {
    const outbox = await app.readOutbox();
    return outbox?.pending?.some((item) => item.event.message_id === "offline-dm");
  }, "即应离线期间收到的钉钉通知落盘", app.diagnostics);
  assert.equal(app.delivered.length, 0);
  assert.ok((await app.calls()).some((args) => args[0] === "event" && args[1] === "consume"));
  await app.startServer(port);
  await waitFor(async () => {
    const outbox = await app.readOutbox();
    return app.delivered.length === 1 && outbox?.pending?.length === 0;
  }, "重连后发送已保留通知", app.diagnostics);
  assert.match(app.delivered[0], /OFFLINE_PENDING/);
});

test("图片失败后仅重试图片，同一钉钉会话复用即应话题", { timeout: 15_000 }, async (t) => {
  const app = await fixture(t, {
    events: [
      group("image", "BODY_BEFORE_IMAGE\n[图片消息](mediaId=fixture-image-resource)", "user_im_message_receive_at"),
      group("same-group", "SAME_TOPIC_SECOND_MESSAGE", "user_im_message_receive_at"),
    ],
    failOnce: "https://fixture.invalid/image.png",
  });
  await waitFor(async () => {
    const outbox = await app.readOutbox();
    return app.deliveries.length === 3 && Object.keys(outbox?.delivered || {}).length === 2;
  }, "正文与图片投递完成", app.diagnostics);

  assert.equal(app.delivered.filter((text) => text.includes("BODY_BEFORE_IMAGE")).length, 1, "图片重试不重发已确认正文");
  assert.equal(app.deliveries.filter((item) => item.message.type === "image").length, 1);
  assert.equal(app.requests.filter((item) => item.method === "message.send" && item.payload.message.type === "image").length, 2);
  assert.equal(app.requests.filter((item) => item.method === "conversation.topic.create").length, 1);
  assert.equal(new Set(app.deliveries.map((item) => item.target.conversation_id)).size, 1);
  assert.equal(app.requests.filter((item) => item.method === "message.send" && item.payload.target.type === "user").length, 1, "只发一个会话名锚点");
  const calls = await app.calls();
  assert.ok(calls.some((args) => args[1] === "+messages-mget" && args.includes("image")));
  assert.equal(calls.filter((args) => args[1] === "message" && args[2] === "download-media").length, 2, "每次图片重试都重新取得下载地址");
});

test("仅 owner 的话题文字直接转发回绑定钉钉群，并防止重复转发", { timeout: 15_000 }, async (t) => {
  const app = await fixture(t, {
    events: [group("reply-source", "CREATE_REPLY_TOPIC", "user_im_message_receive_at")],
  });
  await waitFor(async () => {
    const outbox = await app.readOutbox();
    return Object.keys(outbox?.delivered || {}).length === 1;
  }, "话题创建并送达", app.diagnostics);
  const topicId = app.deliveries[0].target.conversation_id;
  await app.emitMessage({ topicId, text: "NON_OWNER_MUST_NOT_RELAY", senderId: "another-user", messageId: "foreign-reply" });
  assert.equal((await app.calls()).filter((args) => args[1] === "+messages-send").length, 0);
  await app.emitMessage({ topicId, text: "OWNER_REPLY_DIRECT", messageId: "owner-reply" });
  await app.emitMessage({ topicId, text: "OWNER_REPLY_DIRECT", messageId: "owner-reply" });
  const relays = (await app.calls()).filter((args) => args[0] === "chat" && args[1] === "+messages-send");
  assert.equal(relays.length, 1);
  assert.equal(relays[0][relays[0].indexOf("--as") + 1], "user");
  assert.equal(relays[0][relays[0].indexOf("--group") + 1], "fixture-muted-group");
  assert.equal(relays[0][relays[0].indexOf("--text") + 1], "OWNER_REPLY_DIRECT");
  assert.ok(relays[0].includes("--ai-tag=false"));
  assert.ok(relays[0].includes("--wait-delivery"));
  const stamps = (await app.calls()).filter((args) => args[1] === "+messages-add-text-emotion");
  assert.equal(stamps.length, 1, "成功回复只贴一次使用即应发送标记");
  assert.equal(stamps[0][stamps[0].indexOf("--msg-id") + 1], "msgFixtureRelayedMessage");
});
