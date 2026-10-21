const REASONS = { dm: "私聊", mention: "@我", "at-all": "@所有人" };

export function classify(event) {
  const type = String(event?.type || "");
  if (type === "user_im_message_receive_o2o_all") return "dm";
  if (type === "user_im_message_receive_at") return isAtAll(event) ? "at-all" : "mention";
  if (type === "user_im_message_receive_group_all" && isAtAll(event)) return "at-all";
  return null;
}

export function isAtAll(event) {
  const content = `${event?.content || ""}\n${event?.text || ""}`;
  if (content.includes("@所有人") || content.includes("@全体")) return true;
  if (/(^|[\s\u00a0\u2005\u200b])@all\b/i.test(content)) return true;
  return /"atAll"\s*:\s*true/.test(JSON.stringify(event ?? {}))
    || ["atAll", "at_all", "isAtAll", "is_at_all"].some((key) => event?.[key] === true);
}

export function mutedForConversation(payload, conversationId) {
  const settings = payload?.result?.settings || payload?.settings || [];
  const row = settings.find((item) => item.openConversationId === conversationId);
  if (!row || row.success === false || row.notificationOff == null) return null;
  return Number(row.notificationOff) === 1;
}

export function formatPush(event, reason, conversationName = "") {
  const sender = clean(event?.sender) || "未知发送人";
  const where = conversationName ? `在 ${conversationName}` : "";
  const body = clean(event?.content || event?.text) || "（没有可显示的正文，可能是图片、文件或卡片）";
  return [
    `**钉钉通知 · ${REASONS[reason] || "相关消息"}**`,
    `**${sender}**${where ? ` ${where}` : ""}`,
    formatTime(event?.create_time || event?.event_time || event?.timestamp),
    "",
    body,
  ].filter((line, index) => line !== "" || index > 2).join("\n");
}

export function pushIndexLine(event, reason, conversationName = "") {
  const sender = clean(event?.sender) || "未知发送人";
  const where = conversationName || event?.conversation_id || "未知会话";
  const preview = (clean(event?.content || event?.text) || "（无正文）").replace(/\s+/g, " ").slice(0, 40);
  return `${formatTime(event?.create_time || event?.timestamp)} ${sender} 在 ${where} ${REASONS[reason] || ""} ${event?.conversation_id || ""} ${event?.message_id || ""} ${preview}`.trim();
}

function clean(value) {
  const text = String(value ?? "").trim();
  return !text || text === "null" ? "" : text;
}

function formatTime(value) {
  if (value == null || value === "") return "";
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && numeric > 1e11 ? new Date(numeric) : new Date(value);
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
