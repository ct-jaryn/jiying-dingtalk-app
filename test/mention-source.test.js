import test from "node:test";
import assert from "node:assert/strict";
import { createMentionLookup } from "../src/mention-source.js";

const clock = Date.parse("2026-10-21T10:00:00+08:00");
const event = (id, time = clock) => ({ message_id: id, conversation_id: "group", event_time: time });
const record = (id, group = "group") => ({ messageId: id, conversationId: group, text: "fixture" });
const end = (items = []) => ({ items, complete: true, hasMore: false, nextCursor: "last-page-is-not-empty" });
const more = (cursor, items = []) => ({ items, complete: false, hasMore: true, nextCursor: cursor });

test("continues beyond 300 records while refreshing the first page each time", async () => {
  const calls = [];
  const pages = {
    "0": more("100", Array.from({ length: 100 }, (_, n) => record(String(n)))),
    "100": more("200", Array.from({ length: 100 }, (_, n) => record(String(n + 100)))),
    "200": more("300", Array.from({ length: 100 }, (_, n) => record(String(n + 200)))),
    "300": end([record("target")]),
  };
  const lookup = createMentionLookup({ now: () => clock, queryPage: async ({ cursor }) => {
    calls.push(cursor);
    return pages[cursor];
  } });
  const first = await lookup("group", [event("target")]);
  assert.deepEqual(first.items, []);
  assert.equal(first.complete, false);
  assert.equal(first.hasMore, true);
  const second = await lookup("group", [event("target")]);
  assert.deepEqual(second.items.map((item) => item.messageId), ["target"]);
  assert.equal(second.complete, true);
  assert.equal(second.hasMore, false);
  assert.deepEqual(calls, ["0", "100", "200", "0", "300"]);
  await lookup("group", [event("other")]);
  assert.deepEqual(calls.slice(5), ["0", "100", "200"]);
});

test("old pending events expand the window and timezone-free timestamps use China time", async () => {
  const calls = [];
  const lookup = createMentionLookup({ now: () => clock, queryPage: async (args) => { calls.push(args); return end(); } });
  await lookup("group", [{ message_id: "old", create_time: "2026-10-19 09:59:59" }]);
  assert.equal(calls.at(-1).days, 3);
  await lookup("group", [{ message_id: "boundary", timestamp: "2026-10-20T10:00:00" }]);
  assert.equal(calls.at(-1).days, 2);
  await lookup("group", [{ message_id: "seconds", event_time: (clock - 4 * 86_400_000) / 1000 }]);
  assert.equal(calls.at(-1).days, 5);
  const ancient = await lookup("group", [event("ancient", clock - 4000 * 86_400_000)]);
  assert.equal(calls.at(-1).days, 3650);
  assert.equal(ancient.complete, false);
  assert.equal(ancient.partial, true);
});

test("a delayed index match on the refreshed home page returns before more paging", async () => {
  let homes = 0;
  const calls = [];
  const lookup = createMentionLookup({ now: () => clock, queryPage: async ({ cursor }) => {
    calls.push(cursor);
    if (cursor === "0") return more("one", ++homes === 1 ? [] : [record("late")]);
    if (cursor === "one") return more("two");
    if (cursor === "two") return more("three");
    return end();
  } });
  await lookup("group", [event("late"), event("ordinary")]);
  const result = await lookup("group", [event("late"), event("ordinary")]);
  assert.deepEqual(calls, ["0", "one", "two", "0"]);
  assert.deepEqual(result.items.map((item) => item.messageId), ["late"]);
  assert.equal(result.partial, true);
  assert.equal(result.complete, false);
  await lookup("group", [event("ordinary")]);
  assert.deepEqual(calls.slice(4), ["0", "three"]);
});

test("later page failure preserves matches and retries the failed cursor", async () => {
  let fail = true;
  const calls = [];
  const lookup = createMentionLookup({ now: () => clock, queryPage: async ({ cursor }) => {
    calls.push(cursor);
    if (cursor === "0") return more("next", [record("confirmed"), record("unwanted")]);
    if (fail) throw Object.assign(new Error("temporary failure"), { code: "TEMPORARY" });
    return end();
  } });
  const pending = [event("confirmed"), event("unresolved")];
  const immediate = await lookup("group", pending);
  assert.deepEqual(immediate.items.map((item) => item.messageId), ["confirmed"]);
  const failed = await lookup("group", pending);
  assert.equal(failed.complete, false);
  assert.equal(failed.partial, true);
  assert.equal(failed.failures[0].code, "TEMPORARY");
  assert.deepEqual(failed.items.map((item) => item.messageId), ["confirmed"]);
  fail = false;
  assert.equal((await lookup("group", pending)).complete, true);
  assert.deepEqual(calls, ["0", "0", "next", "0", "next"]);
});

test("partial and failure markers override a terminal page and preserve exact matches", async () => {
  for (const marker of [{ partial: true }, { failures: [{ code: "SOURCE_FAILED" }] }, { failedCount: 1 }, { complete: false }]) {
    const lookup = createMentionLookup({ now: () => clock, queryPage: async () => ({
      ...end([record("wanted"), record("wrong-group", "elsewhere"), record("not-pending")]), ...marker,
    }) });
    const result = await lookup("group", [event("wanted"), event("wrong-group")]);
    assert.equal(result.complete, false);
    assert.equal(result.partial, true);
    assert.deepEqual(result.items.map((item) => item.messageId), ["wanted"]);
  }
});

test("explicit terminal flags ignore a leftover cursor", async () => {
  for (const flags of [{ hasMore: false }, { complete: true }]) {
    const lookup = createMentionLookup({ now: () => clock, queryPage: async () => ({ items: [], nextCursor: "opaque", ...flags }) });
    assert.deepEqual(await lookup("group", [event("absent")]), {
      items: [], complete: true, hasMore: false, partial: false, failures: [],
    });
  }
});

test("repeated cursors stop conservatively, including cycles spanning lookup calls", async () => {
  const calls = [];
  const lookup = createMentionLookup({ now: () => clock, queryPage: async ({ cursor }) => {
    calls.push(cursor);
    return more({ "0": "one", one: "two", two: "three", three: "one" }[cursor]);
  } });
  assert.equal((await lookup("group", [event("absent")])).partial, false);
  const result = await lookup("group", [event("absent")]);
  assert.equal(result.partial, true);
  assert.equal(result.complete, false);
  assert.equal(result.failures[0].code, "CURSOR_CYCLE");
  assert.deepEqual(calls, ["0", "one", "two", "0", "three"]);
});

test("groups retain independent cursors and a changed window restarts scanning", async () => {
  const calls = [];
  const lookup = createMentionLookup({ now: () => clock, maxPagesPerRun: 2, queryPage: async (args) => {
    calls.push(args);
    return more(args.cursor === "0" ? "one" : "two");
  } });
  await lookup("group", [event("a")]);
  await lookup("another", [event("b")]);
  await lookup("group", [event("a", clock - 2 * 86_400_000)]);
  assert.deepEqual(calls.map(({ groupId, days, cursor }) => [groupId, days, cursor]), [
    ["group", 1, "0"], ["group", 1, "one"],
    ["another", 1, "0"], ["another", 1, "one"],
    ["group", 3, "0"], ["group", 3, "one"],
  ]);
});

test("an ID added midway through scanning cannot be excluded by unsearched earlier pages", async () => {
  const calls = [];
  const lookup = createMentionLookup({ now: () => clock, maxPagesPerRun: 2, queryPage: async ({ cursor }) => {
    calls.push(cursor);
    if (cursor === "0") return more("one");
    if (cursor === "one") return more("two", [record("new")]);
    return end();
  } });
  await lookup("group", [event("old")]);
  const incomplete = await lookup("group", [event("old"), event("new")]);
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.partial, true);
  const recovered = await lookup("group", [event("old"), event("new")]);
  assert.deepEqual(recovered.items.map((item) => item.messageId), ["new"]);
  assert.deepEqual(calls, ["0", "one", "0", "two", "0", "one"]);
});
