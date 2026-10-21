import assert from "node:assert/strict";
import test from "node:test";
import { createNotificationDelivery } from "../src/delivery.js";
import { createPushForwarder } from "../src/forwarder.js";
import { emptyTopics } from "../src/topics.js";

const event = { message_id: "msg-delivery", conversation_id: "cid-delivery", sender: "测试同事", content: "请确认", sender_open_dingtalk_id: "sender-delivery" };
const diskCopy = (value) => JSON.parse(JSON.stringify(value));

function forwarder(t, state, options) {
  let persisted = diskCopy(state);
  const instance = createPushForwarder({
    state,
    saveState: async (snapshot) => { persisted = diskCopy(snapshot); },
    retryDelayMs: 60_000,
    maxRetryDelayMs: 60_000,
    ...options,
  });
  t.after(async () => { instance.stop(); await instance.waitForIdle(); });
  return { instance, persisted: () => persisted };
}

test("创建话题失败保留待发通知，重启复用已持久化锚点而不重发主聊消息", async (t) => {
  const calls = [];
  let failTopic = true;
  let savedTopics = emptyTopics();
  let delivered = 0;
  const chat = { request: async (method, payload) => {
    calls.push({ method, payload: structuredClone(payload) });
    if (method === "conversation.topic.create") {
      assert.equal(savedTopics.byDingTalk[event.conversation_id].sourceMessageId, "anchor-message");
      if (failTopic) throw new Error("创建话题暂时失败");
      return { conversation: { id: "topic-delivery" } };
    }
    if (payload.target.type === "user") return { conversation: { id: "parent-delivery" }, message: { id: "anchor-message" } };
    return { message: { id: "sent-body" } };
  } };
  const createDelivery = (topics) => createNotificationDelivery({
    chat, userId: "owner-delivery", topics,
    saveTopics: async (snapshot) => { savedTopics = diskCopy(snapshot); },
    resolveName: async () => "测试群",
  });
  const initial = createDelivery(emptyTopics());
  const firstState = { pending: [], delivered: {} };
  const first = forwarder(t, firstState, { render: initial.render, send: initial.send, onDelivered: () => { delivered++; } });
  await first.instance.enqueue(event, "mention");
  await first.instance.waitForIdle();
  assert.equal(firstState.pending.length, 1);
  assert.equal(firstState.pending[0].nextPart, 0);
  assert.equal(Object.keys(firstState.delivered).length, 0);
  assert.equal(delivered, 0);
  assert.equal(calls.filter(({ method, payload }) => method === "message.send" && payload.target.type === "topic").length, 0);
  assert.equal(savedTopics.byDingTalk[event.conversation_id].sourceConversationId, "parent-delivery");
  assert.equal(savedTopics.byDingTalk[event.conversation_id].topicId, undefined);
  first.instance.stop();

  failTopic = false;
  const restarted = createDelivery(diskCopy(savedTopics));
  const recoveredState = first.persisted();
  const second = forwarder(t, recoveredState, { render: () => { throw new Error("已持久化的正文不应重渲染"); }, send: restarted.send, onDelivered: () => { delivered++; } });
  second.instance.wake();
  await second.instance.waitForIdle();
  assert.equal(recoveredState.pending.length, 0);
  assert.equal(Object.keys(recoveredState.delivered).length, 1);
  assert.equal(delivered, 1);
  const anchors = calls.filter(({ method, payload }) => method === "message.send" && payload.target.type === "user");
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].payload.message.content, "测试群");
  const creates = calls.filter(({ method }) => method === "conversation.topic.create");
  assert.equal(creates.length, 2);
  assert.deepEqual(creates[0].payload, creates[1].payload);
  const bodies = calls.filter(({ method, payload }) => method === "message.send" && payload.target.type === "topic");
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].payload.target.conversation_id, "topic-delivery");
  assert.match(bodies[0].payload.message.content, /请确认/);
});

test("已有话题直接复用，不重新查询名称或创建源头消息", async () => {
  const calls = [];
  const topics = emptyTopics();
  topics.byDingTalk[event.conversation_id] = { topicId: "existing-topic", name: "已有群" };
  const delivery = createNotificationDelivery({
    chat: { request: async (method, payload) => { calls.push({ method, payload }); return {}; } },
    userId: "owner-delivery", topics,
    saveTopics: async () => { throw new Error("已有话题无需写入"); },
    resolveName: async () => { throw new Error("已有话题无需查询群名"); },
  });
  await delivery.send("正文", { event, reason: "mention" });
  assert.deepEqual(calls, [{ method: "message.send", payload: {
    target: { type: "topic", conversation_id: "existing-topic" },
    message: { type: "markdown", content: "正文" },
  } }]);
});

test("图片对象分块经过持久化与重启继续发送，已完成正文不重发", async (t) => {
  const parts = ["正文已成功", { type: "image", mediaId: "$image-resource", caption: "> **测试同事**：" }];
  const attempts = [];
  const firstState = { pending: [], delivered: {} };
  const first = forwarder(t, firstState, {
    render: () => parts,
    send: async (part, metadata) => {
      attempts.push({ part: structuredClone(part), partIndex: metadata.partIndex });
      if (typeof part !== "string") throw new Error("发送图片时断线");
    },
  });
  await first.instance.enqueue(event, "mention");
  await first.instance.waitForIdle();
  assert.deepEqual(attempts.map(({ partIndex }) => partIndex), [0, 1]);
  assert.equal(firstState.pending[0].nextPart, 1);
  assert.deepEqual(first.persisted().pending[0].parts, parts);
  assert.equal(Object.keys(firstState.delivered).length, 0);
  first.instance.stop();
  const sent = [];
  const recoveredState = first.persisted();
  const second = forwarder(t, recoveredState, {
    render: () => { throw new Error("恢复时不能重新读取图片或生成正文"); },
    send: async (part, metadata) => { sent.push({ part, partIndex: metadata.partIndex, messageId: metadata.event.message_id }); },
  });
  second.instance.wake();
  await second.instance.waitForIdle();
  assert.deepEqual(sent, [{ part: parts[1], partIndex: 1, messageId: event.message_id }]);
  assert.equal(recoveredState.pending.length, 0);
  assert.equal(Object.keys(recoveredState.delivered).length, 1);
});

for (const missing of ["sourceConversationId", "sourceMessageId", "topicId"]) {
  test(`缺少 ${missing} 时明确失败，不将正文静默发送到主聊`, async () => {
    const calls = [];
    let saves = 0;
    const delivery = createNotificationDelivery({
      chat: { request: async (method, payload) => {
        calls.push({ method, payload });
        if (method === "conversation.topic.create") return {};
        return {
          conversation: missing === "sourceConversationId" ? {} : { id: "parent-delivery" },
          message: missing === "sourceMessageId" ? {} : { id: "anchor-message" },
        };
      } },
      userId: "owner-delivery", topics: emptyTopics(),
      saveTopics: async () => { saves++; }, resolveName: async () => "测试群",
    });
    await assert.rejects(delivery.send("通知正文", { event, reason: "mention" }), /创建话题失败/);
    const messages = calls.filter(({ method }) => method === "message.send");
    assert.equal(messages.length, 1);
    assert.equal(messages[0].payload.message.content, "测试群");
    assert.equal(messages[0].payload.target.type, "user");
    assert.equal(calls.filter(({ method }) => method === "conversation.topic.create").length, missing === "topicId" ? 1 : 0);
    assert.equal(saves, missing === "topicId" ? 1 : 0);
  });
}
