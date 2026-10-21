/**
 * Resolve @-me metadata for messages received from the group event stream.
 * The personal @ index may lag behind the live event; pending events are saved
 * before lookup and retried until a complete index can safely exclude them.
 */
export function createMentionResolver({
  state = { pending: [] },
  saveState,
  fetchMentions,
  onMention,
  onLog = () => {},
  debounceMs = 250,
  retryDelaysMs = [1000, 3000, 10_000, 30_000],
  settleAfterMs = 120_000,
  now = Date.now,
}) {
  if (!Array.isArray(state.pending)) throw new TypeError("提及状态必须包含 pending 数组");
  if (typeof saveState !== "function" || typeof fetchMentions !== "function" || typeof onMention !== "function") {
    throw new TypeError("提及解析器需要 saveState、fetchMentions 和 onMention");
  }
  const delays = retryDelaysMs.length ? retryDelaysMs.map((delay) => Math.max(1, Number(delay) || 1)) : [30_000];
  const reservations = new Map();
  const recent = new Map();
  const retryAt = new Map();
  const acknowledged = new Set();
  const timers = new Map();
  const running = new Map();
  const rerun = new Set();
  let storage = Promise.resolve();
  let stopped = false;

  function log(message, error) {
    try { onLog(message, error); } catch { /* Logging must not interrupt lookup. */ }
  }

  function groupFor(event) {
    return String(event.conversation_id || "");
  }

  function keyFor(event) {
    const id = event?.message_id || event?.event_id;
    if (!id) throw new Error("群消息事件缺少 message_id 或 event_id");
    return JSON.stringify(["dingtalk", groupFor(event), String(id)]);
  }

  function change(update) {
    const operation = storage.then(async () => {
      const draft = structuredClone(state);
      update(draft);
      await saveState(draft);
      state.pending = draft.pending;
    });
    storage = operation.catch(() => {});
    return operation;
  }

  function entryFor(key) {
    return state.pending.find((item) => item.key === key);
  }

  function clearTimer(group) {
    const scheduled = timers.get(group);
    if (!scheduled) return;
    clearTimeout(scheduled.timer);
    timers.delete(group);
    scheduled.resolve();
  }

  function schedule(group, deadline, incoming = false) {
    if (stopped) return;
    const existing = timers.get(group);
    if (existing && existing.deadline <= deadline) {
      existing.incoming ||= incoming;
      if (existing.incoming) existing.timer.ref?.();
      return;
    }
    incoming ||= existing?.incoming || false;
    clearTimer(group);
    let resolve;
    const done = new Promise((finish) => { resolve = finish; });
    const scheduled = { deadline, incoming, done, resolve };
    scheduled.timer = setTimeout(() => {
      if (timers.get(group) !== scheduled) return;
      timers.delete(group);
      start(group);
      resolve();
    }, Math.max(0, Math.min(2_147_483_647, deadline - now())));
    if (!incoming) scheduled.timer.unref?.();
    timers.set(group, scheduled);
  }

  function scheduleRemaining(group) {
    const pending = state.pending.filter((item) => groupFor(item.event) === group);
    if (!pending.length) {
      clearTimer(group);
      return;
    }
    const deadline = Math.min(...pending.map((item) => Math.max(Number(item.nextAttemptAt) || 0, retryAt.get(item.key) || 0)));
    schedule(group, deadline);
  }

  async function remove(key) {
    await change((draft) => { draft.pending = draft.pending.filter((item) => item.key !== key); });
    retryAt.delete(key);
    acknowledged.delete(key);
    reservations.delete(key);
    recent.set(key, now());
    // The durable notification forwarder owns long-term delivery deduplication.
    // Bound the live stream duplicate cache so ordinary group traffic cannot leak memory.
    if (recent.size > 10_000) recent.delete(recent.keys().next().value);
  }

  async function defer(key, complete) {
    const current = entryFor(key);
    if (!current) return;
    const attempts = (Number(current.attempts) || 0) + 1;
    let delay = delays[Math.min(attempts - 1, delays.length - 1)];
    if (complete) delay = Math.min(delay, Math.max(1, Number(current.firstSeenAt) + settleAfterMs - now()));
    const nextAttemptAt = now() + delay;
    // A failed disk write must not create an immediate retry loop.
    retryAt.set(key, nextAttemptAt);
    await change((draft) => {
      const item = draft.pending.find((pending) => pending.key === key);
      if (item) Object.assign(item, { attempts, nextAttemptAt });
    });
  }

  function unpack(result) {
    const items = result?.items ?? result?.messages;
    if (!Array.isArray(items)) throw new TypeError("@我的消息查询缺少 items 或 messages 数组");
    const failures = result.failures;
    const failed = Array.isArray(failures) ? failures.length > 0 : failures && Object.keys(failures).length > 0;
    // The service may return the last page cursor even after pagination ends.
    // Explicit completion wins over that cursor, but never over partial/failure
    // markers or a conflicting hasMore:true response.
    const ended = result.hasMore === false || result.complete === true;
    const complete = result.complete !== false && !result.partial && result.hasMore !== true && !failed && (ended || !result.nextCursor);
    return { items, complete };
  }

  function matches(item, record) {
    const id = record?.messageId ?? record?.message_id;
    const eventId = item.event.message_id || item.event.event_id;
    if (id == null || String(id) !== String(eventId)) return false;
    const group = record.conversationId || record.conversation_id || record.conversation?.openConversationId;
    return !group || !groupFor(item.event) || String(group) === groupFor(item.event);
  }

  async function deliver(item, record) {
    if (!item.match) {
      await change((draft) => {
        const current = draft.pending.find((pending) => pending.key === item.key);
        if (current) current.match = structuredClone(record);
      });
    }
    if (stopped) return;
    if (!acknowledged.has(item.key)) {
      await onMention(item.event, record);
      acknowledged.add(item.key);
    }
    await remove(item.key);
  }

  async function processGroup(group) {
    const batch = state.pending.filter((item) => groupFor(item.event) === group);
    if (!batch.length || stopped) return;
    let result;
    let lookupError;
    if (batch.some((item) => !item.match)) {
      try { result = unpack(await fetchMentions(group, batch.map((item) => item.event))); }
      catch (error) { lookupError = error; log("查询群消息提及失败，将重试已收到的事件", error); }
    }
    for (const original of batch) {
      if (stopped) return;
      const item = entryFor(original.key);
      if (!item) continue;
      const record = item.match || result?.items.find((candidate) => matches(item, candidate));
      try {
        if (record) {
          await deliver(item, record);
        } else if (!lookupError && result?.complete && now() - Number(item.firstSeenAt) >= settleAfterMs) {
          await remove(item.key);
        } else {
          await defer(item.key, !lookupError && result?.complete);
        }
      } catch (error) {
        log("保存或转发群提及失败，将重试", error);
        try { await defer(item.key, false); }
        catch (saveError) { log("保存群提及重试进度失败", saveError); }
      }
    }
  }

  function start(group) {
    if (stopped) return;
    if (running.has(group)) {
      rerun.add(group);
      return;
    }
    const work = Promise.resolve().then(() => processGroup(group)).catch((error) => {
      log("群提及解析失败", error);
    }).finally(() => {
      running.delete(group);
      if (stopped) return;
      if (rerun.delete(group)) schedule(group, now(), true);
      else scheduleRemaining(group);
    });
    running.set(group, work);
  }

  function enqueue(event) {
    if (stopped) return Promise.reject(new Error("提及解析器已停止"));
    let key;
    let snapshot;
    try {
      key = keyFor(event);
      if (reservations.has(key)) return reservations.get(key);
      if (recent.has(key) || entryFor(key)) return Promise.resolve(key);
      snapshot = structuredClone(event);
    } catch (error) { return Promise.reject(error); }
    const firstSeenAt = now();
    const nextAttemptAt = firstSeenAt + Math.max(0, debounceMs);
    const accepted = change((draft) => {
      draft.pending.push({ key, event: snapshot, firstSeenAt, attempts: 0, nextAttemptAt });
    }).then(() => {
      schedule(groupFor(snapshot), nextAttemptAt, true);
      return key;
    }, (error) => {
      reservations.delete(key);
      throw error;
    });
    // Reserve synchronously: duplicate live subscriptions may enter together.
    reservations.set(key, accepted);
    return accepted;
  }

  async function wake() {
    await storage;
    if (stopped) return;
    for (const item of state.pending) retryAt.delete(item.key);
    for (const group of new Set(state.pending.map((item) => groupFor(item.event)))) {
      clearTimer(group);
      schedule(group, now(), true);
    }
  }

  function stop() {
    stopped = true;
    for (const group of [...timers.keys()]) clearTimer(group);
  }

  // Wait for accepted debounce batches and active work, not future retries.
  async function waitForIdle() {
    for (;;) {
      const saved = storage;
      await saved;
      const scheduled = [...timers.values()].filter((item) => item.incoming);
      const active = [...running.values()];
      if (!scheduled.length && !active.length && saved === storage) return;
      await Promise.all([...scheduled.map((item) => item.done), ...active]);
    }
  }

  return { enqueue, wake, stop, waitForIdle };
}
