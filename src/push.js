const REASONS = { dm: "私聊", mention: "@我", "at-all": "@所有人" };

export function normalizeEvent(input) {
  let payload = input;
  if (input?.event_type && input.data != null) {
    try {
      const data = typeof input.data === "string" ? JSON.parse(input.data) : input.data;
      if (data && typeof data === "object" && !Array.isArray(data)) payload = { ...input, ...data };
    } catch { /* Leave malformed envelopes for the normal validation path. */ }
  }
  const event = payload && typeof payload === "object" ? payload : {};
  const sender = event.sender;
  const body = typeof event.content === "object" && event.content !== null
    ? event.content.text || event.content.content || event.text
    : event.content || event.text;
  return {
    ...event,
    type: String(event.type || "").startsWith("user_im_") ? event.type : event.event_type || event.type || "",
    message_id: clean(event.message_id || event.messageId || event.openMessageId),
    event_id: clean(event.event_id || event.eventId),
    conversation_id: clean(event.conversation_id || event.conversationId || event.openConversationId || event.conversation?.openConversationId || event.conversation?.id),
    conversation_name: clean(event.conversation_name || event.conversationName || event.conversation?.name || event.conversation?.title),
    sender: clean(sender && typeof sender === "object" ? sender.name || sender.displayName || sender.userName || sender.id : sender),
    sender_open_dingtalk_id: clean(event.sender_open_dingtalk_id || event.senderOpenDingtalkId || (sender && typeof sender === "object" ? sender.openDingTalkId || sender.open_dingtalk_id : "")),
    content: clean(body),
    event_time: event.event_time || event.create_time || event.createTime || event.timestamp || event.time,
  };
}

export function classify(event) {
  const type = String(event?.type || event?.event_type || "");
  if (type === "user_im_message_receive_o2o_all") return "dm";
  // This subscription is already scoped to the logged-in DingTalk user.
  if (type === "user_im_message_receive_at") return isAtAll(event) ? "at-all" : "mention";
  if (type === "user_im_message_receive_group_all" && isAtAll(event)) return "at-all";
  // Other group messages require an exact message-ID match from +at-me.
  return null;
}

export function wasDeliveredInLegacyHistory(event, seen, pushes) {
  const id = event.message_id || event.event_id;
  if (!id || !seen?.[id]) return false;
  // Older releases wrote seen before sending. Only a successful push index is
  // evidence of delivery; a seen-only record must be allowed to retry.
  return pushes.some((line) => String(line).split(/\s+/).includes(String(id)));
}

export function isAtAll(event) {
  const content = `${clean(event?.content)}\n${clean(event?.text)}`;
  if (content.includes("@所有人") || content.includes("@全体")) return true;
  if (/(^|[\s\u00a0\u2005\u200b])@all\b/i.test(content)) return true;
  const markers = ["atAll", "at_all", "isAtAll", "is_at_all"];
  return [event, event?.extension, event?.metadata].some((value) => value && markers.some((key) => value[key] === true));
}

export function conversationTitle(payload) {
  const candidates = [payload?.result?.conversationInfo, payload?.conversationInfo,
    payload?.result?.conversation, payload?.conversation, payload?.result, payload];
  for (const value of candidates) {
    const name = [value?.title, value?.name, value?.conversationTitle, value?.group_name]
      .map(clean).find(Boolean);
    if (name) return name;
  }
  return "";
}

export function mutedForConversation(payload, conversationId) {
  const settings = payload?.result?.settings || payload?.settings || [];
  const row = settings.find((item) => item.openConversationId === conversationId);
  if (!row || row.success === false || row.notificationOff == null) return null;
  return Number(row.notificationOff) === 1;
}

export function conversationNameFrom(payload) {
  return conversationTitle(payload);
}

export function formatPush(event, reason, conversationName = "", options = {}) {
  if (options.topic === true) return formatTopicPush(event, reason);
  if (options.topic === false) return formatMainPush(event, reason, conversationName);
  const sender = clean(event?.sender) || "未知发送人";
  const where = conversationName ? "在 " + conversationName : "";
  const body = messageBody(event);
  return [
    "**钉钉通知 · " + (REASONS[reason] || "相关消息") + "**",
    "**" + sender + "**" + (where ? " " + where : ""),
    formatTime(event?.create_time || event?.event_time || event?.timestamp),
    "",
    body,
  ].filter((line, index) => line !== "" || index > 2).join("\n");
}

export function messageBody(event) {
  return clean(event?.content || event?.text) || "（没有可显示的正文，可能是图片、文件或卡片）";
}

export function formatMainCaption(event, reason, conversationName = "") {
  const name = conversationName || "未知会话";
  if (reason === "dm") return `> 收到来自 **${name}** 的消息`;
  const sender = clean(event?.sender) || "未知发送人";
  return `> 收到来自 **${sender}** 在 **${name}** 的消息`;
}

export function formatMainPush(event, reason, conversationName = "") {
  const body = messageBody(event);
  return `${formatMainCaption(event, reason, conversationName)}\n\n${body}`;
}

export function formatTopicPush(event, reason) {
  const body = messageBody(event);
  if (reason === "dm") return body;
  const sender = clean(event?.sender) || "未知发送人";
  return `> **${sender}**：\n\n${body}`;
}

export function pushIndexLine(event, reason, conversationName = "") {
  const sender = clean(event?.sender) || "未知发送人";
  const where = conversationName || event?.conversation_id || "未知会话";
  const preview = (clean(event?.content || event?.text) || "（无正文）").replace(/\s+/g, " ").slice(0, 40);
  return [
    formatTime(event?.create_time || event?.event_time || event?.timestamp),
    sender, "在", where, REASONS[reason] || "",
    event?.conversation_id || "", event?.message_id || "", preview,
  ].join(" ").trim();
}

export function splitText(text, size = 3500) {
  const value = String(text ?? "");
  if (!Number.isInteger(size) || size < 2) throw new RangeError("消息分块长度必须至少为 2");
  const chunks = [];
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + size, value.length);
    const last = value.charCodeAt(end - 1);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    chunks.push(value.slice(start, end));
    start = end;
  }
  return chunks.length ? chunks : ["（空消息）"];
}

function clean(value) {
  const text = String(value ?? "").trim();
  return !text || text === "null" ? "" : text;
}

function formatTime(value) {
  if (value == null || value === "") return "";
  const numeric = Number(value);
  let date;
  if (Number.isFinite(numeric) && numeric > 0) date = new Date(numeric < 1e11 ? numeric * 1000 : numeric);
  else if (typeof value === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(value)) {
    date = new Date(value.replace(" ", "T") + "+08:00");
  } else date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}
