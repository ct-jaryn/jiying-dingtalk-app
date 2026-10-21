const DAY_MS = 86_400_000;

function eventTime(value) {
  if (value == null || value === "") return NaN;
  if (typeof value === "number" || /^\d+(?:\.\d+)?$/.test(String(value).trim())) {
    const number = Number(value);
    return Number.isFinite(number) ? number * (Math.abs(number) < 100_000_000_000 ? 1000 : 1) : NaN;
  }
  let text = String(value).trim().replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text += "T00:00:00+08:00";
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text)) text += "+08:00";
  return Date.parse(text);
}

function messageId(record) {
  const id = record?.messageId ?? record?.message_id ?? record?.event_id;
  return id == null ? "" : String(id);
}

function failure(error) {
  return { code: error?.code || "QUERY_FAILED", message: error?.message || String(error) };
}

function inspectPage(page) {
  const items = page?.items ?? page?.messages;
  if (!Array.isArray(items)) throw new TypeError("@消息查询没有返回 items 或 messages 数组");
  const failures = Array.isArray(page.failures)
    ? [...page.failures]
    : page.failures && Object.keys(page.failures).length ? [page.failures] : [];
  const partial = Boolean(page.partial || page.truncated || Number(page.failedCount) > 0 || failures.length
    || (page.hasMore === false && page.complete === false));
  const terminal = page.complete !== false && page.hasMore !== true && (page.hasMore === false || page.complete === true);
  const cursor = page.nextCursor == null ? "" : String(page.nextCursor);
  return { items, failures, partial, terminal, cursor };
}

/** Search the personal mention index without repeatedly truncating it at page 3. */
export function createMentionLookup({ queryPage, now = Date.now, maxPagesPerRun = 3 }) {
  if (typeof queryPage !== "function") throw new TypeError("queryPage 必须是函数");
  if (!Number.isInteger(maxPagesPerRun) || maxPagesPerRun < 1) throw new TypeError("maxPagesPerRun 必须是正整数");
  const scans = new Map();
  const running = new Map();

  async function run(groupId, pendingEvents) {
    const group = String(groupId);
    const wanted = new Set(pendingEvents.map(messageId).filter(Boolean));
    if (!wanted.size) {
      scans.delete(group);
      return { items: [], complete: true, hasMore: false, partial: false, failures: [] };
    }
    let oldest = now();
    for (const event of pendingEvents) {
      for (const field of ["event_time", "create_time", "timestamp"]) {
        const time = eventTime(event?.[field]);
        if (Number.isFinite(time)) oldest = Math.min(oldest, time);
      }
    }
    // Include a full extra boundary day, since --days is relative to query time.
    const requiredDays = Math.max(1, Math.floor((now() - oldest) / DAY_MS) + 1);
    const days = Math.min(3650, requiredDays);
    let scan = scans.get(group);
    if (!scan || scan.days !== days || scan.finished) {
      scan = { days, cursor: null, visited: new Set(), covered: new Set(wanted), matches: new Map(), finished: false };
      scans.set(group, scan);
    }
    for (const id of scan.matches.keys()) if (!wanted.has(id)) scan.matches.delete(id);
    const failures = [];
    let partial = false;
    let complete = false;

    function remember(items) {
      let added = false;
      for (const record of items) {
        const id = messageId(record);
        const recordGroup = record?.conversationId || record?.conversation_id || record?.conversation?.openConversationId;
        if (!wanted.has(id) || (recordGroup && String(recordGroup) !== group)) continue;
        if (!scan.matches.has(id)) added = true;
        scan.matches.set(id, record);
      }
      return added;
    }

    function finish() {
      scan.finished = true;
      // IDs added midway through a scan may have appeared on an earlier page.
      complete = requiredDays <= 3650 && [...wanted].every((id) => scan.covered.has(id) || scan.matches.has(id));
      partial ||= !complete;
    }

    for (let request = 0; request < maxPagesPerRun; request += 1) {
      const home = request === 0;
      const cursor = home ? "0" : scan.cursor;
      if (!home && scan.visited.has(cursor)) {
        failures.push({ code: "CURSOR_CYCLE", message: "@消息查询返回了重复分页游标" });
        partial = true;
        scan.finished = true;
        break;
      }
      let page;
      try { page = inspectPage(await queryPage({ groupId: group, days, cursor })); }
      catch (error) {
        failures.push(failure(error));
        partial = true;
        break;
      }
      const added = remember(page.items);
      failures.push(...page.failures);
      if (page.partial) {
        // Do not skip a page whose response may be incomplete. Retry it after
        // refreshing the first page on the next invocation.
        partial = true;
        break;
      }
      if (page.terminal) {
        // A refreshed first page that now contains the whole index covers new
        // pending IDs too. Final cursors are intentionally ignored.
        if (home) scan.covered = new Set(wanted);
        finish();
        break;
      }
      if (!page.cursor || page.cursor === "0") {
        failures.push({ code: "MISSING_CURSOR", message: "@消息查询未完成但没有可继续的分页游标" });
        partial = true;
        break;
      }
      if (!home) scan.visited.add(cursor);
      // The home page is always refreshed, but it must not reset continuation.
      if (!home || scan.cursor == null) scan.cursor = page.cursor;
      if (scan.visited.has(scan.cursor)) {
        failures.push({ code: "CURSOR_CYCLE", message: "@消息查询返回了重复分页游标" });
        partial = true;
        scan.finished = true;
        break;
      }
      if (added) {
        // Deliver confirmed mentions immediately; remaining IDs resume later.
        partial = true;
        break;
      }
    }
    return { items: [...scan.matches.values()], complete, hasMore: !complete, partial, failures };
  }

  return async function lookup(groupId, pendingEvents = []) {
    const group = String(groupId);
    // Keep cursors consistent even if callers overlap requests for one group.
    const previous = running.get(group) || Promise.resolve();
    const work = previous.catch(() => {}).then(() => run(group, pendingEvents));
    running.set(group, work);
    try { return await work; }
    finally { if (running.get(group) === work) running.delete(group); }
  };
}
