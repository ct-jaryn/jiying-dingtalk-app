import assert from "node:assert/strict";
import test from "node:test";
import { createMentionResolver } from "../src/mentions.js";

const event = (id = "message-1", group = "group-1") => ({
  type: "user_im_message_receive_group_all",
  message_id: id,
  conversation_id: group,
  content: "@其他同事 请处理（正文不用于判断提及对象）",
});
const record = (id = "message-1", group = "group-1") => ({
  messageId: id, conversationId: group, text: "@我 处理一下",
});
const complete = (items = []) => ({ items, complete: true, hasMore: false, partial: false, failures: [] });

function fixture(t, overrides = {}) {
  const state = overrides.state || { pending: [] };
  const snapshots = [];
  const mentions = [];
  const resolver = createMentionResolver({
    state,
    saveState: async (snapshot) => { snapshots.push(structuredClone(snapshot)); },
    fetchMentions: async () => complete(),
    onMention: async (item, match) => { mentions.push({ item, match }); },
    debounceMs: 0,
    retryDelaysMs: [60_000],
    settleAfterMs: 0,
    ...overrides,
  });
  t.after(async () => { resolver.stop(); await resolver.waitForIdle(); });
  return { state, snapshots, mentions, resolver };
}

async function until(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待解析结果超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("只按当前用户 @ 索引中的稳定消息 ID 匹配，不从正文猜测", async (t) => {
  const { resolver, mentions, state } = fixture(t, {
    fetchMentions: async () => complete([record("mine"), record("unrelated")]),
  });
  await Promise.all([
    resolver.enqueue({ ...event("mine"), content: "正文没有姓名" }),
    resolver.enqueue({ ...event("other"), content: "@我 @所有人 仅有正文，索引中未提及我" }),
  ]);
  await resolver.waitForIdle();
  assert.deepEqual(mentions.map(({ item }) => item.message_id), ["mine"]);
  assert.equal(state.pending.length, 0);
});

test("消息 ID 相同但会话不同不能误匹配", async (t) => {
  const { resolver, mentions, state } = fixture(t, {
    fetchMentions: async () => complete([record("message-1", "other-group")]),
  });
  await resolver.enqueue(event());
  await resolver.waitForIdle();
  assert.equal(mentions.length, 0);
  assert.equal(state.pending.length, 0);
});

test("兼容 messages 数组与嵌套 openConversationId", async (t) => {
  const { resolver, mentions } = fixture(t, {
    fetchMentions: async () => ({ messages: [{ messageId: "message-1", conversation: { openConversationId: "group-1" } }] }),
  });
  await resolver.enqueue(event());
  await resolver.waitForIdle();
  assert.equal(mentions.length, 1);
});

test("同消息同步双入只落盘并通知一次，完成后的重放也被去重", async (t) => {
  let lookups = 0;
  const { resolver, snapshots, mentions } = fixture(t, {
    fetchMentions: async () => { lookups++; return complete([record()]); },
  });
  const first = resolver.enqueue(event());
  const second = resolver.enqueue(event());
  assert.equal(first, second);
  await Promise.all([first, second]);
  await resolver.waitForIdle();
  await resolver.enqueue(event());
  await resolver.waitForIdle();
  assert.equal(lookups, 1);
  assert.equal(mentions.length, 1);
  assert.equal(snapshots[0].pending.length, 1);
});

test("同群短时到达的多条消息只查询一次且入队先落盘", async (t) => {
  let lookups = 0;
  const snapshots = [];
  const { resolver, mentions } = fixture(t, {
    debounceMs: 15,
    saveState: async (snapshot) => { snapshots.push(structuredClone(snapshot)); },
    fetchMentions: async (group, pendingEvents) => {
      lookups++;
      assert.equal(group, "group-1");
      assert.deepEqual(pendingEvents, [event("one"), event("two"), event("three")]);
      assert.equal(snapshots.at(-1).pending.length, 3);
      return complete([record("one"), record("two"), record("three")]);
    },
  });
  await Promise.all([resolver.enqueue(event("one")), resolver.enqueue(event("two")), resolver.enqueue(event("three"))]);
  await resolver.waitForIdle();
  assert.equal(lookups, 1);
  assert.equal(mentions.length, 3);
});

test("实时事件先到而 @ 索引延迟时，自动重试直到命中", async (t) => {
  let lookups = 0;
  const { resolver, mentions, state } = fixture(t, {
    settleAfterMs: 60_000,
    retryDelaysMs: [15],
    fetchMentions: async () => complete(++lookups === 1 ? [] : [record()]),
  });
  await resolver.enqueue(event());
  await resolver.waitForIdle();
  assert.equal(state.pending.length, 1);
  assert.equal(mentions.length, 0);
  await until(() => mentions.length === 1);
  await resolver.waitForIdle();
  assert.equal(lookups, 2);
  assert.equal(state.pending.length, 0);
});

test("查询失败以及分页、部分结果不完整时，即使超过沉淀时间也保留 pending", async (t) => {
  const results = [
    new Error("网络故障"),
    { ...complete(), hasMore: true, nextCursor: "next-page" },
    { ...complete(), partial: true, failures: [{ conversationId: "group-1" }] },
    { ...complete(), complete: false },
  ];
  let next = 0;
  const { resolver, state, mentions } = fixture(t, {
    fetchMentions: async () => {
      const result = results[next++];
      if (result instanceof Error) throw result;
      return result;
    },
  });
  await resolver.enqueue(event());
  await resolver.waitForIdle();
  assert.equal(state.pending.length, 1);
  for (let i = 1; i < results.length; i++) {
    await resolver.wake();
    await resolver.waitForIdle();
    assert.equal(state.pending.length, 1);
  }
  assert.equal(mentions.length, 0);
  assert.equal(state.pending[0].attempts, 4);
});

test("不完整结果中的确切命中仍可通知", async (t) => {
  const { resolver, mentions, state } = fixture(t, {
    fetchMentions: async () => ({ ...complete([record()]), hasMore: true, partial: true }),
  });
  await resolver.enqueue(event());
  await resolver.waitForIdle();
  assert.equal(mentions.length, 1);
  assert.equal(state.pending.length, 0);
});

test("超过沉淀时间且完整查询确认未提及时，清除普通群消息", async (t) => {
  let currentTime = 100;
  const { resolver, state, mentions } = fixture(t, {
    now: () => currentTime,
    settleAfterMs: 1000,
    fetchMentions: async () => complete(),
  });
  await resolver.enqueue(event());
  await resolver.waitForIdle();
  assert.equal(state.pending.length, 1);
  currentTime = 1100;
  await resolver.wake();
  await resolver.waitForIdle();
  assert.equal(state.pending.length, 0);
  assert.equal(mentions.length, 0);
});

test("重启后 wake 恢复已持久化的 pending", async (t) => {
  const first = fixture(t, { fetchMentions: async () => { throw new Error("离线"); } });
  await first.resolver.enqueue(event());
  await first.resolver.waitForIdle();
  first.resolver.stop();
  const recovered = structuredClone(first.state);
  const second = fixture(t, { state: recovered, fetchMentions: async () => complete([record()]) });
  await second.resolver.wake();
  await second.resolver.waitForIdle();
  assert.equal(second.mentions.length, 1);
  assert.equal(recovered.pending.length, 0);
});

test("通知接收失败保留已确认的提及，重试无需重新查询 @ 索引", async (t) => {
  let lookups = 0;
  let attempts = 0;
  const { resolver, state } = fixture(t, {
    fetchMentions: async () => { lookups++; return complete([record()]); },
    onMention: async () => { if (++attempts === 1) throw new Error("通知队列暂时不可用"); },
  });
  await resolver.enqueue(event());
  await resolver.waitForIdle();
  assert.ok(state.pending[0].match);
  await resolver.wake();
  await resolver.waitForIdle();
  assert.equal(lookups, 1);
  assert.equal(attempts, 2);
  assert.equal(state.pending.length, 0);
});

test("单群查询阻塞不影响其他群", async (t) => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const { resolver, mentions } = fixture(t, {
    fetchMentions: async (group) => {
      if (group === "slow") await blocked;
      return complete([record("message-1", group)]);
    },
  });
  await Promise.all([resolver.enqueue(event("message-1", "slow")), resolver.enqueue(event("message-1", "fast"))]);
  try {
    await until(() => mentions.some(({ item }) => item.conversation_id === "fast"));
    assert.equal(mentions.length, 1);
  } finally { release(); }
  await resolver.waitForIdle();
  assert.equal(mentions.length, 2);
});

test("入队落盘失败时不查询、不通知，之后可重放", async (t) => {
  let fail = true;
  let lookups = 0;
  const { resolver, state, mentions } = fixture(t, {
    saveState: async () => { if (fail) throw new Error("磁盘不可用"); },
    fetchMentions: async () => { lookups++; return complete([record()]); },
  });
  await assert.rejects(resolver.enqueue(event()), /磁盘不可用/);
  await resolver.waitForIdle();
  assert.equal(lookups, 0);
  assert.equal(state.pending.length, 0);
  fail = false;
  await resolver.enqueue(event());
  await resolver.waitForIdle();
  assert.equal(mentions.length, 1);
});

test("stop 取消待执行的查询并保留 pending", async (t) => {
  let lookups = 0;
  const { resolver, state } = fixture(t, {
    debounceMs: 60_000,
    fetchMentions: async () => { lookups++; return complete([record()]); },
  });
  await resolver.enqueue(event());
  resolver.stop();
  await resolver.waitForIdle();
  assert.equal(lookups, 0);
  assert.equal(state.pending.length, 1);
});


test("真实查询已结束时保留的 nextCursor 不阻止清理普通群消息", async (t) => {
  for (const flags of [
    { complete: true, hasMore: false },
    { hasMore: false },
    { complete: true },
  ]) {
    const { resolver, state, mentions } = fixture(t, {
      fetchMentions: async () => ({ items: [], partial: false, failures: [], nextCursor: "last-page-cursor", ...flags }),
    });
    await resolver.enqueue(event());
    await resolver.waitForIdle();
    assert.equal(state.pending.length, 0, JSON.stringify(flags));
    assert.equal(mentions.length, 0);
  }
});

test("complete:true 与 hasMore:true 冲突时仍保留 pending", async (t) => {
  const { resolver, state } = fixture(t, {
    fetchMentions: async () => ({ items: [], complete: true, hasMore: true, nextCursor: "next-page" }),
  });
  await resolver.enqueue(event());
  await resolver.waitForIdle();
  assert.equal(state.pending.length, 1);
});

test("缺省终止信号而 nextCursor 非空时保留 pending", async (t) => {
  const { resolver, state } = fixture(t, {
    fetchMentions: async () => ({ items: [], nextCursor: "maybe-next-page" }),
  });
  await resolver.enqueue(event());
  await resolver.waitForIdle();
  assert.equal(state.pending.length, 1);
});


test("新到的同群事件立即触发新批次，不等待旧事件的长重试", { timeout: 1000 }, async (t) => {
  const batches = [];
  const { resolver, state, mentions } = fixture(t, {
    settleAfterMs: 120_000,
    retryDelaysMs: [60_000],
    fetchMentions: async (group, pendingEvents) => {
      batches.push(pendingEvents.map((item) => item.message_id));
      return complete(batches.length === 1 ? [] : [record("old"), record("new")]);
    },
  });
  await resolver.enqueue(event("old"));
  await resolver.waitForIdle();
  assert.equal(state.pending.length, 1);
  await resolver.enqueue(event("new"));
  await resolver.waitForIdle();
  assert.deepEqual(batches, [["old"], ["old", "new"]]);
  assert.equal(mentions.length, 2);
  assert.equal(state.pending.length, 0);
});
