import assert from "node:assert/strict";
import test from "node:test";
import { createDmIdentityResolver } from "../src/dm-identity.js";

const cid = "cid-peer";
const peerId = "open-peer";
const selfId = "open-owner";
const info = (id, title) => ({ data: { success: true, result: { conversationInfo: { openConversationId: id, singleChat: true, title } } } });
const result = (value) => ({ data: { success: true, result: value } });
const incoming = (extra = {}) => ({ conversation_id: cid, sender: "对方", sender_open_dingtalk_id: peerId, content: "消息", ...extra });
const outgoing = (extra = {}) => incoming({ sender: "本人", sender_open_dingtalk_id: selfId, ...extra });

function fixture(overrides = {}, topics) {
  const calls = [];
  const query = async (args) => {
    calls.push(args);
    const key = args.join(" ");
    if (Object.hasOwn(overrides, key)) return typeof overrides[key] === "function" ? overrides[key](args) : overrides[key];
    if (key === `chat +conversation-info --open-dingtalk-id ${selfId}`) return info("cid-self", "本人");
    if (key === `chat +conversation-info --open-dingtalk-id ${peerId}`) return info(cid, "对方昵称");
    if (key === `chat +conversation-info --group ${cid}`) return info(cid, "对方昵称");
    if (key === "contact user search --query 对方昵称") return result([{ name: "真实姓名", nick: "对方昵称", openDingTalkId: peerId, userId: "user-peer" }]);
    if (key === "contact user get-self") return result({ userId: "user-owner" });
    if (key === "contact user search --query user-owner") return result([{ userId: "user-owner", openDingTalkId: selfId }]);
    throw new Error(`未配置模拟接口：${key}`);
  };
  return { calls, resolver: createDmIdentityResolver({ query, topics }) };
}

test("入站私聊以发送人对应的精确会话 ID 确认对方", async () => {
  const { resolver, calls } = fixture();
  const resolved = await resolver.resolve(incoming());
  assert.equal(resolved.dm_peer_open_dingtalk_id, peerId);
  assert.equal(resolved.dm_peer_name, "对方昵称");
  assert.equal(resolved.dm_direction, "incoming");
  assert.equal(resolved.content, "消息");
  assert.equal(calls.some((args) => args.includes("--group")), false);
});

test("主动私聊不能拿本人作对方，必须找到会话 ID 一致的联系人", async () => {
  const { resolver } = fixture();
  const resolved = await resolver.resolve(outgoing());
  assert.equal(resolved.dm_peer_open_dingtalk_id, peerId);
  assert.equal(resolved.dm_peer_name, "对方昵称");
  assert.equal(resolved.dm_direction, "outgoing");
});

test("同名联系人逐个校验会话 ID，不按搜索结果第一项决定对方", async () => {
  const { resolver, calls } = fixture({
    "contact user search --query 对方昵称": result([
      { name: "同名", openDingTalkId: "open-wrong" },
      { name: "真实姓名", nick: "对方昵称", openDingTalkId: peerId },
    ]),
    "chat +conversation-info --open-dingtalk-id open-wrong": info("cid-other", "同名"),
  });
  const resolved = await resolver.resolve(outgoing());
  assert.equal(resolved.dm_peer_open_dingtalk_id, peerId);
  assert.equal(resolved.dm_peer_name, "对方昵称");
  assert.equal(calls.filter((args) => args.includes("open-wrong")).length, 1);
  assert.equal(calls.filter((args) => args.includes(peerId)).length, 1);
});

test("找不到精确匹配时失败，不能退回本人或名称猜测且不缓存失败", async () => {
  let failed = true;
  const { resolver, calls } = fixture({
    "contact user search --query 对方昵称": () => result(failed ? [{ name: "同名", openDingTalkId: "open-wrong" }] : [{ openDingTalkId: peerId }]),
    "chat +conversation-info --open-dingtalk-id open-wrong": info("cid-other", "同名"),
  });
  await assert.rejects(resolver.resolve(outgoing()), /会话 ID 一致/);
  failed = false;
  assert.equal((await resolver.resolve(outgoing())).dm_peer_open_dingtalk_id, peerId);
  assert.equal(calls.filter((args) => args.includes("--group")).length, 2);
  // A valid sender query can be reused even though peer discovery failed.
  assert.equal(calls.filter((args) => args.includes(selfId)).length, 1);
});

test("发送人接口异常保留失败，后续能够重试且不返回未经核实的发送人", async () => {
  let failed = true;
  const { resolver, calls } = fixture({
    [`chat +conversation-info --open-dingtalk-id ${peerId}`]: () => {
      if (failed) throw new Error("网络失败");
      return info(cid, "对方昵称");
    },
  });
  await assert.rejects(resolver.resolve(incoming()), /网络失败/);
  failed = false;
  assert.equal((await resolver.resolve(incoming())).dm_peer_open_dingtalk_id, peerId);
  assert.equal(calls.filter((args) => args.includes(peerId)).length, 2);
});

test("旧话题映射未经验证不能信任，错误本人 ID 会重新解析", async () => {
  const record = { kind: "dm", name: "本人", openDingTalkId: selfId, dingTalkConversationId: cid, topicId: "topic" };
  const { resolver, calls } = fixture({}, { byDingTalk: { [cid]: record } });
  const resolved = await resolver.resolveRecord(record);
  assert.equal(resolved.dm_peer_open_dingtalk_id, peerId);
  assert.equal(resolved.dm_peer_name, "对方昵称");
  assert.equal(resolved.dm_direction, "unknown");
  assert.equal(calls.length, 4);
});

test("经过版本标记核实的持久化话题可直接恢复缓存", async () => {
  const record = { kind: "dm", name: "对方昵称", openDingTalkId: peerId, dingTalkConversationId: cid, identityVersion: 1 };
  const { resolver, calls } = fixture({}, { byDingTalk: { [cid]: record } });
  const resolved = await resolver.resolveRecord(record);
  assert.equal(resolved.dm_peer_open_dingtalk_id, peerId);
  assert.equal(resolved.dm_direction, "unknown");
  assert.deepEqual(calls, []);
  assert.equal((await resolver.resolve(outgoing())).dm_peer_open_dingtalk_id, peerId);
  assert.deepEqual(calls, []);
});

test("正常自聊通过精确会话核实，不误标为收到他人的消息", async () => {
  const { resolver } = fixture();
  const resolved = await resolver.resolve(outgoing({ conversation_id: "cid-self" }));
  assert.equal(resolved.dm_peer_open_dingtalk_id, selfId);
  assert.equal(resolved.dm_peer_name, "本人");
  assert.equal(resolved.dm_direction, "unknown");
});

test("同一会话并发解析与后续事件共享核实结果，发送人查询不重复", async () => {
  const { resolver, calls } = fixture();
  const found = await Promise.all([resolver.resolve(outgoing()), resolver.resolve(outgoing())]);
  assert.equal(found.every((value) => value.dm_peer_open_dingtalk_id === peerId), true);
  await resolver.resolve(outgoing());
  assert.equal(calls.filter((args) => args.includes(selfId)).length, 1);
  assert.equal(calls.filter((args) => args.includes(peerId)).length, 1);
});

test("没有发送人 ID 的旧记录仍能通过实际会话与联系人核实", async () => {
  const { resolver } = fixture();
  const resolved = await resolver.resolveRecord({ kind: "dm", name: "错误标题", dingTalkConversationId: cid });
  assert.equal(resolved.dm_peer_open_dingtalk_id, peerId);
  assert.equal(resolved.dm_peer_name, "对方昵称");
  assert.equal(resolved.dm_direction, "unknown");
});

test("群会话响应和不一致的实际会话响应均不能作为私聊对象", async () => {
  for (const response of [
    { data: { success: true, result: { conversationInfo: { openConversationId: cid, singleChat: false, title: "群" } } } },
    info("wrong-cid", "对方昵称"),
  ]) {
    const { resolver } = fixture({ [`chat +conversation-info --group ${cid}`]: response });
    await assert.rejects(resolver.resolve(outgoing()), /私聊/);
  }
});

test("自身资料无法唯一匹配时方向未知，已核实的私聊对象仍保持正确", async () => {
  const { resolver } = fixture({
    "contact user search --query user-owner": result([
      { userId: "not-owner", openDingTalkId: peerId },
      { userId: "user-owner", openDingTalkId: selfId },
      { userId: "user-owner", openDingTalkId: "ambiguous-owner" },
    ]),
  });
  const resolved = await resolver.resolve(incoming());
  assert.equal(resolved.dm_peer_open_dingtalk_id, peerId);
  assert.equal(resolved.dm_direction, "unknown");
});

test("不同联系人 ID 都匹配同一会话时拒绝歧义结果，不缓存任意一个", async () => {
  let ambiguous = true;
  const { resolver, calls } = fixture({
    "contact user search --query 对方昵称": () => result(ambiguous
      ? [{ openDingTalkId: peerId }, { openDingTalkId: "open-duplicate" }, { openDingTalkId: peerId }]
      : [{ openDingTalkId: peerId }]),
    "chat +conversation-info --open-dingtalk-id open-duplicate": info(cid, "对方昵称"),
  });
  await assert.rejects(resolver.resolve(outgoing()), /唯一/);
  assert.equal(calls.filter((args) => args.includes(peerId)).length, 1);
  assert.equal(calls.filter((args) => args.includes("open-duplicate")).length, 1);
  ambiguous = false;
  assert.equal((await resolver.resolve(outgoing())).dm_peer_open_dingtalk_id, peerId);
  assert.equal(calls.filter((args) => args.includes("--group")).length, 2);
});

test("找到匹配后仍核验剩余候选，其他候选失败会保留重试而不缓存对方", async () => {
  let failed = true;
  const { resolver, calls } = fixture({
    "contact user search --query 对方昵称": result([{ openDingTalkId: peerId }, { openDingTalkId: "open-unavailable" }]),
    "chat +conversation-info --open-dingtalk-id open-unavailable": () => {
      if (failed) throw new Error("另一候选接口失败");
      return info("cid-other", "同名");
    },
  });
  await assert.rejects(resolver.resolve(outgoing()), /全部核实/);
  failed = false;
  assert.equal((await resolver.resolve(outgoing())).dm_peer_open_dingtalk_id, peerId);
  assert.equal(calls.filter((args) => args.includes("--group")).length, 2);
  assert.equal(calls.filter((args) => args.includes("open-unavailable")).length, 2);
});

test("真实入站机器人事件在已核实自身 ID 后不依赖跨组织个人资料权限", async () => {
  const { resolver, calls } = fixture({
    "chat +conversation-info --open-dingtalk-id open-bot": () => { throw new Error("CrossOrgPermissionDenied"); },
  });
  const event = incoming({ type: "user_im_message_receive_o2o_all", sender: "系统助手", sender_open_dingtalk_id: "open-bot" });
  const resolved = await resolver.resolve(event);
  assert.equal(resolved.dm_peer_open_dingtalk_id, "open-bot");
  assert.equal(resolved.dm_peer_name, "系统助手");
  assert.equal(resolved.dm_direction, "incoming");
  assert.equal(calls.some((args) => args[0] === "chat"), false);
  await resolver.resolve(event);
  assert.equal(calls.length, 2);
});

test("真实主动事件仍需精确会话校验，不会把自己当成快速入站对象", async () => {
  const { resolver, calls } = fixture();
  const resolved = await resolver.resolve(outgoing({ type: "user_im_message_receive_o2o_all" }));
  assert.equal(resolved.dm_peer_open_dingtalk_id, peerId);
  assert.equal(resolved.dm_direction, "outgoing");
  assert.equal(calls.some((args) => args.includes("--group")), true);
  assert.equal(calls.some((args) => args.includes(peerId)), true);
});

test("旧机器人映射不能通过实时入站快路径跳过核实", async () => {
  const { resolver } = fixture({
    "chat +conversation-info --open-dingtalk-id open-bot": () => { throw new Error("CrossOrgPermissionDenied"); },
  });
  await assert.rejects(resolver.resolveRecord({ kind: "dm", name: "系统助手", dingTalkConversationId: cid, openDingTalkId: "open-bot" }), /CrossOrg/);
});

test("自身身份失败时回退 CID 核验，并发失败不缓存错误对象，后续可恢复入站快路径", async () => {
  let failed = true;
  const { resolver, calls } = fixture({
    "contact user get-self": () => {
      if (failed) throw new Error("自身查询失败");
      return result({ userId: "user-owner" });
    },
    "chat +conversation-info --open-dingtalk-id open-bot": () => { throw new Error("CrossOrgPermissionDenied"); },
  });
  const event = incoming({ type: "user_im_message_receive_o2o_all", sender: "系统助手", sender_open_dingtalk_id: "open-bot" });
  const first = await Promise.allSettled([resolver.resolve(event), resolver.resolve(event)]);
  assert.equal(first.every((value) => value.status === "rejected"), true);
  assert.equal(calls.filter((args) => args.includes("get-self")).length, 1);
  assert.equal(calls.filter((args) => args.includes("open-bot")).length, 1);
  failed = false;
  assert.equal((await resolver.resolve(event)).dm_peer_open_dingtalk_id, "open-bot");
  assert.equal(calls.filter((args) => args.includes("get-self")).length, 2);
});

test("get-self 的真实数组员工结构可确认自身，并识别入站系统助手", async () => {
  const { resolver, calls } = fixture({
    "contact user get-self": result([{ isAdmin: false, orgEmployeeModel: { userId: "user-owner", name: "本人" } }]),
    "chat +conversation-info --open-dingtalk-id open-bot": () => { throw new Error("CrossOrgPermissionDenied"); },
  });
  const resolved = await resolver.resolve(incoming({ type: "user_im_message_receive_o2o_all", sender: "系统助手", sender_open_dingtalk_id: "open-bot" }));
  assert.equal(resolved.dm_peer_open_dingtalk_id, "open-bot");
  assert.equal(resolved.dm_direction, "incoming");
  assert.equal(calls.some((args) => args.includes("--query") && args.at(-1) === "user-owner"), true);
  assert.equal(calls.some((args) => args[0] === "chat"), false);
});

test("get-self 兼容对象及 orgUserId 结构，重复的同一 ID 不造成歧义", async () => {
  for (const own of [
    { orgEmployeeModel: { orgUserId: "user-owner" } },
    { orgUserId: "user-owner" },
    [{ userId: "user-owner", orgEmployeeModel: { userId: "user-owner" } }, { orgEmployeeModel: { orgUserId: "user-owner" } }],
  ]) {
    const { resolver } = fixture({ "contact user get-self": result(own) });
    const resolved = await resolver.resolve(incoming({ type: "user_im_message_receive_o2o_all" }));
    assert.equal(resolved.dm_direction, "incoming");
    assert.equal(resolved.dm_peer_open_dingtalk_id, peerId);
  }
});

test("get-self 返回不同用户 ID 时不能选择第一项或启用入站快路径", async () => {
  const { resolver, calls } = fixture({
    "contact user get-self": result([
      { orgEmployeeModel: { userId: "user-owner" } },
      { orgEmployeeModel: { orgUserId: "different-user" } },
    ]),
    "chat +conversation-info --open-dingtalk-id open-bot": () => { throw new Error("CrossOrgPermissionDenied"); },
  });
  await assert.rejects(resolver.resolve(incoming({ type: "user_im_message_receive_o2o_all", sender_open_dingtalk_id: "open-bot" })), /CrossOrg/);
  assert.equal(calls.some((args) => args[0] === "contact" && args.includes("search")), false);
});
