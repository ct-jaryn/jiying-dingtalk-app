/**
 * Durable notification delivery, ordered within each active conversation.
 * A remote success followed by a crash
 * before saving progress can still be delivered again unless send is idempotent.
 */
export function createPushForwarder({
  state,
  saveState,
  render,
  send,
  shouldSkip = () => false,
  onSkipped = () => {},
  onDelivered = () => {},
  onFailurePart,
  onLog = () => {},
  concurrency = 3,
  mediaConcurrency = 1,
  maxMediaAttempts = 5,
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
  const active = new Map();
  const activeConversations = new Set();
  const capacity = Math.max(1, Math.trunc(concurrency) || 1);
  const mediaCapacity = Math.min(capacity, Math.max(1, Math.trunc(mediaConcurrency) || 1));
  const mediaLimit = Math.max(1, Math.trunc(maxMediaAttempts) || 1);
  let storage = Promise.resolve();
  let running;
  let timer;
  let stopped = false;
  let dirty = false;
  let freshStarts = 0;

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
      if (draft.failed) state.failed = draft.failed;
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
      draft.pending.push({ key, event: snapshot, reason, parts: null, nextPart: 0, attempts: 0, mediaAttempts: 0, nextAttemptAt: 0 });
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
    if (await shouldSkip(item.event)) {
      await finish(key, true);
      return;
    }
    if (!Array.isArray(item.parts)) {
      const rendered = await render(item.event, item.reason);
      const parts = typeof rendered === "string" ? [rendered] : rendered;
      if (!Array.isArray(parts) || !parts.length || parts.some((part) => typeof part !== "string" && (!part || typeof part !== "object" || Array.isArray(part)))) {
        throw new TypeError("通知渲染结果必须是由文本或消息对象组成的非空数组");
      }
      await change((draft) => {
        draft.pending.find((entry) => entry.key === key).parts = structuredClone(parts);
      });
      item = entryFor(key);
    }
    while (!stopped && item.nextPart < item.parts.length) {
      const partIndex = item.nextPart;
      const part = item.parts[partIndex];
      try {
        await send(part, { key, partIndex, event: item.event, reason: item.reason });
      } catch (error) {
        const mediaAttempts = (Number(item.mediaAttempts) || 0) + 1;
        // Transport outages do not exhaust the image budget. Older queue files
        // have no media counter: only a newly confirmed media failure lets us
        // use their previous retry count when recovering an exhausted image.
        const legacyExhausted = item.mediaAttempts == null && Number(item.attempts) >= mediaLimit;
        if (part?.type === "image" && error?.mediaFailure === true && typeof onFailurePart === "function"
          && (error.permanent === true || mediaAttempts >= mediaLimit || legacyExhausted)) {
          await replaceFailedPart(key, partIndex, error, mediaAttempts);
          item = entryFor(key);
          continue;
        }
        throw error;
      }
      await change((draft) => {
        const entry = draft.pending.find((pending) => pending.key === key);
        entry.nextPart = partIndex + 1;
        entry.attempts = 0;
        entry.mediaAttempts = 0;
        entry.nextAttemptAt = 0;
        delete entry.lastErrorCode;
      });
      item = entryFor(key);
    }
    if (item.nextPart < item.parts.length) return;
    await finish(key, false);
  }

  async function replaceFailedPart(key, partIndex, error, mediaAttempts) {
    const item = entryFor(key);
    const part = item.parts[partIndex];
    const attempts = (Number(item.attempts) || 0) + 1;
    const fallback = await onFailurePart(part, { key, partIndex, event: item.event, reason: item.reason, error, attempts });
    if (typeof fallback !== "string" || !fallback.trim()) throw new TypeError("图片失败说明必须是非空文本");
    const code = errorCode(error);
    // Archive and substitute in the same committed snapshot. A failed save
    // leaves the original image pending, and never claims it was delivered.
    await change((draft) => {
      const entry = draft.pending.find((pending) => pending.key === key);
      draft.failed ||= [];
      if (!draft.failed.some((failure) => failure.key === key && failure.partIndex === partIndex)) {
        draft.failed.push({
          key, partIndex, part: structuredClone(part), event: structuredClone(entry.event), reason: entry.reason,
          failedAt: now(), attempts, mediaAttempts, error: { code, permanent: error.permanent === true },
        });
      }
      entry.parts[partIndex] = fallback;
      entry.failedParts = (Number(entry.failedParts) || 0) + 1;
      entry.attempts = 0;
      entry.mediaAttempts = 0;
      entry.nextAttemptAt = 0;
      delete entry.lastErrorCode;
    });
    retryAt.delete(key);
    log("图片投递失败已归档，将发送失败说明", new Error(code));
  }

  async function finish(key, skipped) {
    const { event, reason, failedParts = 0 } = entryFor(key);
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
      await (skipped ? onSkipped : onDelivered)(event, reason, { partial: failedParts > 0, failedParts });
    } catch (error) {
      log(skipped ? "记录已忽略的回流消息失败" : "通知已投递，但保存推送索引失败", error);
    }
  }

  function isRetry(item) { return Number(item.attempts) > 0; }
  function isMedia(item) {
    if (Array.isArray(item.parts)) return item.parts.slice(item.nextPart).some((part) => part?.type === "image");
    const content = String(item.event?.content || item.event?.text || "");
    return content.includes("图片消息") || content.includes("mediaId=");
  }
  function conversationFor(item) { return String(item.event?.conversation_id || ""); }
  function retryRunning() { return [...active.values()].some((item) => item.retry); }

  function eligible(item) {
    return !active.has(item.key) && !activeConversations.has(conversationFor(item))
      && (!isRetry(item) || !retryRunning())
      && (!isMedia(item) || [...active.values()].filter((entry) => entry.media).length < mediaCapacity);
  }

  function nextItem() {
    const ready = state.pending.filter((item) => eligible(item) && dueAt(item) <= now());
    const fresh = ready.find((item) => !isRetry(item));
    const retry = ready.find(isRetry);
    if (retry && (!fresh || freshStarts >= 10)) return retry;
    return fresh || retry;
  }

  async function failed(key, error) {
    const current = entryFor(key);
    if (!current) return;
    const attempts = (Number(current.attempts) || 0) + 1;
    const part = current.parts?.[current.nextPart];
    const mediaFailure = part?.type === "image" && error?.mediaFailure === true;
    const code = errorCode(error);
    const delay = Math.min(maxRetryDelayMs, retryDelayMs * 2 ** Math.min(attempts - 1, 20));
    const nextAttemptAt = now() + Math.max(1, delay);
    // Keep a volatile deadline too, so broken storage cannot cause a tight loop.
    retryAt.set(key, nextAttemptAt);
    if (attempts === 1 || (attempts & (attempts - 1)) === 0 || current.lastErrorCode !== code) {
      log(`通知投递失败，将自动重试（第 ${attempts} 次）`, new Error(code));
    }
    try {
      await change((draft) => {
        const entry = draft.pending.find((pending) => pending.key === key);
        entry.attempts = attempts;
        if (mediaFailure) entry.mediaAttempts = (Number(entry.mediaAttempts) || 0) + 1;
        entry.nextAttemptAt = nextAttemptAt;
        entry.lastErrorCode = code;
      });
    } catch (saveError) {
      log("保存通知重试进度失败", new Error(errorCode(saveError)));
    }
  }

  function pump() {
    while (!stopped && active.size < capacity) {
      const item = nextItem();
      if (!item) return;
      const key = item.key;
      const conversation = conversationFor(item);
      const retry = isRetry(item);
      forced.delete(key);
      if (retry) freshStarts = 0;
      else freshStarts = Math.min(10, freshStarts + 1);
      const task = Promise.resolve().then(() => deliver(key)).catch((error) => failed(key, error)).finally(() => {
        active.delete(key);
        activeConversations.delete(conversation);
        kick();
      });
      active.set(key, { promise: task, conversation, retry, media: isMedia(item) });
      activeConversations.add(conversation);
    }
  }

  function schedule() {
    if (stopped || !state.pending.length || active.size >= capacity) return;
    const candidates = state.pending.filter(eligible);
    const earliest = candidates.reduce((minimum, item) => Math.min(minimum, dueAt(item)), Infinity);
    if (earliest === Infinity) return;
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
    if (stopped) return;
    dirty = true;
    if (running) return;
    dirty = false;
    running = Promise.resolve().then(pump).catch((error) => {
      log("推送队列处理失败", error);
    }).finally(() => {
      running = undefined;
      if (dirty) kick();
      else schedule();
    });
  }

  function wake({ force = true } = {}) {
    if (stopped) return;
    // A reconnect may ask for an immediate pass without clearing established
    // backoff. Explicit manual wakes remain compatible with offline recovery.
    if (force) for (const item of state.pending) if (!active.has(item.key)) forced.add(item.key);
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
      const dispatched = running;
      const tasks = [...active.values()].map((item) => item.promise);
      const saved = storage;
      await Promise.all([dispatched, ...tasks, saved]);
      if (!running && !active.size && saved === storage) return;
    }
  }

  kick();
  return { enqueue, wake, stop, waitForIdle };
}

// CLI errors can contain signed URLs or entire raw responses. Persist and log
// only an identifier here; the original event/part stays in local failed data.
function errorCode(error) {
  const code = error?.code || error?.data?.error?.server_error_code || error?.data?.error?.code;
  return typeof code === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(code) ? code : "NOTIFICATION_FAILED";
}
