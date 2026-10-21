import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { createTopicRelay } from "../src/relay.js";

async function fixture(t, { stampFails = false, sendFails = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "jiying-relay-"));
  const log = join(root, "commands.jsonl");
  const bin = join(root, "dws");
  await writeFile(bin, `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args.includes("+messages-send")) {
  if (${sendFails}) { console.log(JSON.stringify({error:{message:"send failed"}})); process.exit(1); }
  console.log(JSON.stringify({messageId:"msg-sent", conversationId:"cid-target"}));
} else if (args.includes("+messages-create-text-emotion")) {
  console.log(JSON.stringify({emotionId:"emotion-fixture"}));
} else if (args.includes("+messages-add-text-emotion")) {
  if (${stampFails}) { console.log(JSON.stringify({error:{message:"stamp failed"}})); process.exit(1); }
  console.log(JSON.stringify({success:true}));
} else { console.log(JSON.stringify({error:{message:"unexpected command"}})); process.exit(1); }
`);
  await chmod(bin, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${root}${delimiter}${previousPath || ""}`;
  t.after(async () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    commands: async () => {
      try { return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); }
      catch (error) { if (error.code === "ENOENT") return []; throw error; }
    },
  };
}

async function imageServer(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

const topic = { kind: "group", topicId: "topic-a", dingTalkConversationId: "cid-target" };
const message = (body) => ({ conversation: { id: "topic-a" }, message: { id: "msg-owner/123", body } });
const arg = (args, key) => args[args.indexOf(key) + 1];

test("topic text relay selects the group, waits for delivery, and stamps the sent message", async (t) => {
  const f = await fixture(t);
  const relay = createTopicRelay({ chat: {}, root: f.root });
  const result = await relay(message({ content: "  这是回复  " }), topic);
  assert.equal(result.data.messageId, "msg-sent");
  const commands = await f.commands();
  const sent = commands.find((args) => args.includes("+messages-send"));
  assert.equal(arg(sent, "--group"), "cid-target");
  assert.equal(arg(sent, "--text"), "这是回复");
  assert.equal(arg(sent, "--idempotency-key"), "msgowner123");
  assert.ok(sent.includes("--ai-tag=false"));
  assert.ok(sent.includes("--wait-delivery"));
  assert.ok(commands.some((args) => args.includes("+messages-add-text-emotion")));
});

test("topic DM relay selects the peer open DingTalk ID", async (t) => {
  const f = await fixture(t);
  const relay = createTopicRelay({ chat: {}, root: f.root });
  await relay(message({ content: "回复私聊" }), { kind: "dm", openDingTalkId: "open-peer" });
  const [sent] = await f.commands();
  assert.equal(arg(sent, "--open-dingtalk-id"), "open-peer");
  assert.ok(!sent.includes("--group"));
});

test("direct attachment URL downloads to an absolute workspace path and avoids reading file IDs", async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.from("fixture image");
  const base = await imageServer(t, (_req, res) => {
    res.writeHead(200, { "content-type": "image/jpeg" });
    res.end(bytes);
  });
  let readCalls = 0;
  const relay = createTopicRelay({
    root: f.root,
    chat: { request: async () => { readCalls++; throw new Error("must not read direct attachment"); } },
  });
  await relay(message({ type: "image", content: `${base}/photo?secret=signed`, file_id: "file-a", caption: "附图说明" }), topic);
  assert.equal(readCalls, 0);
  const sent = (await f.commands()).find((args) => args.includes("+messages-send"));
  const path = join(f.root, "data/outbound/msg-owner_123.jpg");
  assert.equal(arg(sent, "--markdown"), `附图说明\n\n![图片](${path})`);
  assert.deepEqual(await readFile(path), bytes);
});

test("attachment file IDs are resolved in the source message and URL extension is retained", async (t) => {
  const f = await fixture(t);
  const base = await imageServer(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end("webp fixture");
  });
  const requests = [];
  const relay = createTopicRelay({
    root: f.root,
    emotionPath: join(f.root, "custom-emotion.json"),
    chat: { request: async (...args) => {
      requests.push(args);
      return { files: [{ read_url: `${base}/image.WEBP?signature=secret` }] };
    } },
  });
  await relay(message({ type: "image", file_ids: ["file-a", "file-a"] }), topic);
  assert.deepEqual(requests, [["temporary_files.read_urls", {
    conversation_id: "topic-a", message_id: "msg-owner/123", file_ids: ["file-a"],
  }]]);
  const sent = (await f.commands()).find((args) => args.includes("+messages-send"));
  assert.equal(arg(sent, "--markdown"), `![图片](${join(f.root, "data/outbound/msg-owner_123.webp")})`);
});

test("missing content, attachment URLs, or recipients fail without sending", async (t) => {
  const f = await fixture(t);
  const relay = createTopicRelay({ chat: { request: async () => ({ files: [] }) }, root: f.root });
  await assert.rejects(relay(message({}), topic), /没有可转发/);
  await assert.rejects(relay(message({ type: "image" }), topic), /没有可下载/);
  await assert.rejects(relay(message({ type: "image", file_id: "file-a" }), topic), /没有可下载/);
  await assert.rejects(relay(message({ content: "text" }), { kind: "dm" }), /没有对方/);
  await assert.rejects(relay(message({ content: "text" }), { kind: "group" }), /没有对应/);
  assert.deepEqual(await f.commands(), []);
});

test("image HTTP failure does not leak the signed URL or send a message", async (t) => {
  const f = await fixture(t);
  const base = await imageServer(t, (_req, res) => { res.writeHead(503); res.end(); });
  const relay = createTopicRelay({ chat: {}, root: f.root });
  await assert.rejects(relay(message({ type: "image", content: `${base}/private?signature=secret` }), topic), (error) => {
    assert.match(error.message, /HTTP 503/);
    assert.ok(!error.message.includes("secret"));
    return true;
  });
  assert.deepEqual(await f.commands(), []);
});

test("image timeout also bounds a stalled response body", async (t) => {
  const f = await fixture(t);
  const base = await imageServer(t, (_req, res) => {
    res.writeHead(200, { "content-type": "image/png" });
    res.flushHeaders();
    res.write("incomplete image");
  });
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", (milliseconds) => {
    assert.equal(milliseconds, 20_000);
    return timeout(30);
  });
  const relay = createTopicRelay({ chat: {}, root: f.root });
  await assert.rejects(relay(message({ type: "image", content: `${base}/stalled?signature=secret` }), topic), /下载即应图片超时/);
  assert.deepEqual(await f.commands(), []);
});

test("DingTalk delivery failure rejects and never attempts a stamp", async (t) => {
  const f = await fixture(t, { sendFails: true });
  const relay = createTopicRelay({ chat: {}, root: f.root });
  await assert.rejects(relay(message({ content: "text" }), topic), /send failed/);
  assert.equal((await f.commands()).length, 1);
});

test("stamp failure is logged after delivery and does not fail or resend the relay", async (t) => {
  const f = await fixture(t, { stampFails: true });
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  t.after(() => { console.error = originalError; });
  const relay = createTopicRelay({ chat: {}, root: f.root });
  const result = await relay(message({ content: "text" }), topic);
  assert.equal(result.data.messageId, "msg-sent");
  const commands = await f.commands();
  assert.equal(commands.filter((args) => args.includes("+messages-send")).length, 1);
  assert.ok(errors.some((line) => line.includes("stamp failed")));
});
