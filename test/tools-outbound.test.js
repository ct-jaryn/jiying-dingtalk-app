import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { createOutboundGuard } from "../src/outbound.js";
import { executeTool } from "../src/tools.js";

async function fixture(t, { stampFails = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "jiying-tools-outbound-"));
  const log = join(root, "commands.jsonl");
  const registered = join(root, "registered.json");
  const bin = join(root, "dws");
  await writeFile(bin, `#!${process.execPath}
import { appendFileSync, existsSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args.includes("+messages-send") || args.includes("+messages-reply")) {
  console.log(JSON.stringify({
    messageId: "msgSENT", conversationId: "cidTARGET", deliveryStatus: "delivered",
    ...(args.includes("+messages-reply") ? {
      referencedMessage: { messageId: "msgSOURCE", conversationId: "cidTARGET", text: "原消息" }
    } : {})
  }));
} else if (args.includes("+messages-create-text-emotion")) {
  console.log(JSON.stringify({emotionId:"emotion-fixture"}));
} else if (args.includes("+messages-add-text-emotion")) {
  if (!existsSync(${JSON.stringify(registered)})) {
    console.log(JSON.stringify({error:{message:"stamp ran before outbound registration"}}));
    process.exit(1);
  }
  if (${stampFails}) {
    console.log(JSON.stringify({error:{message:"fixture stamp failed"}}));
    process.exit(1);
  }
  console.log(JSON.stringify({success:true}));
} else {
  console.log(JSON.stringify({error:{message:"unexpected fixture command"}}));
  process.exit(1);
}
`);
  await chmod(bin, 0o755);
  const previousPath = process.env.PATH;
  const previousCwd = process.cwd();
  process.env.PATH = `${root}${delimiter}${previousPath || ""}`;
  // executeTool resolves its emotion file relative to cwd. Keep fixture writes
  // away from the running application's private data directory.
  process.chdir(root);
  t.after(async () => {
    process.chdir(previousCwd);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  });

  const snapshots = [];
  const outbound = createOutboundGuard({
    state: { sent: {} },
    saveState: async (state) => {
      snapshots.push(structuredClone(state));
      if (Object.keys(state.sent).length) await writeFile(registered, JSON.stringify(state));
    },
  });
  return {
    outbound,
    snapshots,
    async commands() {
      try { return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); }
      catch (error) { if (error.code === "ENOENT") return []; throw error; }
    },
  };
}

const event = (messageId, conversationId = "cidTARGET") => ({
  conversation_id: conversationId,
  message_id: messageId,
  sender: "同名发送人",
  content: "相同正文",
});
const arg = (args, name) => args[args.indexOf(name) + 1];

test("agent send_message records the actual sent ID before stamping and only suppresses that message", async (t) => {
  const f = await fixture(t);
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  t.after(() => { console.error = originalError; });

  const sent = await executeTool("send_message", {
    conversation_id: "cidTARGET", text: "相同正文",
  }, { outbound: f.outbound });

  assert.equal(sent.data.messageId, "msgSENT");
  assert.equal(await f.outbound.isSent(event("msgSENT")), true);
  assert.equal(await f.outbound.isSent(event("msgOTHER")), false, "same sender and text do not identify an echo");
  assert.equal(await f.outbound.isSent(event("msgSENT", "cidOTHER")), false, "conversation ownership is exact");
  assert.ok(f.snapshots.some((state) => Object.keys(state.sent).length > 0), "sent IDs are persisted");
  const commands = await f.commands();
  const sends = commands.filter((args) => args.includes("+messages-send"));
  assert.equal(sends.length, 1);
  assert.equal(arg(sends[0], "--group"), "cidTARGET");
  const stamp = commands.find((args) => args.includes("+messages-add-text-emotion"));
  assert.equal(arg(stamp, "--msg-id"), "msgSENT");
  assert.deepEqual(errors, [], "successful stamping sees an already saved outbound registration");
});

test("agent reply_message registers its new receipt without suppressing the quoted source", async (t) => {
  const f = await fixture(t);
  const sent = await executeTool("reply_message", {
    conversation_id: "cidTARGET", message_id: "msgSOURCE", text: "相同正文",
  }, { outbound: f.outbound });

  assert.equal(sent.data.messageId, "msgSENT");
  assert.equal(await f.outbound.isSent(event("msgSENT")), true);
  assert.equal(await f.outbound.isSent(event("msgSOURCE")), false, "a referenced message belongs to the original sender");
  assert.equal(await f.outbound.isSent(event("msgOTHER")), false);
  const commands = await f.commands();
  assert.equal(commands.filter((args) => args.includes("+messages-reply")).length, 1);
  assert.equal(commands.filter((args) => args.includes("+messages-send")).length, 0);
  const stamp = commands.find((args) => args.includes("+messages-add-text-emotion"));
  assert.equal(arg(stamp, "--msg-id"), "msgSENT");
});

test("agent targets without a conversation ID use the actual receipt conversation", async (t) => {
  for (const [name, input] of [
    ["send_message", { open_dingtalk_id: "openPEER", text: "相同正文" }],
    ["send_message", { group_name: "待解析群名", text: "相同正文" }],
    ["reply_message", { message_id: "msgSOURCE", text: "相同正文" }],
  ]) {
    await t.test(`${name} ${Object.keys(input)[0]}`, async (t) => {
      const f = await fixture(t);
      await executeTool(name, input, { outbound: f.outbound });
      assert.equal(await f.outbound.isSent(event("msgSENT")), true);
      assert.equal(await f.outbound.isSent(event("msgSOURCE")), false);
      assert.equal(await f.outbound.isSent(event("msgOTHER")), false);
      assert.equal(await f.outbound.isSent(event("msgSENT", "cidOTHER")), false);
      const sends = (await f.commands()).filter((args) => args.includes("+messages-send") || args.includes("+messages-reply"));
      assert.equal(sends.length, 1);
      assert.equal(sends[0].includes("--group"), false);
    });
  }
});

test("a failed agent send stamp keeps outbound registration and never repeats the send", async (t) => {
  const f = await fixture(t, { stampFails: true });
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  t.after(() => { console.error = originalError; });

  const sent = await executeTool("reply_message", {
    message_id: "msgSOURCE", text: "相同正文",
  }, { outbound: f.outbound });

  assert.equal(sent.data.messageId, "msgSENT");
  assert.equal(await f.outbound.isSent(event("msgSENT")), true);
  assert.equal(await f.outbound.isSent(event("msgSOURCE")), false);
  const commands = await f.commands();
  assert.equal(commands.filter((args) => args.includes("+messages-reply")).length, 1);
  assert.equal(commands.filter((args) => args.includes("+messages-send")).length, 0);
  assert.equal(commands.filter((args) => args.includes("+messages-add-text-emotion")).length, 1);
  assert.ok(errors.some((line) => line.includes("fixture stamp failed")));
  assert.ok(!errors.some((line) => line.includes("before outbound registration")));
});
