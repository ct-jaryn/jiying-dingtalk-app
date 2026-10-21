import assert from "node:assert/strict";
import test from "node:test";
import { conversationNameFrom, conversationTitle, formatMainPush, formatPush, formatTopicPush, isAtAll, messageBody, normalizeEvent, pushIndexLine } from "../src/push.js";
import { extractMediaIds } from "../src/media.js";

test("话题格式与旧通知接口并存，推送索引仍保留稳定 ID 和时间", () => {
  const event = { sender: "测试同事", content: "请确认", conversation_id: "cid-merge", message_id: "msg-merge", event_time: "2026-10-21 14:20:00" };
  const legacy = formatPush(event, "mention", "测试群");
  assert.match(legacy, /钉钉通知 · @我/);
  assert.match(legacy, /14:20/);
  assert.match(legacy, /测试群/);
  assert.equal(formatPush(event, "mention", "测试群", { topic: true }), formatTopicPush(event, "mention"));
  assert.equal(formatPush(event, "mention", "测试群", { topic: false }), formatMainPush(event, "mention", "测试群"));
  assert.equal(formatPush(event, "dm", "测试同事", { topic: true }), "请确认");
  const index = pushIndexLine(event, "mention", "测试群");
  assert.match(index, /14:20/);
  assert.ok(index.split(/\s+/).includes("msg-merge"));
});

test("话题和旧通知共用宽兼容群名解析，并跳过无效标题", () => {
  for (const payload of [
    { result: { conversationInfo: { title: "null", name: "测试群" } } },
    { result: { conversation: { name: "测试群" } } },
    { conversation: { group_name: "测试群" } },
    { result: { conversationTitle: "测试群" } },
    { result: { conversationInfo: {} }, title: "测试群" },
  ]) {
    assert.equal(conversationTitle(payload), "测试群");
    assert.equal(conversationNameFrom(payload), "测试群");
  }
});

test("标准化图片事件后保留资源标记，话题正文可继续取图", () => {
  const image = "[图片消息](mediaId=%24test-image)";
  const event = normalizeEvent({
    event_type: "user_im_message_receive_at",
    data: { messageId: "msg-image", conversationId: "cid-image", sender: { name: "测试同事" }, content: { text: image }, resourceRefs: [{ resourceId: "$test-image" }] },
  });
  assert.equal(messageBody(event), image);
  assert.deepEqual(extractMediaIds(formatTopicPush(event, "mention")), ["$test-image"]);
  assert.deepEqual(event.resourceRefs, [{ resourceId: "$test-image" }]);
});

test("两个正文字段都检查 @所有人，正文内 JSON 不能冒充结构化标记", () => {
  assert.equal(isAtAll({ content: "正文", text: "@所有人 请确认" }), true);
  assert.equal(isAtAll({ content: '示例 {"atAll":true}' }), false);
  assert.equal(isAtAll({ metadata: { atAll: true } }), true);
});

test("私聊事件保留明确的 openDingTalkId，话题回复不能误用普通用户 ID", () => {
  const base = { type: "user_im_message_receive_o2o_all", messageId: "dm-merge", conversationId: "dm-conversation" };
  const nested = normalizeEvent({ event_type: base.type, data: { ...base, sender: { name: "测试同事", id: "ordinary-id", openDingTalkId: "open-recipient" } } });
  assert.equal(nested.sender, "测试同事");
  assert.equal(nested.sender_open_dingtalk_id, "open-recipient");
  assert.equal(normalizeEvent({ ...base, senderOpenDingtalkId: "flat-recipient" }).sender_open_dingtalk_id, "flat-recipient");
  assert.equal(normalizeEvent({ ...base, sender: { id: "ordinary-id" } }).sender_open_dingtalk_id, "");
});
