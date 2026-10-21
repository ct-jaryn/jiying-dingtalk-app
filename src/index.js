import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "./agent.js";
import { loadConfig } from "./config.js";
import { runDws, startEventStream } from "./dws.js";
import { MagicChat, startStatus } from "./magicchat.js";
import { classify, formatPush, mutedForConversation, pushIndexLine } from "./push.js";
import { appendVisible, rememberPush } from "./session.js";
import { loadJson, saveJson } from "./store.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sessionPath = resolve(root, "data/session.json");
const pushPath = resolve(root, "data/pushes.json");
const seenPath = resolve(root, "data/seen.json");

let config;
let chat;
let session;
let pushes;
let seen;
let stopped = false;
let connecting = false;
let stream;
const muteCache = new Map();
let inbound = Promise.resolve();

async function main() {
  config = await loadConfig(resolve(root, "config.yaml"));
  session = await loadJson(sessionPath, { summary: "", messages: [] });
  pushes = await loadJson(pushPath, []);
  seen = await loadJson(seenPath, {});
  chat = new MagicChat(config.magicchat);
  chat.onEvent = (envelope) => {
    inbound = inbound.then(() => handleInbound(envelope)).catch((error) => console.error(error));
    return inbound;
  };
  chat.onClose = () => {
    if (!stopped && !connecting) connectForever().catch((error) => console.error(error));
  };
  await connectForever();
  console.log("即应已连接。");
  listen(0);
}

async function connectForever() {
  if (connecting) return;
  connecting = true;
  let delay = 1000;
  try {
    for (;;) {
      try {
        await chat.connect();
        return;
      } catch (error) {
        if (stopped) return;
        console.error(`连接即应失败：${error.message}`);
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
    await sendText(`处理失败：${error.message}`).catch(() => {});
  } finally {
    status.stop();
  }
}

async function handleDingTalk(event) {
  const reason = classify(event);
  if (!reason) return;
  const id = event.message_id || event.event_id;
  if (!id || seen[id]) return;
  if (reason !== "dm" && await isMuted(event.conversation_id)) return;
  seen[id] = Date.now();
  await saveJson(seenPath, seen);
  const name = reason === "dm" ? "" : await conversationName(event.conversation_id);
  const text = formatPush(event, reason, name);
  await sendText(text);
  pushes = rememberPush(pushes, pushIndexLine(event, reason, name));
  await saveJson(pushPath, pushes);
}

async function isMuted(conversationId) {
  if (!conversationId) return true;
  const cached = muteCache.get(conversationId);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.muted;
  try {
    const result = await runDws(["chat", "group", "user-settings", "query", "--groups", conversationId]);
    const muted = mutedForConversation(result.data, conversationId);
    const value = muted == null ? true : muted;
    muteCache.set(conversationId, { muted: value, at: Date.now() });
    return value;
  } catch (error) {
    console.error("查询免打扰失败，群消息不推送：", error.message);
    return true;
  }
}

async function conversationName(conversationId) {
  if (!conversationId) return "";
  try {
    const result = await runDws(["chat", "+conversation-info", "--group", conversationId], { timeoutMs: 12_000 });
    return result.data?.name || result.data?.title || result.data?.conversation?.name || "";
  } catch {
    return "";
  }
}

async function sendText(text) {
  const chunks = splitText(text, 3500);
  for (const content of chunks) {
    await chat.request("message.send", {
      target: { type: "user", user_id: config.magicchat.user_id },
      message: { type: "markdown", content },
    });
  }
}

function splitText(text, size) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks.length ? chunks : ["（空消息）"];
}

function listen(delay) {
  setTimeout(() => {
    if (stopped) return;
    stream = startEventStream({
      onReady: () => console.log("钉钉事件订阅已就绪。"),
      onEvent: (event) => {
        handleDingTalk(event).catch((error) => console.error("推送失败：", error.message));
      },
      onExit: (code, signal) => {
        if (stopped) return;
        console.error(`钉钉监听退出 code=${code} signal=${signal || ""}`);
        listen(3000);
      },
    });
  }, delay);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function shutdown() {
  stopped = true;
  stream?.kill("SIGTERM");
  chat?.close();
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
