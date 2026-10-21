/**
 * Durable, ordered notification delivery. A remote success followed by a crash
 * before saving progress can still be delivered again unless send is idempotent.
 */
export function createPushForwarder({
  state,
  saveState,
  render,
  send,
  onDelivered = () => {},
  onLog = () => {},
  retryDelayMs = 1000,
  maxRetryDelayMs = 30_000,
  maxDelivered = 5000,
  now = Date.now,
}) {
  if (!state || !Array.isArray(state.pending) || !state.delivered || typeof state.delivered !== "object") {
    throw new TypeError("推送状态必须包含 pending 数组和 delivered 对象");
  }
  const reservations = new Map();
  const retryAt = new Map();
  const forced = new Set();
  let storage = Promise.resolve();
  let running;
  let timer;
  let stopped = false;

  function log(message, error) {
    try { onLog(message, error); } catch { /* Logging must not interrupt delivery. */ }
  }

  // Commit a detached snapshot only after its save succeeds. All changes share
  // this queue, so a concurrent enqueue cannot overwrite chunk progress.
  function change(update) {
    const operation = storage.then(async () => {
      const draft = structuredClone(state);
      update(draft);
      await saveState(draft);
      state.pending = draft.pending;
      state.delivered = draft.delivered;
    });
    storage = operation.catch(() => {});
    return operation;
  }

  function keyFor(event) {
    const id = event?.message_id || event?.event_id;
    if (!id) throw new Error("钉钉事件缺少 message_id 或 event_id");
    return JSON.stringify(["dingtalk", String(event.conversation_id || ""), String(id)]);
  }

  function enqueue(event, reason) {
    if (stopped) return Promise.reject(new Error("推送转发器已停止"));
    let key;
    let snapshot;
    try {
      key = keyFor(event);
      if (reservations.has(key)) return reservations.get(key);
      if (Object.hasOwn(state.delivered, key) || state.pending.some((item) => item.key === key)) {
        return Promise.resolve(key);
      }
      snapshot = structuredClone(event);
    } catch (error) {
      return Promise.reject(error);
    }
    const accepted = change((draft) => {
      draft.pending.push({ key, event: snapshot, reason, parts: null, nextPart: 0, attempts: 0, nextAttemptAt: 0 });
    }).then(() => {
      kick();
      return key;
    }, (error) => {
      reservations.delete(key);
      throw error;
    });
    // Reserve before the first asynchronous storage operation to catch events
    // arriving concurrently through both the @ and group subscriptions.
    reservations.set(key, accepted);
    return accepted;
  }

  function entryFor(key) {
    return state.pending.find((item) => item.key === key);
  }

  function dueAt(item) {
    return forced.has(item.key) ? 0 : Math.max(Number(item.nextAttemptAt) || 0, retryAt.get(item.key) || 0);
  }

  async function deliver(key) {
    let item = entryFor(key);
    if (!Array.isArray(item.parts)) {
      const rendered = await render(item.event, item.reason);
      const parts = typeof rendered === "string" ? [rendered] : rendered;
      if (!Array.isArray(parts) || !parts.length || parts.some((part) => typeof part !== "string")) {
        throw new TypeError("通知渲染结果必须是非空字符串数组");
      }
      await change((draft) => {
        draft.pending.find((entry) => entry.key === key).parts = [...parts];
      });
      item = entryFor(key);
    }
    while (!stopped && item.nextPart < item.parts.length) {
      const partIndex = item.nextPart;
      await send(item.parts[partIndex], { key, partIndex, event: item.event, reason: item.reason });
      await change((draft) => {
        const entry = draft.pending.find((pending) => pending.key === key);
        entry.nextPart = partIndex + 1;
        entry.attempts = 0;
        entry.nextAttemptAt = 0;
      });
      item = entryFor(key);
    }
    if (item.nextPart < item.parts.length) return;
    const { event, reason } = item;
    await change((draft) => {
      draft.pending = draft.pending.filter((entry) => entry.key !== key);
      draft.delivered[key] = now();
      const ordered = Object.entries(draft.delivered).sort((a, b) => Number(a[1]) - Number(b[1]));
      for (const [oldKey] of ordered.slice(0, Math.max(0, ordered.length - maxDelivered))) {
        delete draft.delivered[oldKey];
      }
    });
    reservations.delete(key);
    retryAt.delete(key);
    forced.delete(key);
    try {
      await onDelivered(event, reason);
    } catch (error) {
      log("通知已投递，但保存推送索引失败", error);
    }
  }

  async function pump() {
    while (!stopped) {
      const item = state.pending.find((entry) => dueAt(entry) <= now());
      if (!item) return;
      forced.delete(item.key);
      try {
        await deliver(item.key);
      } catch (error) {
        const current = entryFor(item.key);
        if (!current) continue;
        const attempts = (Number(current.attempts) || 0) + 1;
        const delay = Math.min(maxRetryDelayMs, retryDelayMs * 2 ** Math.min(attempts - 1, 20));
        const nextAttemptAt = now() + Math.max(1, delay);
        // Also keep a volatile deadline: failed storage must not make a tight
        // retry loop or prevent another pending notification being attempted.
        retryAt.set(item.key, nextAttemptAt);
        log("通知投递失败，将自动重试", error);
        try {
          await change((draft) => {
            const entry = draft.pending.find((pending) => pending.key === item.key);
            entry.attempts = attempts;
            entry.nextAttemptAt = nextAttemptAt;
          });
        } catch (saveError) {
          log("保存通知重试进度失败", saveError);
        }
      }
    }
  }

  function schedule() {
    if (stopped || !state.pending.length) return;
    const earliest = state.pending.reduce((minimum, item) => Math.min(minimum, dueAt(item)), Infinity);
    if (earliest <= now()) {
      kick();
      return;
    }
    timer = setTimeout(kick, Math.max(0, Math.min(2_147_483_647, earliest - now())));
    timer.unref?.();
  }

  function kick() {
    clearTimeout(timer);
    timer = undefined;
    if (stopped || running) return;
    running = Promise.resolve().then(pump).catch((error) => {
      log("推送队列处理失败", error);
    }).finally(() => {
      running = undefined;
      schedule();
    });
  }

  function wake() {
    if (stopped) return;
    for (const item of state.pending) forced.add(item.key);
    kick();
  }

  function stop() {
    stopped = true;
    clearTimeout(timer);
    timer = undefined;
  }

  // Wait for the current pass and saves, not future retry deadlines. This also
  // permits clean shutdown while offline notifications remain safely pending.
  async function waitForIdle() {
    for (;;) {
      const active = running;
      const saved = storage;
      await Promise.all([active, saved]);
      if (!running && saved === storage) return;
    }
  }

  kick();
  return { enqueue, wake, stop, waitForIdle };
}
