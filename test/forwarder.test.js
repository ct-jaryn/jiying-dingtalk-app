import assert from "node:assert/strict";
import test from "node:test";
import { createPushForwarder } from "../src/forwarder.js";

const event = (id = "message-1", conversation = "group-1") => ({
  message_id: id, conversation_id: conversation, content: "@我 请处理这条消息", sender: "同事",
});

function fixture(t, overrides = {}) {
  const state = overrides.state || { pending: [], delivered: {} };
  const snapshots = [];
  const sent = [];
  const forwarder = createPushForwarder({
    state,
    saveState: async (snapshot) => { snapshots.push(structuredClone(snapshot)); },
    render: (item) => [item.content],
    send: async (text, metadata) => { sent.push({ text, ...metadata }); },
    retryDelayMs: 60_000,
    maxRetryDelayMs: 60_000,
    ...overrides,
  });
  t.after(async () => { forwarder.stop(); await forwarder.waitForIdle(); });
  return { state, snapshots, sent, forwarder };
}

test("并发收到 @ 和群事件时只入队、投递一次", async (t) => {
  const { state, snapshots, sent, forwarder } = fixture(t);
  const received = event();
  const keys = await Promise.all([
    forwarder.enqueue({ ...received, type: "user_im_message_receive_at" }, "mention"),
    forwarder.enqueue({ ...received, type: "user_im_message_receive_group_all" }, "mention"),
  ]);
  assert.equal(keys[0], keys[1]);
  await forwarder.waitForIdle();
  assert.equal(sent.length, 1);
  assert.equal(snapshots[0].pending.length, 1);
  assert.equal(state.pending.length, 0);
  assert.equal(Object.keys(state.delivered).length, 1);
  await forwarder.enqueue(received, "mention");
  await forwarder.waitForIdle();
  assert.equal(sent.length, 1);
});

test("入队等待落盘但不等待网络发送，事件内容使用独立快照", async (t) => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const sent = [];
  const { forwarder, state } = fixture(t, {
    send: async (text) => { sent.push(text); await blocked; },
  });
  const received = event();
  await forwarder.enqueue(received, "mention");
  received.content = "随后被修改";
  assert.equal(state.pending.length, 1);
  release();
  await forwarder.waitForIdle();
  assert.deepEqual(sent, ["@我 请处理这条消息"]);
});

test("一次发送失败保留 pending，wake 后重新发送；失败消息不阻塞其他消息", async (t) => {
  const sent = [];
  let firstFails = true;
  const { state, forwarder } = fixture(t, {
    send: async (text, { event: item }) => {
      if (item.message_id === "first" && firstFails) throw new Error("即应离线");
      sent.push(item.message_id);
    },
  });
  await Promise.all([forwarder.enqueue(event("first"), "mention"), forwarder.enqueue(event("second"), "at-all")]);
  await forwarder.waitForIdle();
  assert.deepEqual(sent, ["second"]);
  assert.equal(state.pending.length, 1);
  assert.equal(state.pending[0].event.message_id, "first");
  assert.equal(Object.keys(state.delivered).length, 1);
  firstFails = false;
  forwarder.wake();
  await forwarder.waitForIdle();
  assert.deepEqual(sent, ["second", "first"]);
  assert.equal(state.pending.length, 0);
  assert.equal(Object.keys(state.delivered).length, 2);
});

test("从持久化 pending 恢复时继续投递，已完成事件不重发", async (t) => {
  const first = fixture(t, { send: async () => { throw new Error("离线"); } });
  await first.forwarder.enqueue(event(), "mention");
  await first.forwarder.waitForIdle();
  first.forwarder.stop();
  const recovered = structuredClone(first.state);
  const second = fixture(t, { state: recovered });
  second.forwarder.wake();
  await second.forwarder.waitForIdle();
  assert.equal(second.sent.length, 1);
  assert.equal(recovered.pending.length, 0);
  second.forwarder.stop();
  const third = fixture(t, { state: structuredClone(recovered) });
  await third.forwarder.enqueue(event(), "mention");
  await third.forwarder.waitForIdle();
  assert.equal(third.sent.length, 0);
});

test("中文长消息按分块进度恢复，不重发已确认分块", async (t) => {
  const parts = ["中文第一段".repeat(700), "中文第二段".repeat(700), "中文第三段".repeat(700)];
  const attempts = [];
  const first = fixture(t, {
    render: () => parts,
    send: async (text, { partIndex }) => {
      attempts.push(partIndex);
      if (partIndex === 1) throw new Error("发送第二段时断线");
      assert.equal(text, parts[partIndex]);
    },
  });
  await first.forwarder.enqueue(event(), "mention");
  await first.forwarder.waitForIdle();
  assert.deepEqual(attempts, [0, 1]);
  assert.equal(first.state.pending[0].nextPart, 1);
  assert.deepEqual(first.state.pending[0].parts, parts);
  first.forwarder.stop();
  const second = fixture(t, {
    state: structuredClone(first.state),
    render: () => { throw new Error("恢复时不应重新渲染"); },
  });
  second.forwarder.wake();
  await second.forwarder.waitForIdle();
  assert.deepEqual(second.sent.map((item) => item.partIndex), [1, 2]);
  assert.deepEqual(second.sent.map((item) => item.text), parts.slice(1));
});

test("索引更新失败不导致已成功投递的通知重发", async (t) => {
  let indexed = 0;
  const logs = [];
  const { forwarder, state, sent } = fixture(t, {
    onDelivered: async () => { indexed++; throw new Error("索引保存失败"); },
    onLog: (message) => { logs.push(message); },
  });
  await forwarder.enqueue(event(), "mention");
  await forwarder.waitForIdle();
  forwarder.wake();
  await forwarder.enqueue(event(), "mention");
  await forwarder.waitForIdle();
  assert.equal(sent.length, 1);
  assert.equal(indexed, 1);
  assert.equal(state.pending.length, 0);
  assert.match(logs.join("\n"), /索引失败/);
});

test("会话参与消息键，完成记录数量有界", async (t) => {
  const { forwarder, state, sent } = fixture(t, { maxDelivered: 2 });
  await forwarder.enqueue(event("same", "group-a"), "mention");
  await forwarder.enqueue(event("same", "group-b"), "mention");
  await forwarder.enqueue(event("third"), "mention");
  await forwarder.waitForIdle();
  assert.equal(sent.length, 3);
  assert.equal(Object.keys(state.delivered).length, 2);
});

test("无需重放事件即可在退避时间到达后自动重试", async (t) => {
  let calls = 0;
  const { forwarder, state } = fixture(t, {
    retryDelayMs: 5,
    maxRetryDelayMs: 10,
    send: async () => { if (++calls === 1) throw new Error("短暂离线"); },
  });
  await forwarder.enqueue(event(), "mention");
  await forwarder.waitForIdle();
  assert.equal(state.pending.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await forwarder.waitForIdle();
  assert.equal(calls, 2);
  assert.equal(state.pending.length, 0);
});

test("入队持久化失败时不发送，后续重放可以重新落盘投递", async (t) => {
  let fail = true;
  const { forwarder, sent, state } = fixture(t, {
    saveState: async () => { if (fail) throw new Error("存储不可用"); },
  });
  await assert.rejects(forwarder.enqueue(event(), "mention"), /存储不可用/);
  await forwarder.waitForIdle();
  assert.equal(sent.length, 0);
  assert.equal(state.pending.length, 0);
  fail = false;
  await forwarder.enqueue(event(), "mention");
  await forwarder.waitForIdle();
  assert.equal(sent.length, 1);
});

test("完成状态落盘失败后只重试提交，不重新发送已经确认的分块", async (t) => {
  let failCompletion = true;
  const { forwarder, sent, state } = fixture(t, {
    saveState: async (snapshot) => {
      if (failCompletion && Object.keys(snapshot.delivered).length) throw new Error("提交完成状态失败");
    },
  });
  await forwarder.enqueue(event(), "mention");
  await forwarder.waitForIdle();
  assert.equal(sent.length, 1);
  assert.equal(state.pending[0].nextPart, 1);
  assert.equal(Object.keys(state.delivered).length, 0);
  failCompletion = false;
  forwarder.wake();
  await forwarder.waitForIdle();
  assert.equal(sent.length, 1);
  assert.equal(state.pending.length, 0);
  assert.equal(Object.keys(state.delivered).length, 1);
});
