import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, chmod, cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WebSocketServer } from "ws";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pause = (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms));
const dmPeer = { id: "fixture-open-peer", userId: "fixture-peer-user", name: "集成验证同事", cid: "fixture-dm-peer" };
const dmSelf = { id: "fixture-open-owner", userId: "fixture-owner-user", name: "本人", cid: "fixture-dm-self" };

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
  echoDuringRelay = false, failStamp = false, failConfirmation = false, sendFails = false, relayDelayMs = 0,
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
  await writeFile(join(directory, "injected-events.jsonl"), "");
  await writeFile(join(directory, "mentions.json"), JSON.stringify(mentions));
  await writeFile(join(directory, "group-settings.json"), JSON.stringify(groupSettings));
  await writeFile(join(directory, "relay-behavior.json"), JSON.stringify({ echoDuringRelay, failStamp, sendFails, relayDelayMs }));
  const fakeDws = join(directory, "bin", "dws");
  await writeFile(fakeDws, `#!${process.execPath}
import { appendFileSync, readFileSync, watchFile, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const root = process.env.REALTIME_FIXTURE_ROOT;
const dmPeople = ${JSON.stringify([dmPeer, dmSelf])};
appendFileSync(join(root, "calls.jsonl"), JSON.stringify(args) + "\\n");
if (args[0] === "event" && args[1] === "consume") {
  writeFileSync(join(root, "event.pid"), String(process.pid));
  process.stderr.write("[event] ready event_count=3\\n");
  for (const event of JSON.parse(readFileSync(join(root, "events.json"), "utf8"))) {
    process.stdout.write(JSON.stringify(event) + "\\n");
  }
  let injected = 0;
  watchFile(join(root, "injected-events.jsonl"), { interval: 10 }, () => {
    const events = readFileSync(join(root, "injected-events.jsonl"), "utf8").trim().split("\\n").filter(Boolean);
    for (; injected < events.length; injected += 1) process.stdout.write(events[injected] + "\\n");
    writeFileSync(join(root, "injected-count.json"), String(injected));
  });
  setInterval(() => {}, 1000);
} else if (args[0] === "chat" && args[1] === "+at-me") {
  process.stdout.write(JSON.stringify({ items: JSON.parse(readFileSync(join(root, "mentions.json"), "utf8")), complete: true }));
} else if (args[0] === "chat" && args[1] === "+conversation-info") {
  const openId = args.includes("--open-dingtalk-id") ? args[args.indexOf("--open-dingtalk-id") + 1] : "";
  const cid = args.includes("--group") ? args[args.indexOf("--group") + 1] : "";
  const person = dmPeople.find((value) => openId ? value.id === openId : value.cid === cid);
  if (openId && !person) {
    process.stdout.write(JSON.stringify({ success: false, errorMsg: "未知的 fixture 私聊用户" }));
    process.exitCode = 9;
  } else {
    process.stdout.write(JSON.stringify({ success: true, result: { conversationInfo: {
      title: person?.name || "集成验证群", singleChat: Boolean(person), openConversationId: person?.cid || cid,
    } } }));
  }
} else if (args[0] === "contact" && args[1] === "user" && args[2] === "get-self") {
  process.stdout.write(JSON.stringify({ success: true, result: [{ isAdmin: false, orgEmployeeModel: { userId: dmPeople[1].userId } }] }));
} else if (args[0] === "contact" && args[1] === "user" && args[2] === "search") {
  const query = args[args.indexOf("--query") + 1];
  const matches = dmPeople.filter((person) => person.name === query || person.userId === query);
  process.stdout.write(JSON.stringify({ success: true, result: matches.map((person) => ({
    name: person.name, userId: person.userId, openDingTalkId: person.id,
  })) }));
} else if (args[0] === "chat" && args[1] === "group" && args[2] === "user-settings" && args[3] === "query") {
  const groupId = args[args.indexOf("--groups") + 1];
  const settings = JSON.parse(readFileSync(join(root, "group-settings.json"), "utf8"));
  process.stdout.write(JSON.stringify({ result: { settings: [{ openConversationId: groupId, success: true, notificationOff: settings[groupId] ?? 1 }] } }));
} else if (args[0] === "chat" && args[1] === "+messages-mget") {
  process.stdout.write(JSON.stringify({ messages: [{ resources: [{ contentType: "image", resourceIdType: "mediaId", resourceId: "fixture-image-resource" }] }] }));
} else if (args[0] === "chat" && args[1] === "message" && args[2] === "download-media") {
  process.stdout.write(JSON.stringify({ downloadUrl: "https://fixture.invalid/image.png" }));
} else if (args[0] === "chat" && args[1] === "+messages-send") {
  const behavior = JSON.parse(readFileSync(join(root, "relay-behavior.json"), "utf8"));
  if (behavior.relayDelayMs) await new Promise((resolveDelay) => setTimeout(resolveDelay, behavior.relayDelayMs));
  if (behavior.sendFails) {
    process.stdout.write(JSON.stringify({ success: false, errorMsg: "模拟钉钉发送失败" }));
    process.exitCode = 9;
  } else {
  if (behavior.echoDuringRelay) {
    appendFileSync(join(root, "injected-events.jsonl"), JSON.stringify({
      type: "user_im_message_receive_group_all", message_id: "msgFixtureRelayedMessage",
      conversation_id: args[args.indexOf("--group") + 1], sender: "当前用户",
      content: args[args.indexOf("--text") + 1], timestamp: Date.now(),
    }) + "\\n");
    // A live event can arrive well before --wait-delivery has produced its receipt.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 800));
  }
  process.stdout.write(JSON.stringify({ success: true, result: { messageId: "msgFixtureRelayedMessage" } }));
  }
} else if (args[0] === "chat" && args[1] === "+messages-create-text-emotion") {
  process.stdout.write(JSON.stringify({ success: true, result: { emotionId: "fixture-emotion-id" } }));
} else if (args[0] === "chat" && args[1] === "+messages-add-text-emotion") {
  const behavior = JSON.parse(readFileSync(join(root, "relay-behavior.json"), "utf8"));
  process.stdout.write(JSON.stringify(behavior.failStamp ? { success: false, errorMsg: "模拟贴表情失败" } : { success: true }));
  if (behavior.failStamp) process.exitCode = 9;
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
        const isConfirmation = envelope.method === "message.reaction.set" && envelope.payload?.text === "✌️";
        const shouldFailSend = envelope.method === "message.send" && failOnce && content.includes(failOnce) && !failed.has(failOnce);
        const shouldFail = shouldFailSend || (isConfirmation && failConfirmation);
        if (shouldFailSend) failed.add(failOnce);
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
    async emitDingTalk(event) {
      await appendFile(join(directory, "injected-events.jsonl"), JSON.stringify(event) + "\n");
      const count = (await readFile(join(directory, "injected-events.jsonl"), "utf8")).trim().split("\n").filter(Boolean).length;
      await waitFor(async () => (await readJson(join(directory, "injected-count.json"), 0)) >= count, "钉钉事件注入监听进程", diagnostics);
    },
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

const dm = (message_id, content, { outgoing = false } = {}) => ({
  type: "user_im_message_receive_o2o_all", message_id, content,
  conversation_id: dmPeer.cid,
  sender: outgoing ? dmSelf.name : dmPeer.name,
  sender_open_dingtalk_id: outgoing ? dmSelf.id : dmPeer.id,
  timestamp: 1_792_539_000_000,
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
      dm("dm", "DIRECT_MESSAGE_RETRY"),
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
  for (const marker of ["TARGET_FALLBACK", "NATIVE_DUPLICATE", "ALL_BROADCAST"]) {
    const text = app.delivered.find((item) => item.includes(marker));
    assert.ok(text.startsWith("**测试同事**："), "群消息发送人与正文显示在同一行");
    assert.doesNotMatch(text, /^>/m, "话题群消息不再渲染成引用块");
  }
  assert.ok(app.delivered.includes("DIRECT_MESSAGE_RETRY"), "私聊话题只显示原正文");
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

test("主动钉钉私聊按真实对端建话题，收发方向分明且回复只发送给对方", { timeout: 15_000 }, async (t) => {
  const app = await fixture(t, {
    events: [dm("dm-outgoing", "OUTGOING_TO_PEER", { outgoing: true })],
  });
  await waitFor(async () => Object.keys((await app.readOutbox())?.delivered || {}).length === 1, "主动私聊识别对方并投递", app.diagnostics);
  const topics = await readJson(join(app.directory, "data", "topics.json"), null);
  const record = topics.byDingTalk[dmPeer.cid];
  assert.equal(record.name, dmPeer.name, "话题用实际对端名称，不能用当前账号名称");
  assert.equal(record.openDingTalkId, dmPeer.id, "回复目标保存实际对端开放 ID");
  assert.notEqual(record.openDingTalkId, dmSelf.id);
  assert.equal(record.dingTalkConversationId, dmPeer.cid);
  assert.equal(record.identityVersion, 1);
  assert.equal(app.delivered[0], "**我**：OUTGOING_TO_PEER", "主动发出的消息明确标为我");
  assert.ok(app.requests.some((item) => item.method === "message.send" && item.payload?.target?.type === "user" && item.payload?.message?.content === dmPeer.name), "使用对方名称创建话题锚点");

  await app.emitDingTalk(dm("dm-incoming", "INCOMING_FROM_PEER"));
  await waitFor(async () => Object.keys((await app.readOutbox())?.delivered || {}).length === 2, "同一私聊收到对方消息", app.diagnostics);
  assert.equal(app.delivered[1], "INCOMING_FROM_PEER", "收到对方消息继续使用原正文");
  assert.equal(app.deliveries.every((value) => value.target.conversation_id === record.topicId), true, "同一私聊收发都进入对方同一话题");
  assert.equal(app.requests.filter((item) => item.method === "conversation.topic.create").length, 1);

  await app.emitMessage({ topicId: record.topicId, text: "OWNER_DM_REPLY", messageId: "owner-dm-reply" });
  await app.emitMessage({ topicId: record.topicId, text: "OWNER_DM_REPLY", messageId: "owner-dm-reply" });
  const relays = (await app.calls()).filter((args) => args[0] === "chat" && args[1] === "+messages-send");
  assert.equal(relays.length, 1, "同一即应回复不会重复发送");
  assert.equal(relays[0][relays[0].indexOf("--open-dingtalk-id") + 1], dmPeer.id);
  assert.equal(relays[0].includes(dmSelf.id), false, "不能把回复发送给本人");
  assert.equal(relays[0].includes("--group"), false, "私聊不能使用群聊发送参数");
  assert.equal(relays[0][relays[0].indexOf("--text") + 1], "OWNER_DM_REPLY");
  assert.equal(app.requests.filter((item) => item.method === "message.reaction.set" && item.payload?.text === "✌️").length, 1);
  assert.equal(app.deliveries.length, 2, "处理即应回复不会额外向话题复制正文");
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

test("全量群消息开启 muted_conversations 后，免打扰群普通消息也只转发一次", { timeout: 15_000 }, async (t) => {
  const app = await fixture(t, {
    push: { all_group_messages: true, muted_conversations: true },
    events: [
      group("muted-opt-in", "MUTED_OPT_IN_ORDINARY"),
      group("muted-opt-in", "MUTED_OPT_IN_ORDINARY"),
      group("open-opt-in", "OPEN_OPT_IN_ORDINARY", undefined, "fixture-open-group"),
      group("native-opt-in", "MUTED_OPT_IN_NATIVE", "user_im_message_receive_at"),
      group("all-opt-in", "@所有人 MUTED_OPT_IN_ALL"),
    ],
  });
  await waitFor(async () => {
    const outbox = await app.readOutbox();
    return app.delivered.length === 4 && Object.keys(outbox?.delivered || {}).length === 4;
  }, "开启免打扰转发后的普通消息和 @ 均完成投递", app.diagnostics);
  for (const marker of ["MUTED_OPT_IN_ORDINARY", "OPEN_OPT_IN_ORDINARY", "MUTED_OPT_IN_NATIVE", "MUTED_OPT_IN_ALL"]) {
    assert.equal(app.delivered.filter((text) => text.includes(marker)).length, 1, marker);
  }
});

test("仅提及模式下 muted_conversations 不会把普通群消息当成 @", { timeout: 15_000 }, async (t) => {
  const app = await fixture(t, {
    push: { all_group_messages: false, muted_conversations: true },
    events: [
      group("muted-mention-only-ordinary", "MUTED_MENTION_ONLY_ORDINARY"),
      group("open-mention-only-ordinary", "OPEN_MENTION_ONLY_ORDINARY", undefined, "fixture-open-group"),
      group("muted-mention-only-fallback", "MUTED_MENTION_ONLY_FALLBACK"),
      group("muted-mention-only-native", "MUTED_MENTION_ONLY_NATIVE", "user_im_message_receive_at"),
      group("muted-mention-only-all", "@所有人 MUTED_MENTION_ONLY_ALL"),
    ],
    mentions: [{ messageId: "muted-mention-only-fallback", conversationId: "fixture-muted-group" }],
  });
  await waitFor(async () => {
    const outbox = await app.readOutbox();
    return app.delivered.length === 3 && Object.keys(outbox?.delivered || {}).length === 3;
  }, "仅提及模式的三类 @ 均完成投递", app.diagnostics);
  for (const marker of ["MUTED_MENTION_ONLY_FALLBACK", "MUTED_MENTION_ONLY_NATIVE", "MUTED_MENTION_ONLY_ALL"]) {
    assert.equal(app.delivered.filter((text) => text.includes(marker)).length, 1, marker);
  }
  assert.equal(app.delivered.some((text) => text.includes("MENTION_ONLY_ORDINARY")), false, "免打扰开关不扩大仅提及模式的范围");
});

test("即应初始离线时真实进程先收取并持久化，连接恢复后自动投递", { timeout: 15_000 }, async (t) => {
  const port = await unusedPort();
  const app = await fixture(t, {
    port, initiallyOffline: true,
    events: [dm("offline-dm", "OFFLINE_PENDING")],
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
    relayDelayMs: 400,
  });
  await waitFor(async () => {
    const outbox = await app.readOutbox();
    return Object.keys(outbox?.delivered || {}).length === 1;
  }, "话题创建并送达", app.diagnostics);
  const topicId = app.deliveries[0].target.conversation_id;
  const confirmations = () => app.requests.filter((item) => item.method === "message.reaction.set" && item.payload?.text === "✌️");
  await app.emitMessage({ topicId, text: "NON_OWNER_MUST_NOT_RELAY", senderId: "another-user", messageId: "foreign-reply" });
  assert.equal((await app.calls()).filter((args) => args[1] === "+messages-send").length, 0);
  assert.equal(confirmations().length, 0, "非 owner 的消息不贴发送成功确认");
  const sending = app.emitMessage({ topicId, text: "OWNER_REPLY_DIRECT", messageId: "owner-reply" });
  await waitFor(async () => (await app.calls()).some((args) => args[1] === "+messages-send"), "钉钉开始发送回复", app.diagnostics);
  assert.equal(confirmations().length, 0, "钉钉尚未返回成功回执时不提前确认");
  await sending;
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
  assert.equal(confirmations().length, 1, "owner 同一回复在即应只确认一次");
  assert.deepEqual(confirmations()[0].payload, {
    conversation_id: topicId, message_id: "owner-reply", text: "✌️", reacted: true,
  }, "确认贴在 owner 的原话题原消息上");
});

test("钉钉发送失败不贴即应成功确认，并向 owner 说明失败", { timeout: 15_000 }, async (t) => {
  const app = await fixture(t, {
    events: [group("failed-reply-source", "CREATE_FAILED_REPLY_TOPIC", "user_im_message_receive_at")],
    sendFails: true,
  });
  await waitFor(async () => Object.keys((await app.readOutbox())?.delivered || {}).length === 1, "失败回复测试的话题已创建", app.diagnostics);
  const topicId = app.deliveries[0].target.conversation_id;
  await app.emitMessage({ topicId, text: "OWNER_REPLY_SEND_FAILS", messageId: "failed-owner-reply" });
  const calls = await app.calls();
  assert.equal(calls.filter((args) => args[1] === "+messages-send").length, 1, "本次回复只尝试发送一次");
  assert.equal(calls.filter((args) => args[1] === "+messages-add-text-emotion").length, 0, "失败发送不能贴钉钉成功标记");
  assert.equal(app.requests.filter((item) => item.method === "message.reaction.set" && item.payload?.text === "✌️").length, 0);
  assert.equal(app.delivered.filter((text) => text.includes("转发到钉钉失败")).length, 1, "向 owner 返回一次发送失败说明");
});

test("即应成功确认失败不影响已送达的回复，也不提示转发失败或重发", { timeout: 15_000 }, async (t) => {
  const app = await fixture(t, {
    events: [group("confirmation-fail-source", "CREATE_CONFIRMATION_FAIL_TOPIC", "user_im_message_receive_at")],
    failConfirmation: true,
  });
  await waitFor(async () => Object.keys((await app.readOutbox())?.delivered || {}).length === 1, "确认失败测试的话题已创建", app.diagnostics);
  const topicId = app.deliveries[0].target.conversation_id;
  await app.emitMessage({ topicId, text: "OWNER_REPLY_CONFIRMATION_FAILS", messageId: "confirmation-failed-owner-reply" });
  await app.emitMessage({ topicId, text: "OWNER_REPLY_CONFIRMATION_FAILS", messageId: "confirmation-failed-owner-reply" });
  const calls = await app.calls();
  assert.equal(calls.filter((args) => args[1] === "+messages-send").length, 1, "确认失败不会让已送达回复重发");
  assert.equal(calls.filter((args) => args[1] === "+messages-add-text-emotion").length, 1);
  assert.equal(app.requests.filter((item) => item.method === "message.reaction.set" && item.payload?.text === "✌️").length, 1, "只尝试确认原回复一次");
  assert.equal(app.delivered.some((text) => text.includes("转发到钉钉失败")), false, "成功送达后的确认失败不冒充发送失败");
});

test("owner 在话题的回复发到钉钉后，同一出站消息的群事件不再次引用回即应", { timeout: 15_000 }, async (t) => {
  const app = await fixture(t, {
    events: [group("reply-source", "CREATE_OPEN_GROUP_REPLY_TOPIC", undefined, "fixture-open-group")],
  });
  await waitFor(async () => {
    const outbox = await app.readOutbox();
    return Object.keys(outbox?.delivered || {}).length === 1;
  }, "非免打扰群的话题创建并送达", app.diagnostics);
  const topicId = app.deliveries[0].target.conversation_id;
  await app.emitMessage({ topicId, text: "OWNER_REPLY_MUST_NOT_ECHO", messageId: "owner-reply-no-echo" });
  assert.equal((await app.calls()).filter((args) => args[1] === "+messages-send").length, 1);

  // This is the sender's own DingTalk event for the receipt returned by the
  // outbound CLI. It has a different ID from the owner's MagicChat message.
  await app.emitDingTalk({
    ...group("msgFixtureRelayedMessage", "OWNER_REPLY_MUST_NOT_ECHO", undefined, "fixture-open-group"),
    sender: "当前用户",
  });
  // The real process debounces group events for 250 ms before deciding whether
  // to forward them. Allow that path to finish before checking the topic.
  await pause(1200);
  assert.equal(app.delivered.some((text) => text.includes("OWNER_REPLY_MUST_NOT_ECHO")), false, "owner 已发送的内容不应又以机器人引用显示");
  assert.equal(app.deliveries.length, 1, "只有同事发来的初始消息进入话题");
});

test("出站群事件早于发送回执且贴表情失败时，仍排除回流并保留同事同文消息", { timeout: 15_000 }, async (t) => {
  const app = await fixture(t, {
    events: [group("early-reply-source", "CREATE_EARLY_REPLY_TOPIC", undefined, "fixture-open-group")],
    echoDuringRelay: true,
    failStamp: true,
  });
  await waitFor(async () => {
    const outbox = await app.readOutbox();
    return Object.keys(outbox?.delivered || {}).length === 1;
  }, "话题创建并送达", app.diagnostics);
  const topicId = app.deliveries[0].target.conversation_id;
  await app.emitMessage({ topicId, text: "EARLY_OWNER_REPLY", messageId: "early-owner-reply" });
  await pause(600);
  assert.equal(app.delivered.some((text) => text.includes("EARLY_OWNER_REPLY")), false, "等待发送回执期间收到的出站消息也不能回流");
  assert.equal((await app.calls()).filter((args) => args[1] === "+messages-send").length, 1, "贴表情失败不会导致重发");
  assert.equal(app.delivered.some((text) => text.includes("转发到钉钉失败")), false, "发送成功后的贴表情失败不提示转发失败");

  await app.emitDingTalk(group("colleague-same-text", "EARLY_OWNER_REPLY", undefined, "fixture-open-group"));
  await waitFor(() => app.delivered.some((text) => text.includes("EARLY_OWNER_REPLY")), "同事相同文本的不同消息正常转发", app.diagnostics);
  assert.equal(app.delivered.filter((text) => text.includes("EARLY_OWNER_REPLY")).length, 1, "不能按文本过滤别人的独立消息");
});
