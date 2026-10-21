import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { classify, conversationNameFrom, formatPush, isAtAll, normalizeEvent, pushIndexLine, splitText, wasDeliveredInLegacyHistory } from "../src/push.js";
import { flushWrites, saveJson } from "../src/store.js";

test("原生群 @ 直接识别，群全量事件不能凭其他人的姓名猜测 @当前用户", () => {
  assert.equal(classify({ type: "user_im_message_receive_at", content: "请确认" }), "mention");
  assert.equal(classify({ type: "user_im_message_receive_group_all", content: "@其他同事 请确认" }, { allGroupMessages: false }), null);
  assert.equal(classify({ type: "user_im_message_receive_group_all", content: "@所有人 请确认" }), "at-all");
  assert.equal(isAtAll({ content: '示例 JSON: {"atAll":true}' }), false);
});

test("旧版本发送前写下的 seen 不会永久屏蔽未成功送达的群通知", () => {
  const event = { message_id: "msg-legacy", conversation_id: "cid-1" };
  const seen = { "msg-legacy": 1 };
  assert.equal(wasDeliveredInLegacyHistory(event, seen, []), false);
  assert.equal(wasDeliveredInLegacyHistory(event, seen, ["测试群 cid-1 msg-legacy 已发送"]), true);
  assert.equal(wasDeliveredInLegacyHistory({ message_id: "msg-leg" }, seen, ["测试群 cid-1 msg-legacy 已发送"]), false);
});

test("兼容扁平事件和 transport envelope，保留稳定消息与会话 ID", () => {
  const event = normalizeEvent({
    type: "EVENT", event_type: "user_im_message_receive_at",
    data: JSON.stringify({ messageId: "msg-1", conversationId: "cid-1", sender: { name: "测试同事" }, content: "中文原文", time: "2026-10-21 14:20:00" }),
  });
  assert.equal(event.type, "user_im_message_receive_at");
  assert.equal(event.message_id, "msg-1");
  assert.equal(event.conversation_id, "cid-1");
  assert.equal(event.sender, "测试同事");
  assert.equal(event.content, "中文原文");
  assert.equal(classify(event), "mention");
});

test("解析真实群信息包装，并在通知和索引中保留群名与 event_time", () => {
  const name = conversationNameFrom({ success: true, result: { conversationInfo: { title: "测试项目群" } } });
  const event = { sender: "测试同事", content: "@我 请确认", message_id: "msg-1", conversation_id: "cid-1", event_time: "2026-10-21T06:20:00Z" };
  assert.equal(name, "测试项目群");
  assert.match(formatPush(event, "mention", name), /测试项目群/);
  assert.match(formatPush(event, "mention", name), /14:20/);
  assert.match(pushIndexLine(event, "mention", name), /14:20/);
  assert.match(pushIndexLine({ ...event, event_time: Date.parse(event.event_time) / 1000 }, "mention", name), /14:20/);
});

test("长通知分块不损坏中文、emoji，且不改变全文", () => {
  const text = "中".repeat(3499) + "👀" + "文".repeat(3500);
  const parts = splitText(text);
  assert.equal(parts.join(""), text);
  assert.ok(parts.every((part) => part.length <= 3500));
  assert.ok(parts.every((part) => !/[\ud800-\udbff]$/.test(part) && !/^[\udc00-\udfff]/.test(part)));
});

test("并发保存同一状态文件不互相覆盖临时文件，并保留调用时快照", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jiying-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  const state = { ids: [] };
  const operations = [];
  for (let i = 0; i < 30; i += 1) {
    state.ids.push(i);
    operations.push(saveJson(path, state));
  }
  state.ids.push("not-saved");
  await Promise.all(operations);
  await flushWrites();
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { ids: Array.from({ length: 30 }, (_, i) => i) });
  assert.deepEqual(await readdir(directory), ["state.json"]);
});
