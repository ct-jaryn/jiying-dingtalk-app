import { runDws } from "./dws.js";
import { loadJson, saveJson } from "./store.js";

const LABEL = "使用即应发送";
const BACKGROUND_ID = "im_bg_5";

let emotionId = "";

export function sentMessageRef(payload, fallbackConversationId = "") {
  const ref = { messageId: "", conversationId: fallbackConversationId };
  walk(payload, ref);
  return ref;
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

function walk(value, ref) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string") {
      if (!ref.messageId && /^(messageId|openMessageId|msgId)$/i.test(key) && child.startsWith("msg")) ref.messageId = child;
      if (/^(conversationId|openConversationId)$/i.test(key) && child.startsWith("cid")) ref.conversationId = child;
    } else walk(child, ref);
  }
}
