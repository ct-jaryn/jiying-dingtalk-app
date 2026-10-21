import assert from "node:assert/strict";
import test from "node:test";
import { sentMessageRef } from "../src/stamp.js";

test("standard sent receipt wins over quoted source and lower-level IDs", () => {
  const payload = {
    referencedMessage: { messageId: "msgSOURCE", conversationId: "cidSOURCE" },
    result: { messageId: "msgLOWER", conversationId: "cidLOWER" },
    messageId: "msgSENT",
    conversationId: "cidSENT",
  };
  assert.deepEqual(sentMessageRef(payload), { messageId: "msgSENT", conversationId: "cidSENT" });
});

test("delivery receipt wins over earlier result and message payloads", () => {
  assert.deepEqual(sentMessageRef({
    result: { messageId: "msgLOWER", conversationId: "cidLOWER" },
    delivery: { messageId: "msgSENT", conversationId: "cidSENT" },
  }), { messageId: "msgSENT", conversationId: "cidSENT" });
});

test("result, delivery and message wrappers preserve receipt fields", () => {
  for (const wrapper of ["result", "delivery", "message"]) {
    assert.deepEqual(sentMessageRef({ data: { [wrapper]: {
      openMessageId: "msgSENT", openConversationId: "cidSENT",
    } } }), { messageId: "msgSENT", conversationId: "cidSENT" });
  }
});

test("legacy nested payloads inherit the enclosing conversation", () => {
  assert.deepEqual(sentMessageRef({
    openConversationId: "cidSENT",
    result: { originalResponse: [{ MSGID: "msgSENT" }] },
  }), { messageId: "msgSENT", conversationId: "cidSENT" });
});

test("quoted source alone never becomes the sent message", () => {
  for (const key of ["referencedMessage", "referenced_message", "referencedMessages"]) {
    assert.deepEqual(sentMessageRef({ result: {
      [key]: { messageId: "msgSOURCE", conversationId: "cidSOURCE" },
    } }, "cidFALLBACK"), { messageId: "", conversationId: "cidFALLBACK" });
  }
});

test("missing sent conversation uses fallback rather than another message's conversation", () => {
  assert.deepEqual(sentMessageRef({
    messageId: "msgSENT",
    referencedMessage: { messageId: "msgSOURCE", conversationId: "cidSOURCE" },
    result: { messageId: "msgOTHER", conversationId: "cidOTHER" },
  }, "cidFALLBACK"), { messageId: "msgSENT", conversationId: "cidFALLBACK" });
});

test("sent conversation can be nested in a receipt without another message ID", () => {
  assert.deepEqual(sentMessageRef({
    messageId: "msgSENT",
    delivery: { conversationId: "cidSENT" },
  }), { messageId: "msgSENT", conversationId: "cidSENT" });
});
