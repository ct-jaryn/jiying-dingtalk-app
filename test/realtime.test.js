import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WebSocketServer } from "ws";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pause = (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms));

async function waitFor(check, description, diagnostics = () => "", timeoutMs = 8000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await pause(20);
  }
  throw new Error(`等待 ${description} 超时\n${diagnostics()}`);
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const { port } = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function fixture(t, { events, mentions = [], port = 0, initiallyOffline = false, failOnce = "" }) {
  const directory = await mkdtemp(join(tmpdir(), "jiying-realtime-test-"));
  const servers = [];
  const requests = [];
  const delivered = [];
  const failed = new Set();
  let child;
  let output = "";
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolveClose) => child.once("close", resolveClose));
      child.kill("SIGTERM");
      let timer;
      const timeout = new Promise((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(false), 4500); });
      const exited = await Promise.race([closed.then(() => true), timeout]);
      clearTimeout(timer);
      if (!exited) { child.kill("SIGKILL"); await closed; }
    }
    // Also clean up the fixture listener if an assertion required killing the
    // parent before its own graceful shutdown could stop dws.
    try {
      const pid = Number(await readFile(join(directory, "event.pid"), "utf8"));
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGTERM");
    } catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error; }
    for (const server of servers) {
      for (const client of server.clients) client.terminate();
      await new Promise((resolveClose) => server.close(() => resolveClose()));
    }
    await rm(directory, { recursive: true, force: true });
  });

  await cp(join(project, "src"), join(directory, "src"), { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }));
  await symlink(join(project, "node_modules"), join(directory, "node_modules"), "dir");
  await mkdir(join(directory, "bin"));
  await writeFile(join(directory, "events.json"), JSON.stringify(events));
  await writeFile(join(directory, "mentions.json"), JSON.stringify(mentions));
  const fakeDws = join(directory, "bin", "dws");
  await writeFile(fakeDws, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const root = process.env.REALTIME_FIXTURE_ROOT;
appendFileSync(join(root, "calls.jsonl"), JSON.stringify(args) + "\\n");
if (args[0] === "event" && args[1] === "consume") {
  writeFileSync(join(root, "event.pid"), String(process.pid));
  process.stderr.write("[event] ready event_count=3\\n");
  for (const event of JSON.parse(readFileSync(join(root, "events.json"), "utf8"))) {
    process.stdout.write(JSON.stringify(event) + "\\n");
  }
  setInterval(() => {}, 1000);
} else if (args[0] === "chat" && args[1] === "+at-me") {
  process.stdout.write(JSON.stringify({ items: JSON.parse(readFileSync(join(root, "mentions.json"), "utf8")), complete: true }));
} else if (args[0] === "chat" && args[1] === "+conversation-info") {
  process.stdout.write(JSON.stringify({ conversationInfo: { title: "集成验证群" } }));
} else {
  process.stdout.write(JSON.stringify({ success: false, errorMsg: "不应调用的 fixture 命令: " + args.join(" ") }));
  process.exitCode = 9;
}
`);
  await chmod(fakeDws, 0o755);

  async function startServer(selectedPort = port) {
    const server = new WebSocketServer({ host: "127.0.0.1", port: selectedPort });
    servers.push(server);
    await new Promise((resolveListen, reject) => {
      server.once("listening", resolveListen);
      server.once("error", reject);
    });
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const envelope = JSON.parse(raw.toString());
        requests.push(envelope);
        const content = envelope.payload?.message?.content || "";
        const shouldFail = envelope.method === "message.send" && failOnce && content.includes(failOnce) && !failed.has(failOnce);
        if (shouldFail) failed.add(failOnce);
        else if (envelope.method === "message.send") delivered.push(content);
        socket.send(JSON.stringify({
          v: 1, kind: "response", reply_to: envelope.id, ok: !shouldFail,
          ...(shouldFail ? { error: { code: "FIXTURE_TRANSIENT", message: "本地测试瞬时发送失败" } } : { payload: { message_id: "fixture-response" } }),
        }));
      });
    });
    return server.address().port;
  }

  const selectedPort = initiallyOffline ? port : await startServer();
  await writeFile(join(directory, "config.yaml"), JSON.stringify({
    anthropic: { base_url: "http://127.0.0.1:1", model: "dummy-model", api_key: "dummy-model-key" },
    magicchat: { ws_url: `ws://127.0.0.1:${selectedPort}`, app_id: "dummy-app", app_secret: "dummy-secret", user_id: "dummy-user" },
  }));
  child = spawn(process.execPath, ["src/index.js"], {
    cwd: directory,
    env: { ...process.env, PATH: `${join(directory, "bin")}:${process.env.PATH || ""}`, REALTIME_FIXTURE_ROOT: directory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (text) => { output += text; });
  child.stderr.on("data", (text) => { output += text; });
  child.on("error", (error) => { output += `\n${error.stack}`; });
  const diagnostics = () => `child exit=${child.exitCode} signal=${child.signalCode}\n${output}`;
  return {
    directory, delivered, requests, failed, diagnostics, startServer,
    readOutbox: () => readJson(join(directory, "data", "push-outbox.json"), null),
    async calls() {
      try { return (await readFile(join(directory, "calls.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); }
      catch (error) { if (error.code === "ENOENT") return []; throw error; }
    },
  };
}

const group = (message_id, content, type = "user_im_message_receive_group_all") => ({
  type, message_id, conversation_id: "fixture-muted-group", sender: "测试同事", content, timestamp: 1_792_539_000_000,
});

test("真实进程通过群事件补查 @，去重并向即应实时投递，发送失败自动重试", { timeout: 15_000 }, async (t) => {
  const app = await fixture(t, {
    events: [
      group("fallback", "TARGET_FALLBACK 请处理"),
      group("ordinary", "ORDINARY_DO_NOT_NOTIFY"),
      group("native", "NATIVE_DUPLICATE", "user_im_message_receive_at"),
      group("native", "NATIVE_DUPLICATE"),
      group("all", "@所有人 ALL_BROADCAST"),
      group("dm", "DIRECT_MESSAGE_RETRY", "user_im_message_receive_o2o_all"),
    ],
    mentions: [
      { messageId: "fallback", conversationId: "fixture-muted-group", conversation: { name: "集成验证群" } },
      { messageId: "native", conversationId: "fixture-muted-group", conversation: { name: "集成验证群" } },
    ],
    failOnce: "DIRECT_MESSAGE_RETRY",
  });
  await waitFor(async () => {
    const outbox = await app.readOutbox();
    return app.delivered.length === 4 && Object.keys(outbox?.delivered || {}).length === 4;
  }, "四类相关通知落盘完成", app.diagnostics);
  for (const marker of ["TARGET_FALLBACK", "NATIVE_DUPLICATE", "ALL_BROADCAST", "DIRECT_MESSAGE_RETRY"]) {
    assert.equal(app.delivered.filter((text) => text.includes(marker)).length, 1, marker);
  }
  assert.equal(app.delivered.some((text) => text.includes("ORDINARY_DO_NOT_NOTIFY")), false);
  assert.match(app.delivered.find((text) => text.includes("TARGET_FALLBACK")), /集成验证群/);
  assert.equal(app.failed.size, 1);
  assert.equal(app.requests.filter((item) => item.method === "message.send" && item.payload.message.content.includes("DIRECT_MESSAGE_RETRY")).length, 2);
  const calls = await app.calls();
  assert.ok(calls.some((args) => args[0] === "event" && args[1] === "consume"));
  assert.ok(calls.some((args) => args[0] === "chat" && args[1] === "+at-me"));
  assert.equal(calls.some((args) => args.includes("user-settings")), false, "@通知不受群免打扰查询阻挡");
});

test("即应初始离线时真实进程先收取并持久化，连接恢复后自动投递", { timeout: 15_000 }, async (t) => {
  const port = await unusedPort();
  const app = await fixture(t, {
    port, initiallyOffline: true,
    events: [group("offline-dm", "OFFLINE_PENDING", "user_im_message_receive_o2o_all")],
  });
  await waitFor(async () => {
    const outbox = await app.readOutbox();
    return outbox?.pending?.some((item) => item.event.message_id === "offline-dm");
  }, "即应离线期间收到的钉钉通知落盘", app.diagnostics);
  assert.equal(app.delivered.length, 0);
  assert.ok((await app.calls()).some((args) => args[0] === "event" && args[1] === "consume"));
  await app.startServer(port);
  await waitFor(async () => {
    const outbox = await app.readOutbox();
    return app.delivered.length === 1 && outbox?.pending?.length === 0;
  }, "重连后发送已保留通知", app.diagnostics);
  assert.match(app.delivered[0], /OFFLINE_PENDING/);
});
