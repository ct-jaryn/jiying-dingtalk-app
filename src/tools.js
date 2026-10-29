import { createHash, randomUUID } from "node:crypto";
import { runDws } from "./dws.js";
import { stampSentMessage } from "./stamp.js";
import { resolve } from "node:path";

export const TOOLS = [
  {
    name: "list_unread",
    description: "列出当前钉钉未读会话，包含未读数和是否免打扰。",
    input_schema: { type: "object", properties: { count: { type: "integer" } } },
  },
  {
    name: "list_mentions",
    description: "查询最近 @我 的钉钉消息。",
    input_schema: { type: "object", properties: { days: { type: "integer" }, limit: { type: "integer" } } },
  },
  {
    name: "search_messages",
    description: "按关键词、发送人或群搜索钉钉消息。至少提供一个条件。",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        sender: { type: "string" },
        group: { type: "string" },
        days: { type: "integer" },
      },
    },
  },
  {
    name: "read_messages",
    description: "读取一个钉钉会话的最近消息。群聊传 conversation_id，单聊传 open_dingtalk_id；两个目标必须且只能选一个。",
    input_schema: {
      type: "object",
      properties: {
        conversation_id: { type: "string" },
        open_dingtalk_id: { type: "string" },
        limit: { type: "integer" },
      },
    },
  },
  {
    name: "find_target",
    description: "按姓名找人，或按群名找群，拿到后续发送要用的稳定 ID。",
    input_schema: {
      type: "object",
      properties: { kind: { type: "string", enum: ["user", "group"] }, query: { type: "string" } },
      required: ["kind", "query"],
    },
  },
  {
    name: "send_message",
    description: "以当前用户身份发送钉钉私聊或群消息。conversation_id、group_name、open_dingtalk_id、user_id、user_name 五个目标必须且只能选一个。调用后会直接发出，不要先向用户确认。",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string" },
        conversation_id: { type: "string" },
        group_name: { type: "string" },
        open_dingtalk_id: { type: "string" },
        user_id: { type: "string" },
        user_name: { type: "string" },
      },
      required: ["text"],
    },
  },
  {
    name: "reply_message",
    description: "引用回复一条钉钉消息。调用后会直接发出。",
    input_schema: {
      type: "object",
      properties: {
        message_id: { type: "string" },
        text: { type: "string" },
        conversation_id: { type: "string" },
      },
      required: ["message_id", "text"],
    },
  },
];

export function toolKey(name, input) {
  return `${name}:${createHash("sha256").update(JSON.stringify(sortKeys(input || {}))).digest("hex")}`;
}

export async function executeTool(name, input, { outbound, requestScope } = {}) {
  switch (name) {
    case "list_unread":
      return runDws(["chat", "message", "list-unread-conversations", "--count", String(input.count || 30)]);
    case "list_mentions":
      return runDws(["chat", "+at-me", "--days", String(input.days || 7), "--limit", String(input.limit || 20)]);
    case "search_messages":
      return runDws(["chat", "+search-msg", ...searchArgs(input)]);
    case "read_messages":
      return runDws(["chat", "+chat-messages", ...readArgs(input)]);
    case "find_target":
      return input.kind === "group"
        ? runDws(["chat", "+chat-search", "--query", input.query])
        : runDws(["contact", "user", "search", "--query", input.query]);
    case "send_message":
      return sendAndStamp(["chat", "+messages-send", "--as", "user", "--ai-tag=false", "--wait-delivery", ...sendArgs(input), "--idempotency-key", sendKey(name, input, requestScope)], input.conversation_id, outbound);
    case "reply_message":
      return sendAndStamp(["chat", "+messages-reply", "--as", "user", "--ai-tag=false", "--wait-delivery", "--message-id", input.message_id, "--content", input.text, ...(input.conversation_id ? ["--group", input.conversation_id] : []), "--idempotency-key", sendKey(name, input, requestScope)], input.conversation_id, outbound);
    default:
      throw new Error(`未知工具 ${name}`);
  }
}

function sendKey(name, input, requestScope) {
  // Identical content in a later user request is a new send. Only retries of
  // the same request and operation should share a remote idempotency key.
  const scope = String(requestScope || randomUUID());
  return createHash("sha256").update(JSON.stringify([scope, toolKey(name, input)])).digest("hex").slice(0, 32);
}

async function sendAndStamp(args, conversationId, outbound) {
  const execute = () => runDws(args, { timeoutMs: 60_000 });
  const sent = outbound ? await outbound.send(execute, { conversationId }) : await execute();
  await stampSentMessage(sent.data, {
    conversationId,
    emotionPath: resolve("data/emotion.json"),
  }).catch((error) => console.error("贴使用即应发送失败：", error.message));
  return sent;
}

function searchArgs(input) {
  const args = [];
  if (input.query) args.push("--query", input.query);
  if (input.sender) args.push("--sender", input.sender);
  if (input.group) args.push("--group", input.group);
  if (input.days) args.push("--days", String(input.days));
  if (!args.length) throw new Error("搜索至少要有一个条件");
  return args;
}

function readArgs(input) {
  return [...targetArgs(input, {
    conversation_id: "--group", open_dingtalk_id: "--open-dingtalk-id",
  }, "读取会话"), "--limit", String(input.limit || 20)];
}

function sendArgs(input) {
  return [...targetArgs(input, {
    conversation_id: "--group", group_name: "--chat-query", open_dingtalk_id: "--open-dingtalk-id",
    user_id: "--user", user_name: "--user-query",
  }, "发送消息"), "--text", input.text];
}

function targetArgs(input, flags, action) {
  const targets = [];
  for (const [field, flag] of Object.entries(flags)) {
    const value = input[field];
    if (value == null) continue;
    if (typeof value !== "string") throw new Error(`${action}的目标 ${field} 必须是非空字符串`);
    if (value.trim()) targets.push([field, flag, value.trim()]);
  }
  if (targets.length !== 1) throw new Error(`${action}必须且只能指定一个目标，请重新选择 ${Object.keys(flags).join("、")} 中的一项`);
  return targets[0].slice(1);
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}
