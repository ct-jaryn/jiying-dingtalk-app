import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isRetryable, runDws } from "../src/dws.js";

async function fixture(t, source) {
  const directory = await mkdtemp(join(tmpdir(), "jiying-dws-retry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = join(directory, "calls.jsonl");
  const bin = join(directory, "dws.mjs");
  await writeFile(bin, `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const path = ${JSON.stringify(calls)};
appendFileSync(path, JSON.stringify({args:process.argv.slice(2),time:Date.now()}) + "\\n");
const attempt = readFileSync(path, "utf8").trim().split("\\n").length;
${source}
`);
  await chmod(bin, 0o755);
  return {
    bin,
    calls: async () => {
      try { return (await readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line)); }
      catch (error) { if (error.code === "ENOENT") return []; throw error; }
    },
  };
}

async function timedFixture(t, source) {
  const directory = await mkdtemp(join(tmpdir(), "jiying-dws-deadline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = join(directory, "calls");
  const bin = join(directory, "dws.sh");
  await writeFile(bin, `#!/bin/sh\ncalls='${calls.replaceAll("'", "'\\''")}'\n${source}\n`);
  await chmod(bin, 0o755);
  return { bin, count: async () => (await readFile(calls, "utf8")).trim().split("\n").length };
}

const transientFailure = `
process.stdout.write(JSON.stringify({error:{message:"network temporarily unavailable",retryable:true}}));
process.stderr.write("fixture diagnostic");
process.exitCode = 7;
`;

test("retry decisions preserve structured flags and explicitly nonretryable errors", () => {
  assert.equal(isRetryable(Object.assign(new Error("generic failure"), { data: { error: { retryable: true } } })), true);
  assert.equal(isRetryable(Object.assign(new Error("socket timeout"), { data: { error: { retryable: false } } })), false);
  assert.equal(isRetryable({ retryable: true, error: { retryable: false, message: "ECONNRESET" } }), false);
  assert.equal(isRetryable(new Error("socket timeout", { cause: { retryable: false } })), false);
  assert.equal(isRetryable('{"retryable": false, "message":"timeout"}'), false);
  assert.equal(isRetryable("tls: failed to verify certificate: unknown authority"), true);
  assert.equal(isRetryable(Object.assign(new Error("connection failed"), { code: "ECONNRESET" })), true);
});

test("a transient read failure retries and eventually returns the successful result", async (t) => {
  const fake = await fixture(t, `if (attempt < 3) { ${transientFailure} } else process.stdout.write('{"items":[]}');`);
  const result = await runDws(["chat", "+at-me"], { bin: fake.bin, retries: 3, retryDelayMs: 5, timeoutMs: 10_000 });
  assert.deepEqual(result.data, { items: [] });
  assert.equal((await fake.calls()).length, 3);
});

test("retry exhaustion returns the last CLI diagnostics after the configured attempt limit", async (t) => {
  const fake = await fixture(t, transientFailure);
  await assert.rejects(runDws(["chat", "+conversation-info"], { bin: fake.bin, retries: 2, retryDelayMs: 0, timeoutMs: 10_000 }), (error) => {
    assert.equal(error.exitCode, 7);
    assert.equal(error.data.error.retryable, true);
    assert.equal(error.stderr, "fixture diagnostic");
    return true;
  });
  assert.equal((await fake.calls()).length, 3);
});

test("an explicit retryable:false suppresses retries even for network error messages", async (t) => {
  const fake = await fixture(t, `process.stdout.write(JSON.stringify({error:{message:"socket timeout",retryable:false}}));`);
  await assert.rejects(runDws(["chat", "+at-me"], { bin: fake.bin, retryDelayMs: 0, timeoutMs: 10_000 }), /socket timeout/);
  assert.equal((await fake.calls()).length, 1);
});

test("writes without an idempotency key and unknown commands are never replayed", async (t) => {
  for (const args of [
    ["chat", "+messages-send", "--text", "hello"],
    ["chat", "+messages-send", "--text", "--idempotency-key=fake-key"],
    ["chat", "+messages-reply", "--idempotency-key", ""],
    ["chat", "+messages-send", "--idempotency-key=  "],
    ["chat", "+messages-create-text-emotion"],
    ["chat", "+messages-add-text-emotion"],
    ["unknown", "write"],
  ]) {
    const fake = await fixture(t, transientFailure);
    await assert.rejects(runDws(args, { bin: fake.bin, retryDelayMs: 0, timeoutMs: 10_000 }));
    assert.equal((await fake.calls()).length, 1, args.join(" "));
  }
});

test("send and reply retries reuse the exact nonempty idempotency key", async (t) => {
  for (const args of [
    ["chat", "+messages-send", "--idempotency-key", "key-1"],
    ["chat", "+messages-reply", "--idempotency-key=key-2"],
  ]) {
    const fake = await fixture(t, `if (attempt === 1) { ${transientFailure} } else process.stdout.write('{"messageId":"msg-1"}');`);
    const result = await runDws(args, { bin: fake.bin, retryDelayMs: 0, timeoutMs: 10_000 });
    assert.equal(result.data.messageId, "msg-1");
    const calls = await fake.calls();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args, calls[1].args);
  }
});

test("timeoutMs bounds all retries together, including a stalled later attempt", async (t) => {
  const fake = await timedFixture(t, `
if [ -s "$calls" ]; then
  printf 'call\\n' >> "$calls"
  exec sleep 10
fi
printf 'call\\n' >> "$calls"
printf '{"error":{"message":"network unavailable","retryable":true}}'
exit 7`);
  const started = performance.now();
  await assert.rejects(runDws(["chat", "+at-me"], { bin: fake.bin, retries: 5, retryDelayMs: 5, timeoutMs: 2000 }), { code: "ETIMEDOUT" });
  assert.ok(performance.now() - started < 2400, "must not allocate a fresh timeout for each attempt");
  assert.equal(await fake.count(), 2);
});

test("a backoff that would exceed the shared deadline does not start another command", async (t) => {
  const fake = await timedFixture(t, `printf 'call\\n' >> "$calls"
printf '{"error":{"message":"network unavailable","retryable":true}}'
exit 7`);
  const started = performance.now();
  await assert.rejects(runDws(["chat", "+at-me"], { bin: fake.bin, retries: 5, retryDelayMs: 5000, timeoutMs: 2000 }));
  assert.equal(await fake.count(), 1);
  assert.ok(performance.now() - started < 2400);
});

test("a stalled write without an idempotency key executes once", async (t) => {
  const fake = await timedFixture(t, `printf 'call\\n' >> "$calls"\nexec sleep 10`);
  await assert.rejects(runDws(["chat", "+messages-send"], { bin: fake.bin, retryDelayMs: 0, timeoutMs: 1000 }), { code: "ETIMEDOUT" });
  assert.equal(await fake.count(), 1);
});
