import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { executeTool } from "../src/tools.js";

async function fixture(t, { retryFirstSend = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "jiying-tools-idempotency-"));
  const commandsPath = join(directory, "commands.jsonl");
  const bin = join(directory, "dws");
  await writeFile(bin, `#!${process.execPath}
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(commandsPath)}, JSON.stringify(args) + "\\n");
if (args.includes("+messages-send") || args.includes("+messages-reply")) {
  const key = args[args.indexOf("--idempotency-key") + 1];
  const marker = ${JSON.stringify(directory)} + "/attempt-" + key;
  if (${retryFirstSend} && !existsSync(marker)) {
    writeFileSync(marker, "failed once");
    console.log(JSON.stringify({error:{message:"fixture network unavailable",retryable:true}}));
    process.exitCode = 7;
  } else console.log(JSON.stringify({messageId:"msgFIXTURE",conversationId:"cidFIXTURE",deliveryStatus:"delivered"}));
} else if (args.includes("+messages-create-text-emotion")) {
  console.log(JSON.stringify({emotionId:"emotion-idempotency-fixture"}));
} else if (args.includes("+messages-add-text-emotion")) {
  console.log(JSON.stringify({success:true}));
} else if (args.includes("+chat-messages")) {
  console.log(JSON.stringify({items:[]}));
} else {
  console.log(JSON.stringify({error:{message:"unexpected fixture command"}}));
  process.exitCode = 9;
}
`);
  await chmod(bin, 0o755);
  const previousCwd = process.cwd();
  const previousPath = process.env.PATH;
  process.chdir(directory);
  process.env.PATH = `${directory}${delimiter}${previousPath || ""}`;
  t.after(async () => {
    process.chdir(previousCwd);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return {
    async commands() {
      try { return (await readFile(commandsPath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); }
      catch (error) { if (error.code === "ENOENT") return []; throw error; }
    },
    async sends() {
      const commands = (await readFile(commandsPath, "utf8")).trim().split("\n").map(JSON.parse);
      return commands.filter((args) => args.includes("+messages-send") || args.includes("+messages-reply"));
    },
  };
}

const input = { open_dingtalk_id: "open-fixture-peer", text: "收到" };
const keyOf = (args) => args[args.indexOf("--idempotency-key") + 1];

test("两次独立指令发送相同正文不会共用幂等键", async (t) => {
  const f = await fixture(t);
  await executeTool("send_message", input, { requestScope: "owner-message-one" });
  await executeTool("send_message", input, { requestScope: "owner-message-two" });
  const keys = (await f.sends()).map(keyOf);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
  assert.ok(keys.every((key) => /^[0-9a-f]{32}$/.test(key)));
});

test("缺少请求作用域的独立调用仍各自生成唯一幂等键", async (t) => {
  const f = await fixture(t);
  await executeTool("send_message", input);
  await executeTool("send_message", input);
  const keys = (await f.sends()).map(keyOf);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
});

test("同一用户请求重放同一操作保持幂等键，输入键顺序不影响它", async (t) => {
  const f = await fixture(t);
  const options = { requestScope: "stable-owner-message" };
  await executeTool("send_message", input, options);
  await executeTool("send_message", { text: input.text, open_dingtalk_id: input.open_dingtalk_id }, options);
  const keys = (await f.sends()).map(keyOf);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
});

test("同一请求内不同目标、正文或发送类型使用不同幂等键", async (t) => {
  const f = await fixture(t);
  const options = { requestScope: "multi-operation-message" };
  await executeTool("send_message", input, options);
  await executeTool("send_message", { ...input, open_dingtalk_id: "open-another-fixture-peer" }, options);
  await executeTool("send_message", { ...input, text: "另一条正文" }, options);
  await executeTool("reply_message", { message_id: "msgSOURCE", text: input.text }, options);
  const keys = (await f.sends()).map(keyOf);
  assert.equal(keys.length, 4);
  assert.equal(new Set(keys).size, 4);
});

test("发送和引用回复的内部网络重试均复用首次幂等键", async (t) => {
  const f = await fixture(t, { retryFirstSend: true });
  await executeTool("send_message", input, { requestScope: "retry-send-message" });
  await executeTool("reply_message", { message_id: "msgSOURCE", text: "引用回复" }, { requestScope: "retry-reply-message" });
  const sends = await f.sends();
  assert.equal(sends.length, 4);
  assert.deepEqual(sends[0], sends[1]);
  assert.deepEqual(sends[2], sends[3]);
  assert.notEqual(keyOf(sends[0]), keyOf(sends[2]));
});

test("发送目标缺失或歧义时在执行 CLI 前拒绝，不能按字段顺序猜收件人", async (t) => {
  const f = await fixture(t);
  for (const target of [
    {},
    { conversation_id: " ", open_dingtalk_id: "\t" },
    { conversation_id: "cidOLD_GROUP", open_dingtalk_id: "openINTENDED_PEER" },
    { user_id: "same-user", user_name: "same-user" },
    { group_name: "群名", conversation_id: "cidGROUP" },
  ]) await assert.rejects(executeTool("send_message", { ...target, text: "不要发错对象" }), /必须且只能指定一个目标/);
  assert.deepEqual(await f.commands(), []);
});

test("五种合法发送目标均可单独使用，空白值忽略且实际目标去掉首尾空白", async (t) => {
  const f = await fixture(t);
  const targets = [
    ["conversation_id", "--group", "cidGROUP"],
    ["group_name", "--chat-query", "测试群"],
    ["open_dingtalk_id", "--open-dingtalk-id", "openPEER"],
    ["user_id", "--user", "user-fixture"],
    ["user_name", "--user-query", "测试同事"],
  ];
  for (const [field, flag, value] of targets) {
    await executeTool("send_message", { conversation_id: " ", user_name: "\t", [field]: ` ${value} `, text: "合法单一目标" });
    const sends = await f.sends();
    const args = sends.at(-1);
    assert.equal(args[args.indexOf(flag) + 1], value);
  }
  assert.equal((await f.sends()).length, targets.length);
});

test("读取会话也要求单一目标，歧义时不调用 CLI", async (t) => {
  const f = await fixture(t);
  for (const target of [
    {},
    { conversation_id: " ", open_dingtalk_id: "\t" },
    { conversation_id: "cidGROUP", open_dingtalk_id: "openPEER" },
  ]) await assert.rejects(executeTool("read_messages", target), /必须且只能指定一个目标/);
  assert.deepEqual(await f.commands(), []);
  await executeTool("read_messages", { conversation_id: " cidGROUP ", open_dingtalk_id: " " });
  await executeTool("read_messages", { conversation_id: " ", open_dingtalk_id: " openPEER " });
  const commands = await f.commands();
  assert.equal(commands.length, 2);
  assert.equal(commands[0][commands[0].indexOf("--group") + 1], "cidGROUP");
  assert.equal(commands[1][commands[1].indexOf("--open-dingtalk-id") + 1], "openPEER");
});

test("引用回复的 conversation_id 是原消息上下文，可与 message_id 一起使用", async (t) => {
  const f = await fixture(t);
  await executeTool("reply_message", { conversation_id: "cidSOURCE", message_id: "msgSOURCE", text: "引用回复" });
  const sends = await f.sends();
  assert.equal(sends.length, 1);
  assert.equal(sends[0][sends[0].indexOf("--group") + 1], "cidSOURCE");
  assert.equal(sends[0][sends[0].indexOf("--message-id") + 1], "msgSOURCE");
});
