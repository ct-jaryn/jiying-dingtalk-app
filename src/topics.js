export function creationText(name) {
  return name;
}

export function emptyTopics() {
  return { parentConversationId: "", byDingTalk: {} };
}

export function topicFor(store, dingTalkConversationId) {
  return store?.byDingTalk?.[dingTalkConversationId] || null;
}

export function rememberTopic(store, dingTalkConversationId, record) {
  store.byDingTalk[dingTalkConversationId] = record;
  return record;
}

export function findByTopicId(store, topicId) {
  return Object.values(store?.byDingTalk || {}).find((item) => item.topicId === topicId) || null;
}

export function idsFromSend(payload) {
  const conversation = payload?.conversation || payload?.result?.conversation;
  const message = payload?.message || payload?.result?.message;
  return {
    conversationId: conversation?.id || payload?.conversation_id || "",
    messageId: message?.id || payload?.message_id || "",
  };
}

export function topicIdFromCreate(payload) {
  return payload?.conversation?.id
    || payload?.result?.conversation?.id
    || payload?.conversation_id
    || "";
}
