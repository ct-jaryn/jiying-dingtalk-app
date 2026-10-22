import { runDws } from "./dws.js";
import { downloadImageUrl, extractMediaIds, imageResourceIds, isImageContent, textWithoutImages } from "./media.js";
import { formatTopicPush, formatTopicSender, messageBody, splitText } from "./push.js";
import { creationText, idsFromSend, topicFor, topicIdFromCreate } from "./topics.js";

/** Route durable notification parts into one topic per DingTalk conversation. */
export function createNotificationDelivery({ chat, userId, topics, saveTopics, resolveName, resolveDm = async (event) => event, resolveDmRecord }) {
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

  async function syncDm(event) {
    const conversationId = event.conversation_id;
    const existing = topicFor(topics, conversationId);
    const peerId = event.dm_peer_open_dingtalk_id;
    if (!peerId) throw new Error("尚未确认私聊对象，保留消息后重试");
    if (!existing) return null;
    const name = event.dm_peer_name || existing.name || "私聊";
    const changed = existing.openDingTalkId !== peerId || existing.name !== name;
    let record = existing;
    if (changed || existing.identityVersion !== 1) {
      record = await remember(conversationId, {
        ...existing, kind: "dm", name, openDingTalkId: peerId, identityVersion: 1,
        identityNoticePending: existing.identityNoticePending || Boolean(changed && existing.topicId),
      });
    }
    if (record.identityNoticePending && record.topicId) {
      try {
        await sendText(`此话题已校正为与 **${name}** 的钉钉私聊，后续回复会发送给该联系人。旧话题标题暂无法自动修改。`, { type: "topic", conversation_id: record.topicId });
        record = await remember(conversationId, { ...record, identityNoticePending: false });
      } catch (error) {
        console.error("发送私聊校正说明失败，后续重试：", error.message);
      }
    }
    return record;
  }

  async function repairDm(record) {
    if (record.kind !== "dm") return record;
    if (!resolveDmRecord) throw new Error("尚未确认私聊对象，暂不能转发回复");
    const event = await resolveDmRecord(record);
    return withConversation(event.conversation_id, () => syncDm(event));
  }

  async function createTopic(event, reason) {
    const conversationId = event.conversation_id;
    let record = reason === "dm" ? await syncDm(event) : topicFor(topics, conversationId);
    if (record?.topicId) return record;
    if (!record?.sourceConversationId || !record?.sourceMessageId) {
      const name = await resolveName(event, reason);
      const ids = idsFromSend(await sendText(creationText(name)));
      if (!ids.conversationId || !ids.messageId) throw new Error("创建话题失败：源头消息没有返回会话或消息 ID");
      record = await remember(conversationId, {
        name,
        kind: reason === "dm" ? "dm" : "group",
        openDingTalkId: reason === "dm" ? event.dm_peer_open_dingtalk_id : event.sender_open_dingtalk_id || "",
        ...(reason === "dm" ? { identityVersion: 1 } : {}),
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
    if (existing?.topicId && reason !== "dm") return { type: "topic", conversation_id: existing.topicId };
    const record = await withConversation(event.conversation_id, () => createTopic(event, reason));
    return { type: "topic", conversation_id: record.topicId };
  }

  async function withConversation(key, operation) {
    const previous = locks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    locks.set(key, current);
    try {
      return await current;
    } finally {
      if (locks.get(key) === current) locks.delete(key);
    }
  }

  async function render(event, reason) {
    if (reason === "dm") event = await resolveDm(event);
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
    const caption = reason === "dm" ? (event.dm_direction === "outgoing" ? "**我**：" : "") : formatTopicSender(event);
    const parts = text ? splitText(`${caption}${text}`) : [];
    // Persist the resource reference, since a downloaded URL can expire while
    // offline. Each send attempt obtains a fresh URL and records its progress.
    for (const mediaId of ids) parts.push({ type: "image", mediaId, caption: text ? "" : caption });
    return parts;
  }

  async function send(part, { event, reason }) {
    if (reason === "dm") event = await resolveDm(event);
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

  return { render, send, sendText, repairDm, sendToTopic: (topicId, text) => sendText(text, { type: "topic", conversation_id: topicId }) };
}
