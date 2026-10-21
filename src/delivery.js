import { runDws } from "./dws.js";
import { downloadImageUrl, extractMediaIds, imageResourceIds, isImageContent, textWithoutImages } from "./media.js";
import { formatTopicPush, messageBody, splitText } from "./push.js";
import { creationText, idsFromSend, topicFor, topicIdFromCreate } from "./topics.js";

/** Route durable notification parts into one topic per DingTalk conversation. */
export function createNotificationDelivery({ chat, userId, topics, saveTopics, resolveName }) {
  const locks = new Map();
  let storage = Promise.resolve();
  const userTarget = { type: "user", user_id: userId };

  async function sendText(text, target = userTarget) {
    let last;
    for (const content of splitText(text)) {
      last = await chat.request("message.send", { target, message: { type: "markdown", content } });
    }
    return last;
  }

  function remember(conversationId, record) {
    const operation = storage.then(async () => {
      const draft = structuredClone(topics);
      draft.byDingTalk[conversationId] = record;
      if (record.sourceConversationId) draft.parentConversationId = record.sourceConversationId;
      await saveTopics(draft);
      topics.parentConversationId = draft.parentConversationId;
      topics.byDingTalk = draft.byDingTalk;
      return record;
    });
    storage = operation.catch(() => {});
    return operation;
  }

  async function createTopic(event, reason) {
    const conversationId = event.conversation_id;
    let record = topicFor(topics, conversationId);
    if (record?.topicId) return record;
    if (!record?.sourceConversationId || !record?.sourceMessageId) {
      const name = await resolveName(event, reason);
      const ids = idsFromSend(await sendText(creationText(name)));
      if (!ids.conversationId || !ids.messageId) throw new Error("创建话题失败：源头消息没有返回会话或消息 ID");
      record = await remember(conversationId, {
        name,
        kind: reason === "dm" ? "dm" : "group",
        openDingTalkId: event.sender_open_dingtalk_id || "",
        dingTalkConversationId: conversationId,
        sourceConversationId: ids.conversationId,
        sourceMessageId: ids.messageId,
      });
    }
    const created = await chat.request("conversation.topic.create", {
      conversation_id: record.sourceConversationId,
      source_message_id: record.sourceMessageId,
    });
    const topicId = topicIdFromCreate(created);
    if (!topicId) throw new Error("创建话题失败：没有返回话题 ID");
    return remember(conversationId, { ...record, topicId });
  }

  async function targetFor(event, reason) {
    if (!event.conversation_id) return userTarget;
    const existing = topicFor(topics, event.conversation_id);
    if (existing?.topicId) return { type: "topic", conversation_id: existing.topicId };
    const key = event.conversation_id;
    const previous = locks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => createTopic(event, reason));
    locks.set(key, current);
    try {
      const record = await current;
      return { type: "topic", conversation_id: record.topicId };
    } finally {
      if (locks.get(key) === current) locks.delete(key);
    }
  }

  async function render(event, reason) {
    const body = messageBody(event);
    if (!isImageContent(`${event.content || ""}\n${event.text || ""}`)) return splitText(formatTopicPush(event, reason));
    let ids = [];
    if (event.message_id) {
      try {
        const detail = await runDws(["chat", "+messages-mget", "--msg-ids", event.message_id, "--no-reactions", "--no-threads"]);
        ids = imageResourceIds(detail.data);
      } catch (error) {
        console.error("读取图片资源失败，将尝试消息中的资源 ID：", error.message);
      }
    }
    if (!ids.length) ids = extractMediaIds(body);
    if (!ids.length) throw new Error("图片消息缺少可用的资源 ID，将重试读取");
    const text = textWithoutImages(body);
    const caption = reason === "dm" ? "" : `> **${event.sender || "未知发送人"}**：`;
    const parts = text ? splitText(reason === "dm" ? text : `${caption}\n\n${text}`) : [];
    // Persist the resource reference, since a downloaded URL can expire while
    // offline. Each send attempt obtains a fresh URL and records its progress.
    for (const mediaId of ids) parts.push({ type: "image", mediaId, caption: text ? "" : caption });
    return parts;
  }

  async function send(part, { event, reason }) {
    const target = await targetFor(event, reason);
    if (typeof part === "string") {
      return chat.request("message.send", { target, message: { type: "markdown", content: part } });
    }
    if (part?.type !== "image" || !part.mediaId) throw new Error("无法发送的通知分块");
    const url = await downloadImageUrl({ messageId: event.message_id, conversationId: event.conversation_id, mediaId: part.mediaId });
    const message = { type: "image", content: url };
    if (part.caption) {
      message.caption = part.caption;
      message.caption_type = "markdown";
    }
    return chat.request("message.send", { target, message });
  }

  return { render, send, sendText, sendToTopic: (topicId, text) => sendText(text, { type: "topic", conversation_id: topicId }) };
}
