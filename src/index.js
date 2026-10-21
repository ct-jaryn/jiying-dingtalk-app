import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "./agent.js";
import { loadConfig } from "./config.js";
import { runDws, startEventStream } from "./dws.js";
import { createPushForwarder } from "./forwarder.js";
import { MagicChat, startStatus } from "./magicchat.js";
import { createMentionLookup } from "./mention-source.js";
import { createMentionResolver } from "./mentions.js";
import { classify, conversationNameFrom, formatPush, isAtAll, normalizeEvent, pushIndexLine, splitText, wasDeliveredInLegacyHistory } from "./push.js";
import { appendVisible, rememberPush } from "./session.js";
import { flushWrites, loadJson, saveJson } from "./store.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sessionPath = resolve(root, "data/session.json");
const pushPath = resolve(root, "data/pushes.json");
const seenPath = resolve(root, "data/seen.json");
const outboxPath = resolve(root, "data/push-outbox.json");
const mentionPath = resolve(root, "data/pending-mentions.json");

let config;
let chat;
let session;
let pushes;
let seen;
let forwarder;
let mentions;
let stopped = false;
let connecting = false;
let stream;
let listenTimer;
let restartDelay = 1000;
const names = new Map();
const nameRequests = new Map();
const eventTasks = new Set();
let inbound = Promise.resolve();

async function main() {
  config = await loadConfig(resolve(root, "config.yaml"));
  session = await loadJson(sessionPath, { summary: "", messages: [] });
  pushes = await loadJson(pushPath, []);
  seen = await loadJson(seenPath, {});
  const outbox = await loadJson(outboxPath, { pending: [], delivered: {} });
  const pendingMentions = await loadJson(mentionPath, { pending: [] });
  chat = new MagicChat({
    url: config.magicchat.ws_url,
    appId: config.magicchat.app_id,
    secret: config.magicchat.app_secret,
  });
  forwarder = createPushForwarder({
    state: outbox,
    saveState: (state) => saveJson(outboxPath, state),
    render: (event, reason) => splitText(formatPush(event, reason, event.conversation_name || names.get(event.conversation_id) || event.conversation_id || "")),
    send: (content) => sendChunk(content),
    onDelivered: async (event, reason) => {
      console.log("[通知已送达] reason=" + reason + " message=" + event.message_id + " group=" + (event.conversation_id || ""));
      pushes = rememberPush(pushes, pushIndexLine(event, reason, event.conversation_name || names.get(event.conversation_id) || ""));
      await saveJson(pushPath, pushes);
    },
    onLog: logIssue,
  });
  const fetchMentions = createMentionLookup({
    queryPage: async ({ groupId, days, cursor }) => {
      const result = await runDws([
        "chat", "+at-me", "--days", String(days), "--group", groupId,
        "--limit", "100", "--cursor", String(cursor || "0"), "--no-reactions",
      ], { timeoutMs: 20_000 });
      const payload = result.data;
      if (Array.isArray(payload?.items) || Array.isArray(payload?.messages)) return payload;
      if (Array.isArray(payload?.result?.items) || Array.isArray(payload?.result?.messages)) return payload.result;
      throw new Error("@消息查询没有返回可识别的消息列表");
    },
  });
  mentions = createMentionResolver({
    state: pendingMentions,
    saveState: (state) => saveJson(mentionPath, state),
    fetchMentions,
    onMention: async (event, match) => {
      const name = match.conversation?.name || match.conversation?.title || match.conversationName || "";
      if (name) names.set(event.conversation_id, name);
      const enriched = { ...event, conversation_name: name || event.conversation_name || "" };
      if (!enriched.content && match.text) enriched.content = match.text;
      console.log("[群聊@已确认] message=" + enriched.message_id + " group=" + enriched.conversation_id);
      await forwarder.enqueue(enriched, isAtAll(enriched) ? "at-all" : "mention");
    },
    onLog: logIssue,
  });
  chat.onEvent = (envelope) => {
    inbound = inbound.then(() => handleInbound(envelope)).catch((error) => console.error(error));
    return inbound;
  };
  chat.onClose = () => {
    if (!stopped && !connecting) {
      console.log("即应连接断开，待发通知已保留。");
      connectForever().catch((error) => console.error(error));
    }
  };
  // Receive and persist DingTalk events even while the destination is offline.
  listen(0);
  await mentions.wake();
  await connectForever();
}

async function connectForever() {
  if (connecting) return;
  connecting = true;
  let delay = 1000;
  try {
    while (!stopped) {
      try {
        await chat.connect();
        console.log("即应已连接。");
        forwarder.wake();
        return;
      } catch (error) {
        if (stopped) return;
        console.error("连接即应失败：" + error.message);
        await sleep(delay);
        delay = Math.min(delay * 2, 30_000);
      }
    }
  } finally {
    connecting = false;
  }
}

async function handleInbound(envelope) {
  if (envelope.event === "conversation.status") return;
  try {
    if (envelope.event === "message.created") await handleUserMessage(envelope.payload);
  } finally {
    if (envelope.cursor) await chat.request("events.ack", { cursor: envelope.cursor }).catch(() => {});
  }
}

async function handleUserMessage(payload) {
  const conversation = payload?.conversation;
  const sender = payload?.sender;
  if (!conversation || conversation.type !== "app" || conversation.parent) return;
  if (sender?.id !== config.magicchat.user_id) return;
  const messageId = payload.message?.id;
  if (messageId && seen[messageId]) return;
  if (messageId) {
    seen[messageId] = Date.now();
    await saveJson(seenPath, seen);
  }
  chat.request("message.reaction.set", {
    conversation_id: conversation.id,
    message_id: messageId,
    text: "👀",
    reacted: true,
  }).catch((error) => console.error("贴表情失败：", error.message));

  const status = startStatus(chat, conversation.id);
  const instruction = payload.message?.body?.content || payload.message?.summary || "（收到一条没有文本的消息）";
  try {
    const reply = await runAgent({
      config,
      session,
      pushIndex: pushes,
      instruction: String(instruction),
      status,
    });
    await sendText(reply);
    appendVisible(session, "user", String(instruction));
    appendVisible(session, "assistant", reply);
    await saveJson(sessionPath, session);
  } catch (error) {
    console.error(error);
    await saveJson(sessionPath, session).catch(() => {});
    await sendText("处理失败：" + error.message).catch(() => {});
  } finally {
    status.stop();
  }
}

async function handleDingTalk(raw) {
  const event = normalizeEvent(raw);
  const id = event.message_id || event.event_id;
  if (!id || wasDeliveredInLegacyHistory(event, seen, pushes)) return;
  if (event.conversation_name) names.set(event.conversation_id, event.conversation_name);
  const reason = classify(event);
  if (reason) {
    console.log("[通知已入队] reason=" + reason + " message=" + id);
    await forwarder.enqueue(event, reason);
    if (reason !== "dm") warmConversationName(event.conversation_id);
    return;
  }
  if (event.type === "user_im_message_receive_group_all") {
    console.log("[群消息已接收] message=" + id + " group=" + event.conversation_id);
    await mentions.enqueue(event);
  }
}

function warmConversationName(groupId) {
  if (!groupId || names.has(groupId) || nameRequests.has(groupId)) return;
  const task = runDws(["chat", "+conversation-info", "--group", groupId], { timeoutMs: 8000 })
    .then((result) => {
      const name = conversationNameFrom(result.data);
      if (name) names.set(groupId, name);
    })
    .catch((error) => console.error("查询群名失败：", error.message))
    .finally(() => nameRequests.delete(groupId));
  nameRequests.set(groupId, task);
}

async function sendChunk(content) {
  await chat.request("message.send", {
    target: { type: "user", user_id: config.magicchat.user_id },
    message: { type: "markdown", content },
  });
}

async function sendText(text) {
  for (const content of splitText(text)) await sendChunk(content);
}

function listen(delay) {
  listenTimer = setTimeout(() => {
    if (stopped) return;
    stream = startEventStream({
      onReady: () => {
        restartDelay = 1000;
        console.log("钉钉实时监听已就绪：私聊、群聊@我、@所有人。");
      },
      onEvent: (event) => {
        const task = handleDingTalk(event).catch((error) => console.error("接收钉钉通知失败：", error.message));
        eventTasks.add(task);
        task.finally(() => eventTasks.delete(task));
        return task;
      },
      onError: (error) => console.error("钉钉监听错误：", error.message),
      onExit: (code, signal) => {
        if (stopped) return;
        console.error("钉钉监听退出 code=" + code + " signal=" + (signal || "") + "，稍后重连。");
        const delay = restartDelay;
        restartDelay = Math.min(restartDelay * 2, 30_000);
        listen(delay);
      },
    });
  }, delay);
}

function logIssue(message, error) {
  console.error(message + (error?.message ? "：" + error.message : ""));
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function shutdown() {
  if (stopped) return;
  stopped = true;
  clearTimeout(listenTimer);
  stream?.kill("SIGTERM");
  if (stream && stream.exitCode === null) {
    await Promise.race([new Promise((resolveClose) => stream.once("close", resolveClose)), sleep(3000)]);
  }
  await Promise.allSettled([...eventTasks]);
  mentions?.stop();
  forwarder?.stop();
  chat?.close();
  await Promise.race([
    Promise.allSettled([mentions?.waitForIdle(), forwarder?.waitForIdle(), flushWrites()]),
    sleep(3000),
  ]);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
