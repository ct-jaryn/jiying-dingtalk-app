import assert from "node:assert/strict";
import test from "node:test";
import { createMentionLookup } from "../src/mention-source.js";
import { createMentionResolver } from "../src/mentions.js";

const clock = Date.parse("2026-10-29T15:00:00+08:00");
const event = (id) => ({ type: "user_im_message_receive_group_all", message_id: id, conversation_id: "muted", event_time: clock });
const record = (id) => ({ messageId: id, conversationId: "muted" });
const more = (cursor, items = []) => ({ items, complete: false, hasMore: true, nextCursor: cursor });
const end = (items = []) => ({ items, complete: true, hasMore: false });

test("持续首页新提及仍推进续页，免打扰群的旧提及不会一直积压", async (t) => {
  const state = { pending: [] };
  const notified = [];
  const calls = [];
  let batch = 1;
  const lookup = createMentionLookup({ now: () => clock, queryPage: async ({ cursor }) => {
    calls.push(cursor);
    if (cursor === "0") return more("page-two", [record(`fresh-${batch}`)]);
    return end([record("old")]);
  } });
  const resolver = createMentionResolver({
    state, now: () => clock, saveState: async () => {}, forwardGroup: async () => false,
    fetchMentions: lookup, onMention: async (received) => { notified.push(received.message_id); },
    debounceMs: 0, retryDelaysMs: [60_000],
  });
  t.after(async () => { resolver.stop(); await resolver.waitForIdle(); });
  await Promise.all([resolver.enqueue(event("old")), resolver.enqueue(event("fresh-1"))]);
  await resolver.waitForIdle();
  assert.deepEqual(notified, ["fresh-1"], "首页的新提及首先送达");
  assert.deepEqual(calls, ["0"], "首次首页命中不等待续页");
  batch = 2;
  await resolver.enqueue(event("fresh-2"));
  await resolver.waitForIdle();
  assert.deepEqual(calls, ["0", "0", "page-two"]);
  assert.ok(notified.includes("old"));
  assert.ok(notified.includes("fresh-2"));
  assert.equal(state.pending.length, 0);
  assert.equal(new Set(notified).size, notified.length);
});

test("一页预算交替刷新首页和续页，查询次数不超预算且最终命中深页", async () => {
  const calls = [];
  const pages = { "0": more("one"), one: more("two"), two: end([record("old")]) };
  const lookup = createMentionLookup({ now: () => clock, maxPagesPerRun: 1, queryPage: async ({ cursor }) => {
    calls.push(cursor); return pages[cursor];
  } });
  let result;
  for (let attempt = 0; attempt < 4; attempt++) {
    const before = calls.length;
    result = await lookup("muted", [event("old")]);
    assert.equal(calls.length - before, 1);
    if (attempt < 3) assert.equal(result.complete, false);
  }
  assert.deepEqual(calls, ["0", "one", "0", "two"]);
  assert.deepEqual(result.items.map((item) => item.messageId), ["old"]);
  assert.equal(result.complete, true);
});

test("连续首页命中后的续页失败仍保留已确认命中并重试原游标", async () => {
  let batch = 1;
  let broken = true;
  const calls = [];
  const lookup = createMentionLookup({ now: () => clock, maxPagesPerRun: 2, queryPage: async ({ cursor }) => {
    calls.push(cursor);
    if (cursor === "0") return more("next", [record(`fresh-${batch}`)]);
    if (broken) throw new Error("fixture page failure");
    return end([record("old")]);
  } });
  const first = await lookup("muted", [event("old"), event("fresh-1")]);
  assert.equal(first.complete, false);
  batch = 2;
  const second = await lookup("muted", [event("old"), event("fresh-2")]);
  assert.equal(second.complete, false);
  assert.equal(second.partial, true);
  assert.deepEqual(second.items.map((item) => item.messageId), ["fresh-2"]);
  assert.equal(second.failures.length, 1);
  broken = false;
  batch = 3;
  const third = await lookup("muted", [event("old"), event("fresh-3")]);
  assert.deepEqual(calls, ["0", "0", "next", "0", "next"]);
  assert.equal(third.complete, true);
  assert.deepEqual(new Set(third.items.map((item) => item.messageId)), new Set(["fresh-3", "old"]));
});

test("续页部分响应不能令旧事件被完整扫描排除", async () => {
  let batch = 1;
  const lookup = createMentionLookup({ now: () => clock, queryPage: async ({ cursor }) => {
    if (cursor === "0") return more("next", [record(`fresh-${batch}`)]);
    return { ...end(), partial: true };
  } });
  await lookup("muted", [event("old"), event("fresh-1")]);
  batch = 2;
  const result = await lookup("muted", [event("old"), event("fresh-2")]);
  assert.equal(result.complete, false);
  assert.equal(result.partial, true);
  assert.deepEqual(result.items.map((item) => item.messageId), ["fresh-2"]);
});

test("一页预算遇到续页故障时仍刷新首页，恢复后重试同一续页", async () => {
  let batch = 1;
  let broken = true;
  const calls = [];
  const lookup = createMentionLookup({ now: () => clock, maxPagesPerRun: 1, queryPage: async ({ cursor }) => {
    calls.push(cursor);
    if (cursor === "0") return more("next", [record(`fresh-${batch}`)]);
    if (broken) throw new Error("fixture continuation offline");
    return end([record("old")]);
  } });
  const run = () => lookup("muted", [event("old"), event(`fresh-${batch}`)]);
  await run();
  batch = 2;
  assert.equal((await run()).partial, true);
  batch = 3;
  const fresh = await run();
  assert.deepEqual(fresh.items.map((item) => item.messageId), ["fresh-3"]);
  broken = false;
  batch = 4;
  const recovered = await run();
  assert.deepEqual(calls, ["0", "next", "0", "next"]);
  assert.deepEqual(recovered.items.map((item) => item.messageId), ["old"]);
  assert.equal(recovered.complete, false, "未刷新首页的新消息仍应保持待核对");
});
