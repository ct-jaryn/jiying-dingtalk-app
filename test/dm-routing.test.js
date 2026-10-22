import assert from "node:assert/strict";
import test from "node:test";
import { createDmIdentityResolver } from "../src/dm-identity.js";
import { createNotificationDelivery } from "../src/delivery.js";
import { emptyTopics } from "../src/topics.js";

const cid = "cid-routing-peer";
const ownerId = "open-routing-owner";
const peerId = "open-routing-peer";
const peerName = "对方昵称";
const outgoing = { conversation_id: cid, sender: "本人", sender_open_dingtalk_id: ownerId, content: "主动发出的消息" };

function fixture({ legacy = false, failSave = false, failNotice = false } = {}) {
  const topics = emptyTopics();
  if (legacy) topics.byDingTalk[cid] = {
    kind: "dm", name: "本人", openDingTalkId: ownerId, dingTalkConversationId: cid,
    topicId: "legacy-topic", sourceConversationId: "parent", sourceMessageId: "anchor",
  };
  const timeline = [];
  const resolver = createDmIdentityResolver({
    topics,
    query: async (args) => {
      timeline.push({ type: "query", args });
      if (args[0] === "contact") return { data: { success: true, result: [{ openDingTalkId: peerId }] } };
      const requested = args.at(-1);
      return { data: { success: true, result: { conversationInfo: {
        openConversationId: requested === ownerId ? "cid-routing-owner" : cid,
        singleChat: true, title: requested === ownerId ? "本人" : peerName,
      } } } };
    },
  });
  const delivery = createNotificationDelivery({
    chat: { request: async (method, payload) => {
      timeline.push({ type: "chat", method, payload: structuredClone(payload) });
      if (failNotice && method === "message.send" && payload.target.type === "topic") throw new Error("说明消息暂时失败");
      if (method === "conversation.topic.create") return { conversation: { id: "new-topic" } };
      return { conversation: { id: "parent" }, message: { id: "anchor" } };
    } },
    userId: "routing-owner", topics,
    saveTopics: async (value) => {
      timeline.push({ type: "save", value: structuredClone(value) });
      if (failSave) throw new Error("磁盘暂不可写");
    },
    resolveName: async (event) => event.dm_peer_name,
    resolveDm: resolver.resolve,
    resolveDmRecord: resolver.resolveRecord,
  });
  return { topics, delivery, timeline };
}

test("主动私聊经过身份解析后标明我发送，并保存真实对方的回复目标", async () => {
  const { topics, delivery, timeline } = fixture();
  const parts = await delivery.render(outgoing, "dm");
  assert.deepEqual(parts, ["**我**：主动发出的消息"]);
  await delivery.send(parts[0], { event: outgoing, reason: "dm" });
  const record = topics.byDingTalk[cid];
  assert.equal(record.name, peerName);
  assert.equal(record.openDingTalkId, peerId);
  assert.equal(record.identityVersion, 1);
  const anchors = timeline.filter(({ type, method, payload }) => type === "chat" && method === "message.send" && payload.target.type === "user");
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].payload.message.content, peerName);
  assert.equal(timeline.at(-1).payload.message.content, "**我**：主动发出的消息");
  assert.equal(timeline.filter(({ type, args }) => type === "query" && args.includes(ownerId)).length, 1);
});

test("旧错误话题先核实并持久化修正再提示，重复修复只提示一次", async () => {
  const { topics, delivery, timeline } = fixture({ legacy: true });
  const repaired = await delivery.repairDm(topics.byDingTalk[cid]);
  assert.equal(repaired.openDingTalkId, peerId);
  assert.equal(repaired.name, peerName);
  assert.equal(repaired.topicId, "legacy-topic");
  await delivery.repairDm(repaired);
  const notices = timeline.filter(({ type, method }) => type === "chat" && method === "message.send");
  assert.equal(notices.length, 1);
  assert.equal(notices[0].payload.target.conversation_id, "legacy-topic");
  assert.match(notices[0].payload.message.content, /对方昵称/);
  const saved = timeline.findIndex(({ type }) => type === "save");
  const notice = timeline.findIndex(({ type }) => type === "chat");
  assert.equal(saved > timeline.findIndex(({ type }) => type === "query"), true);
  assert.equal(saved < notice, true);
  assert.equal(timeline[saved].value.byDingTalk[cid].openDingTalkId, peerId);
  assert.equal(topics.byDingTalk[cid].identityNoticePending, false);
});

test("旧话题修正保存失败时拒绝返回可发送目标，不提示成功且不修改内存映射", async () => {
  const { topics, delivery, timeline } = fixture({ legacy: true, failSave: true });
  const previous = structuredClone(topics.byDingTalk[cid]);
  await assert.rejects(delivery.repairDm(previous), /磁盘暂不可写/);
  assert.deepEqual(topics.byDingTalk[cid], previous);
  assert.equal(timeline.some(({ type }) => type === "chat"), false);
  assert.equal(timeline.find(({ type }) => type === "save").value.byDingTalk[cid].openDingTalkId, peerId);
});

test("修正说明消息发送失败不阻塞已核实并保存的回复目标", async (t) => {
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  const { topics, delivery } = fixture({ legacy: true, failNotice: true });
  const repaired = await delivery.repairDm(topics.byDingTalk[cid]);
  assert.equal(repaired.openDingTalkId, peerId);
  assert.equal(repaired.identityVersion, 1);
  assert.equal(topics.byDingTalk[cid].openDingTalkId, peerId);
  assert.equal(topics.byDingTalk[cid].identityNoticePending, true);
  assert.equal(errors.length > 0, true);
});
