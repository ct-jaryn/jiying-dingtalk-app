import assert from "node:assert/strict";
import test from "node:test";
import { createNotificationDelivery } from "../src/delivery.js";
import { formatTopicSender } from "../src/push.js";
import { emptyTopics } from "../src/topics.js";

function delivery() {
  return createNotificationDelivery({
    chat: { request: async () => { throw new Error("仅渲染通知，不应发送消息"); } },
    userId: "format-owner",
    topics: emptyTopics(),
    saveTopics: async () => {},
    resolveName: async () => "格式测试群",
  });
}

test("群聊图文消息的发送人和正文同一行，图片不重复附加发送人", async () => {
  const parts = await delivery().render({
    sender: "  测试同事  ",
    content: "请确认图片\n[图片消息](mediaId=%24format-image)",
  }, "mention");
  assert.deepEqual(parts, [
    "**测试同事**：请确认图片",
    { type: "image", mediaId: "$format-image", caption: "" },
  ]);
});

test("群聊纯图片使用统一发送人说明，不使用引用块", async () => {
  const event = { sender: "测试同事", content: "[图片消息](mediaId=%24format-image)" };
  const parts = await delivery().render(event, "group");
  assert.deepEqual(parts, [{ type: "image", mediaId: "$format-image", caption: formatTopicSender(event) }]);
  assert.equal(parts[0].caption, "**测试同事**：");
});

test("缺少发送人时，群聊图片说明和普通消息都使用未知发送人", async () => {
  const instance = delivery();
  assert.deepEqual(await instance.render({ content: "[图片消息](mediaId=%24format-image)" }, "at-all"), [
    { type: "image", mediaId: "$format-image", caption: "**未知发送人**：" },
  ]);
  assert.deepEqual(await instance.render({ content: "请确认" }, "mention"), ["**未知发送人**：请确认"]);
});

test("私聊图文与纯图片保持正文，不添加群聊发送人", async () => {
  const instance = delivery();
  assert.deepEqual(await instance.render({ sender: "测试同事", content: "附图说明\n[图片消息](mediaId=%24format-image)" }, "dm"), [
    "附图说明",
    { type: "image", mediaId: "$format-image", caption: "" },
  ]);
  assert.deepEqual(await instance.render({ sender: "测试同事", content: "[图片消息](mediaId=%24format-image)" }, "dm"), [
    { type: "image", mediaId: "$format-image", caption: "" },
  ]);
});
