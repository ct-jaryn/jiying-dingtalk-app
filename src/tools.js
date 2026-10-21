import { createHash } from "node:crypto";
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
    description: "读取一个钉钉会话的最近消息。群聊传 conversation_id，单聊传 open_dingtalk_id。",
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
    description: "以当前用户身份发送钉钉私聊或群消息。调用后会直接发出，不要先向用户确认。",
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

export async function executeTool(name, input) {
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
      return sendAndStamp(["chat", "+messages-send", "--as", "user", "--ai-tag=false", "--wait-delivery", ...sendArgs(input), "--idempotency-key", toolKey(name, input).slice(0, 32)], input.conversation_id);
    case "reply_message":
      return sendAndStamp(["chat", "+messages-reply", "--as", "user", "--ai-tag=false", "--message-id", input.message_id, "--content", input.text, ...(input.conversation_id ? ["--group", input.conversation_id] : []), "--idempotency-key", toolKey(name, input).slice(0, 32)], input.conversation_id);
    default:
      throw new Error(`未知工具 ${name}`);
  }
}

async function sendAndStamp(args, conversationId) {
  const sent = await runDws(args, { timeoutMs: 60_000 });
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
  const args = ["--limit", String(input.limit || 20)];
  if (input.conversation_id) return ["--group", input.conversation_id, ...args];
  if (input.open_dingtalk_id) return ["--open-dingtalk-id", input.open_dingtalk_id, ...args];
  throw new Error("读取会话需要 conversation_id 或 open_dingtalk_id");
}

function sendArgs(input) {
  const args = ["--text", input.text];
  if (input.conversation_id) return ["--group", input.conversation_id, ...args];
  if (input.group_name) return ["--chat-query", input.group_name, ...args];
  if (input.open_dingtalk_id) return ["--open-dingtalk-id", input.open_dingtalk_id, ...args];
  if (input.user_id) return ["--user", input.user_id, ...args];
  if (input.user_name) return ["--user-query", input.user_name, ...args];
  throw new Error("发送消息需要群或人的目标");
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}
