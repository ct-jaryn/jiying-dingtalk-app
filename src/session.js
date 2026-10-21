export const HISTORY_LIMIT = 6;

export function estimateTokens(value) {
  return Math.ceil(JSON.stringify(value).length / 2);
}

export function visibleHistory(messages, limit = HISTORY_LIMIT) {
  return (messages || []).slice(-limit);
}

export function appendVisible(session, role, text) {
  session.messages.push({ role, text, at: new Date().toISOString() });
}

export function toAnthropicMessages(history, currentText) {
  const messages = [];
  for (const item of history) {
    if (item.role !== "user" && item.role !== "assistant") continue;
    appendTurn(messages, item.role, item.text);
  }
  while (messages.length && messages[0].role !== "user") messages.shift();
  appendTurn(messages, "user", currentText);
  return messages;
}

function appendTurn(messages, role, content) {
  const last = messages.at(-1);
  if (last?.role === role) last.content = `${last.content}\n\n${content}`;
  else messages.push({ role, content });
}

export function truncateOldToolResults(messages, keepChars = 500) {
  const copy = structuredClone(messages);
  const toolIndexes = [];
  copy.forEach((message, index) => {
    if (!Array.isArray(message.content)) return;
    if (message.content.some((block) => block.type === "tool_result")) toolIndexes.push(index);
  });
  const stale = toolIndexes.slice(0, -1);
  for (const index of stale) {
    for (const block of copy[index].content) {
      if (block.type !== "tool_result") continue;
      const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
      if (text.length > keepChars) block.content = `${text.slice(0, keepChars)}\n…（较早的工具结果已压缩）`;
    }
  }
  return copy;
}

export function splitProtectedAndRounds(messages) {
  const prefix = [];
  const rounds = [];
  let current = null;
  for (const message of messages) {
    const blocks = Array.isArray(message.content) ? message.content : [];
    const toolUse = blocks.some((block) => block.type === "tool_use");
    if (toolUse) {
      if (current) rounds.push(current);
      current = [message];
      continue;
    }
    if (current) current.push(message);
    else prefix.push(message);
  }
  if (current) rounds.push(current);
  return { prefix, rounds };
}

export function rememberPush(index, line, limit = 8) {
  index.unshift(line);
  return index.slice(0, limit);
}
