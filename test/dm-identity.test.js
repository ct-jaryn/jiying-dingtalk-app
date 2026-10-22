import assert from "node:assert/strict";
import test from "node:test";
import { createNotificationDelivery } from "../src/delivery.js";
import { emptyTopics } from "../src/topics.js";

const owner = { id: "open-owner", name: "本人" };
const peer = { id: "open-peer", name: "测试同事" };

function event(direction, options = {}) {
  return {
    type: "user_im_message_receive_o2o_all",
    message_id: `dm-${direction}`,
    conversation_id: "cid-dm-peer",
    sender: direction === "outgoing" ? owner.name : peer.name,
    sender_open_dingtalk_id: direction === "outgoing" ? owner.id : peer.id,
    dm_direction: direction,
    dm_peer_name: peer.name,
    dm_peer_open_dingtalk_id: peer.id,
    content: "测试消息",
    ...options,
  };
}

function fixture(initial = emptyTopics()) {
  const topics = structuredClone(initial);
  const calls = [];
  const writes = [];
  const delivery = createNotificationDelivery({
    chat: { request: async (method, payload) => {
      calls.push({ method, payload: structuredClone(payload) });
      if (method === "conversation.topic.create") return { conversation: { id: "topic-peer" } };
      if (payload.target.type === "user") return { conversation: { id: "parent" }, message: { id: "anchor" } };
      return { message: { id: "body" } };
    } },
    userId: "magicchat-owner",
    topics,
    saveTopics: async (value) => { writes.push(structuredClone(value)); },
    resolveName: async (value) => value.dm_peer_name || "未知私聊对象",
  });
  return { topics, calls, writes, send: (value) => delivery.send("正文", { event: value, reason: "dm" }) };
}

test("主动发出的私聊将对方保存为回复目标，不能把发送人本人当作对方", async () => {
  const instance = fixture();
  await instance.send(event("outgoing"));
  const record = instance.topics.byDingTalk["cid-dm-peer"];
  assert.equal(record.kind, "dm");
  assert.equal(record.name, peer.name);
  assert.equal(record.openDingTalkId, peer.id);
  assert.notEqual(record.openDingTalkId, owner.id);
});

test("正常入站私聊继续保存对方作为回复目标", async () => {
  const instance = fixture();
  await instance.send(event("incoming"));
  const record = instance.topics.byDingTalk["cid-dm-peer"];
  assert.equal(record.name, peer.name);
  assert.equal(record.openDingTalkId, peer.id);
});

test("已存在的错误私聊映射会修正对方资料并保留原话题", async () => {
  const initial = emptyTopics();
  initial.byDingTalk["cid-dm-peer"] = {
    kind: "dm", name: owner.name, openDingTalkId: owner.id,
    dingTalkConversationId: "cid-dm-peer", topicId: "existing-topic",
    sourceConversationId: "existing-parent", sourceMessageId: "existing-anchor",
  };
  const instance = fixture(initial);
  await instance.send(event("outgoing"));
  const record = instance.topics.byDingTalk["cid-dm-peer"];
  assert.equal(record.name, peer.name);
  assert.equal(record.openDingTalkId, peer.id);
  assert.equal(record.topicId, "existing-topic");
  assert.equal(record.sourceConversationId, "existing-parent");
  assert.equal(record.sourceMessageId, "existing-anchor");
  assert.equal(instance.calls.filter(({ method }) => method === "conversation.topic.create").length, 0);
  assert.equal(instance.calls.filter(({ method, payload }) => method === "message.send" && payload.target.type === "user").length, 0);
  assert.equal(instance.writes.at(-1).byDingTalk["cid-dm-peer"].openDingTalkId, peer.id);
});

test("主动私聊未识别到对方时不把本人 ID 保存为回复目标", async () => {
  const instance = fixture();
  const outgoing = event("outgoing", { dm_peer_name: "", dm_peer_open_dingtalk_id: "" });
  // A destination may decline delivery until identity lookup succeeds. If it
  // creates a display-only topic, that record must not route replies to self.
  await instance.send(outgoing).catch(() => {});
  const record = instance.topics.byDingTalk["cid-dm-peer"];
  assert.notEqual(record?.openDingTalkId, owner.id);
});

test("缺少新对方资料的主动事件不会覆盖已有正确的私聊回复目标", async () => {
  const initial = emptyTopics();
  initial.byDingTalk["cid-dm-peer"] = {
    kind: "dm", name: peer.name, openDingTalkId: peer.id,
    dingTalkConversationId: "cid-dm-peer", topicId: "existing-topic",
  };
  const instance = fixture(initial);
  await assert.rejects(instance.send(event("outgoing", { dm_peer_name: "", dm_peer_open_dingtalk_id: "" })), /尚未确认私聊对象/);
  const record = instance.topics.byDingTalk["cid-dm-peer"];
  assert.equal(record.name, peer.name);
  assert.equal(record.openDingTalkId, peer.id);
  assert.equal(record.topicId, "existing-topic");
});
