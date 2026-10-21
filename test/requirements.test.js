import assert from "node:assert/strict";
import test from "node:test";
import { classify, isAtAll, mutedForConversation, pushIndexLine } from "../src/push.js";
import { splitProtectedAndRounds, toAnthropicMessages, truncateOldToolResults, visibleHistory } from "../src/session.js";
import { toolKey } from "../src/tools.js";

test("只推送私聊、@我和@所有人", () => {
  assert.equal(classify({ type: "user_im_message_receive_o2o_all" }), "dm");
  assert.equal(classify({ type: "user_im_message_receive_at" }), "mention");
  assert.equal(classify({ type: "user_im_message_receive_group_all", content: "普通消息" }), null);
  assert.equal(classify({ type: "user_im_message_receive_group_all", content: "@所有人 发布" }), "at-all");
  assert.equal(isAtAll({ content: "请看 @all" }), true);
});

test("按会话识别真实免打扰结果", () => {
  const payload = {
    result: {
      settings: [
        { notificationOff: 1, openConversationId: "muted", success: true },
        { notificationOff: 0, openConversationId: "open", success: true },
      ],
    },
  };
  assert.equal(mutedForConversation(payload, "muted"), true);
  assert.equal(mutedForConversation(payload, "open"), false);
  assert.equal(mutedForConversation(payload, "missing"), null);
});

test("推送索引包含会话名", () => {
  const line = pushIndexLine({
    sender: "陈佳",
    content: "@所有人 发布",
    conversation_id: "cid-1",
    message_id: "msg-1",
    create_time: "2026-10-21 11:07:35",
  }, "at-all", "销售群");
  assert.match(line, /销售群/);
  assert.match(line, /cid-1/);
  assert.match(line, /msg-1/);
});

test("正文或结构化标记都能识别@所有人", () => {
  assert.equal(classify({ type: "user_im_message_receive_group_all", text: "@所有人 发布" }), "at-all");
  assert.equal(isAtAll({ extension: { atAll: true } }), true);
});

test("每次只带最近 6 句可见历史和当前指令", () => {
  const history = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `m${i}` }));
  const window = visibleHistory(history);
  assert.equal(window.length, 6);
  assert.equal(window[0].text, "m2");
  const messages = toAnthropicMessages(window, "现在处理");
  assert.equal(messages.at(-1).content, "现在处理");
  assert.equal(messages[0].role, "user");
});

test("相同工具和参数只算一次", () => {
  assert.equal(toolKey("send_message", { b: 1, a: 2 }), toolKey("send_message", { a: 2, b: 1 }));
});

test("压缩时保留开头的可见历史和最新工具轮次", () => {
  const messages = [
    { role: "user", content: "历史" },
    { role: "assistant", content: [{ type: "tool_use", id: "1", name: "list_unread", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "旧结果" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "2", name: "read_messages", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "2", content: "新结果" }] },
  ];
  const split = splitProtectedAndRounds(messages);
  assert.equal(split.prefix.length, 1);
  assert.equal(split.prefix[0].content, "历史");
  assert.equal(split.rounds.length, 2);
  assert.equal(split.rounds.at(-1)[1].content[0].content, "新结果");
});

test("压缩时保留最新工具结果", () => {
  const messages = [
    { role: "user", content: [{ type: "tool_result", content: "x".repeat(800) }] },
    { role: "user", content: [{ type: "tool_result", content: "最新结果" }] },
  ];
  const compacted = truncateOldToolResults(messages);
  assert.match(compacted[0].content[0].content, /已压缩/);
  assert.equal(compacted[1].content[0].content, "最新结果");
});
