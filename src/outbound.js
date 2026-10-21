import { sentMessageRef } from "./stamp.js";

/** Suppress only messages identified by an actual DingTalk send receipt. */
export function createOutboundGuard({
  state = { sent: {} },
  saveState,
  onLog = () => {},
  now = Date.now,
  maxEntries = 5000,
} = {}) {
  if (!state?.sent || typeof state.sent !== "object" || Array.isArray(state.sent)) {
    throw new TypeError("出站状态必须包含 sent 对象");
  }
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError("出站记录数量上限必须是正整数");
  }
  const active = new Set();
  let storage = Promise.resolve();

  function log(message, error) {
    try { onLog(message, error); } catch { /* Logging cannot undo a successful send. */ }
  }

  function keyFor(conversationId, messageId) {
    return JSON.stringify([conversationId, messageId]);
  }

  function prune() {
    const entries = Object.entries(state.sent).sort((a, b) => Number(a[1]) - Number(b[1]));
    for (const [key] of entries.slice(0, Math.max(0, entries.length - maxEntries))) {
      delete state.sent[key];
    }
  }

  function remember(ref) {
    // Update memory before the first save await so an event arriving immediately
    // after the receipt is already filtered, even if the disk is unavailable.
    state.sent[keyFor(String(ref.conversationId || ""), String(ref.messageId))] = now();
    prune();
    const snapshot = structuredClone(state);
    const saved = storage.then(() => saveState?.(snapshot));
    storage = saved.catch((error) => {
      log("钉钉消息已发送，但保存出站回执失败", error);
    });
    return storage;
  }

  async function send(execute, { conversationId = "" } = {}) {
    let release;
    const pending = {
      conversationId: String(conversationId || ""),
      done: new Promise((resolve) => { release = resolve; }),
    };
    // Register before execute: the CLI can emit a live event before its send
    // command returns the receipt, including synchronously in a test adapter.
    active.add(pending);
    try {
      const result = await execute();
      try {
        const ref = sentMessageRef(result?.data ?? result, pending.conversationId);
        if (ref.messageId) await remember(ref);
        else log("钉钉消息已发送，但回执没有返回消息 ID，无法登记回流过滤");
      } catch (error) {
        // Sending succeeded. A local bookkeeping failure must never turn it
        // into a business-level send failure and cause the message to be sent again.
        log("钉钉消息已发送，但登记出站回执失败", error);
      }
      return result;
    } finally {
      active.delete(pending);
      release();
    }
  }

  function matches(conversationId, messageId) {
    return Object.hasOwn(state.sent, keyFor(conversationId, messageId))
      || Object.hasOwn(state.sent, keyFor("", messageId));
  }

  async function isSent(event) {
    const messageId = String(event?.message_id || event?.messageId || event?.openMessageId || "");
    if (!messageId) return false;
    const conversationId = String(event?.conversation_id || event?.conversationId || event?.openConversationId || "");
    if (matches(conversationId, messageId)) return true;
    // Capture only sends active when this event arrived. Following new sends
    // could indefinitely delay an unrelated incoming message in a busy group.
    const barriers = [...active]
      .filter((pending) => !pending.conversationId || pending.conversationId === conversationId)
      .map((pending) => pending.done);
    if (barriers.length) await Promise.all(barriers);
    return matches(conversationId, messageId);
  }

  async function waitForIdle() {
    for (;;) {
      const saved = storage;
      await Promise.all([saved, ...[...active].map((pending) => pending.done)]);
      if (!active.size && saved === storage) return;
    }
  }

  prune();
  return { send, isSent, waitForIdle };
}
