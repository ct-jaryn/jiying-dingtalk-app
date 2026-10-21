import { runDws } from "./dws.js";
import { loadJson, saveJson } from "./store.js";

const LABEL = "使用即应发送";
const BACKGROUND_ID = "im_bg_5";

let emotionId = "";

export function sentMessageRef(payload, fallbackConversationId = "") {
  const ref = findSentRef(payload);
  return {
    messageId: ref?.messageId || "",
    conversationId: ref?.conversationId || fallbackConversationId,
  };
}

export async function stampSentMessage(payload, { conversationId = "", emotionPath }) {
  const ref = sentMessageRef(payload, conversationId);
  if (!ref.messageId || !ref.conversationId) {
    console.error("发出的消息没有返回消息 ID，无法贴表情");
    return;
  }
  const id = await ensureEmotion(emotionPath);
  await runDws([
    "chat", "+messages-add-text-emotion",
    "--conversation-id", ref.conversationId,
    "--msg-id", ref.messageId,
    "--emotion-id", id,
    "--emotion-name", LABEL,
    "--text", LABEL,
    "--background-id", BACKGROUND_ID,
  ]);
}

async function ensureEmotion(emotionPath) {
  if (emotionId) return emotionId;
  const saved = await loadJson(emotionPath, {});
  if (saved.emotionId) {
    emotionId = saved.emotionId;
    return emotionId;
  }
  const created = await runDws([
    "chat", "+messages-create-text-emotion",
    "--emotion-name", LABEL,
    "--text", LABEL,
    "--background-id", BACKGROUND_ID,
  ]);
  emotionId = findEmotionId(created.data);
  if (!emotionId) throw new Error("创建文字表情没有返回 emotionId");
  await saveJson(emotionPath, { emotionId, text: LABEL });
  return emotionId;
}

export function findEmotionId(payload) {
  const found = [];
  collect(payload, found);
  return found[0] || "";
}

function collect(value, found) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && /emotion[_-]?id/i.test(key) && child) found.push(child);
    else collect(child, found);
  }
}

function findSentRef(value, inheritedConversationId = "") {
  if (!value || typeof value !== "object") return null;
  const messageId = ownMessageId(value);
  const conversationId = ownConversationId(value) || inheritedConversationId;
  // The CLI's standard receipt takes precedence over its lower-level payload.
  if (messageId) {
    return { messageId, conversationId: conversationId || findConversationId(value, messageId) };
  }
  for (const child of receiptChildren(value)) {
    const ref = findSentRef(child, conversationId);
    if (ref) return ref;
  }
  return null;
}

function findConversationId(value, messageId) {
  if (!value || typeof value !== "object") return "";
  // Do not pair a sent message with another message's conversation.
  const otherMessageId = ownMessageId(value);
  if (otherMessageId && otherMessageId !== messageId) return "";
  const own = ownConversationId(value);
  if (own) return own;
  for (const child of receiptChildren(value)) {
    const id = findConversationId(child, messageId);
    if (id) return id;
  }
  return "";
}

function ownMessageId(value) {
  return ownId(value, ["messageId", "openMessageId", "msgId"], "msg");
}

function ownConversationId(value) {
  return ownId(value, ["conversationId", "openConversationId"], "cid");
}

function ownId(value, names, prefix) {
  for (const name of names) {
    for (const [key, id] of Object.entries(value)) {
      if (key.toLowerCase() === name.toLowerCase() && typeof id === "string" && id.startsWith(prefix)) return id;
    }
  }
  return "";
}

function receiptChildren(value) {
  const priority = ["delivery", "receipt", "message", "result", "data"];
  return Object.entries(value)
    // This context identifies the quoted source, never the message just sent.
    .filter(([key, child]) => !/^referenced[_-]?messages?$/i.test(key) && child && typeof child === "object")
    .sort(([left], [right]) => {
      const rank = (key) => {
        const index = priority.indexOf(key.toLowerCase());
        return index < 0 ? priority.length : index;
      };
      return rank(left) - rank(right);
    })
    .map(([, child]) => child);
}
