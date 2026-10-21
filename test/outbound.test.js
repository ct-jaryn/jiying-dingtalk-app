import assert from "node:assert/strict";
import test from "node:test";
import { createOutboundGuard } from "../src/outbound.js";

const event = (messageId = "msgSENT", conversationId = "cidGROUP") => ({
  message_id: messageId, conversation_id: conversationId, content: "相同正文", sender: "我",
});
const receipt = (messageId = "msgSENT", conversationId = "cidGROUP") => ({
  data: { delivery: { messageId, conversationId } },
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(overrides = {}) {
  const state = { sent: {} };
  const snapshots = [];
  const logs = [];
  const guard = createOutboundGuard({
    state,
    saveState: async (snapshot) => { snapshots.push(snapshot); },
    onLog: (message) => { logs.push(message); },
    ...overrides,
  });
  return { state, snapshots, logs, guard };
}

test("同步注册发送屏障，回执先于事件处理完成时精确过滤", async () => {
  const { guard } = fixture();
  let echoed;
  const result = receipt();
  const actual = await guard.send(() => {
    echoed = guard.isSent(event());
    return result;
  }, { conversationId: "cidGROUP" });
  assert.equal(actual, result);
  assert.equal(await echoed, true);
});

test("事件先于较晚的发送回执到达时等待该次发送", async () => {
  const { guard } = fixture();
  const sending = deferred();
  const sent = guard.send(() => sending.promise, { conversationId: "cidGROUP" });
  let checked = false;
  const echoed = guard.isSent(event()).then((value) => { checked = true; return value; });
  await Promise.resolve();
  assert.equal(checked, false);
  sending.resolve(receipt());
  await sent;
  assert.equal(await echoed, true);
});

test("同正文、同发送人但不同消息 ID 的真实新消息不会被过滤", async () => {
  const { guard } = fixture();
  await guard.send(() => receipt(), { conversationId: "cidGROUP" });
  assert.equal(await guard.isSent(event("msgOTHER")), false);
  assert.equal(await guard.isSent({ ...event(), message_id: "" }), false);
});

test("已知会话中相同消息 ID 不会误伤另一会话", async () => {
  const { guard } = fixture();
  await guard.send(() => receipt(), { conversationId: "cidGROUP" });
  assert.equal(await guard.isSent(event("msgSENT", "cidOTHER")), false);
  assert.equal(await guard.isSent(event()), true);
});

test("另一会话的未完成发送不会阻塞事件", async () => {
  const { guard } = fixture();
  const sending = deferred();
  const sent = guard.send(() => sending.promise, { conversationId: "cidOTHER" });
  assert.equal(await guard.isSent(event()), false);
  sending.resolve(receipt("msgSENT", "cidOTHER"));
  await sent;
});

test("未知发送目标同样等待回执，得到真实会话后不跨群过滤", async () => {
  const { guard } = fixture();
  const sending = deferred();
  const sent = guard.send(() => sending.promise);
  const ownEcho = guard.isSent(event());
  const otherGroup = guard.isSent(event("msgSENT", "cidOTHER"));
  sending.resolve(receipt());
  await sent;
  assert.equal(await ownEcho, true);
  assert.equal(await otherGroup, false);
});

test("仅缺会话 ID 的发送回执可按消息 ID wildcard 匹配", async () => {
  const { guard } = fixture();
  await guard.send(() => ({ data: { messageId: "msgUNKNOWN" } }));
  assert.equal(await guard.isSent(event("msgUNKNOWN", "cidONE")), true);
  assert.equal(await guard.isSent(event("msgUNKNOWN", "cidTWO")), true);
  assert.equal(await guard.isSent(event("msgOTHER", "cidONE")), false);
});

test("回执缺会话时使用预先解析的发送目标", async () => {
  const { guard } = fixture();
  await guard.send(() => ({ data: { messageId: "msgSENT" } }), { conversationId: "cidGROUP" });
  assert.equal(await guard.isSent(event()), true);
  assert.equal(await guard.isSent(event("msgSENT", "cidOTHER")), false);
});

test("发送失败释放屏障并保留原始异常", async () => {
  const { guard, state } = fixture();
  const sending = deferred();
  const failure = new Error("发送失败");
  const sent = guard.send(() => sending.promise, { conversationId: "cidGROUP" });
  const rejected = assert.rejects(sent, (error) => error === failure);
  const incoming = guard.isSent(event());
  sending.reject(failure);
  await rejected;
  assert.equal(await incoming, false);
  assert.deepEqual(state.sent, {});
  await guard.waitForIdle();
});

test("同步抛出的发送异常也会释放屏障", async () => {
  const { guard } = fixture();
  await assert.rejects(guard.send(() => { throw new Error("spawn failed"); }), /spawn failed/);
  assert.equal(await guard.isSent(event()), false);
  await guard.waitForIdle();
});

test("保存失败不改变真实发送成功结果，内存仍能过滤回流", async () => {
  let calls = 0;
  const { guard, logs } = fixture({ saveState: async () => { throw new Error("磁盘故障"); } });
  const result = receipt();
  assert.equal(await guard.send(() => { calls++; return result; }), result);
  assert.equal(calls, 1);
  assert.equal(await guard.isSent(event()), true);
  assert.match(logs.join("\n"), /保存出站回执失败/);
  await guard.waitForIdle();
});

test("落盘尚未完成时，回执已立即在内存生效", async () => {
  const saving = deferred();
  const { guard } = fixture({ saveState: () => saving.promise });
  const sent = guard.send(() => receipt());
  await Promise.resolve();
  assert.equal(await guard.isSent(event()), true);
  saving.resolve();
  await sent;
});

test("保存独立快照并串行写入，失败后后续写入可以恢复", async () => {
  const firstSave = deferred();
  const snapshots = [];
  let saves = 0;
  const { guard } = fixture({
    saveState: async (snapshot) => {
      snapshots.push(snapshot);
      if (++saves === 1) await firstSave.promise;
    },
  });
  const first = guard.send(() => receipt("msgONE"));
  const second = guard.send(() => receipt("msgTWO"));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(snapshots.length, 1);
  assert.equal(Object.keys(snapshots[0].sent).length, 1);
  firstSave.reject(new Error("一次保存失败"));
  await Promise.all([first, second]);
  assert.equal(snapshots.length, 2);
  assert.equal(Object.keys(snapshots[1].sent).length, 2);
});

test("持久化回执恢复后仍然过滤，并按时间有界保留记录", async () => {
  let time = 100;
  const first = fixture({ now: () => time++, maxEntries: 2 });
  await first.guard.send(() => receipt("msgOLD"));
  await first.guard.send(() => receipt("msgKEEP"));
  await first.guard.send(() => receipt("msgNEW"));
  const snapshot = first.snapshots.at(-1);
  assert.equal(Object.keys(snapshot.sent).length, 2);
  const restored = fixture({ state: structuredClone(snapshot), maxEntries: 2 });
  assert.equal(await restored.guard.isSent(event("msgOLD")), false);
  assert.equal(await restored.guard.isSent(event("msgKEEP")), true);
  assert.equal(await restored.guard.isSent(event("msgNEW")), true);
});

test("缺少实际发送 ID 时不会把 quoted source 登记为出站", async () => {
  const { guard, state } = fixture();
  await guard.send(() => ({ data: {
    referencedMessage: { messageId: "msgSOURCE", conversationId: "cidGROUP" },
  } }), { conversationId: "cidGROUP" });
  assert.equal(await guard.isSent(event("msgSOURCE")), false);
  assert.deepEqual(state.sent, {});
});

test("事件只等待到达时的在途发送快照，不追逐后续发送", async () => {
  const { guard } = fixture();
  const firstResult = deferred();
  const secondResult = deferred();
  const first = guard.send(() => firstResult.promise, { conversationId: "cidGROUP" });
  const incoming = guard.isSent(event("msgUNRELATED"));
  const second = guard.send(() => secondResult.promise, { conversationId: "cidGROUP" });
  firstResult.resolve(receipt("msgFIRST"));
  await first;
  assert.equal(await incoming, false);
  secondResult.resolve(receipt("msgSECOND"));
  await second;
});
