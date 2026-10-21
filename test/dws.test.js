import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runDws, startEventStream } from "../src/dws.js";

async function fakeDws(t, source) {
  const directory = await mkdtemp(join(tmpdir(), "jiying-dws-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, "fake-dws.mjs");
  await writeFile(bin, `#!${process.execPath}\n${source}\n`);
  await chmod(bin, 0o755);
  return bin;
}

function consume(t, bin, callbacks = {}) {
  return new Promise((resolve, reject) => {
    const child = startEventStream({
      bin,
      ...callbacks,
      onExit(code, signal) {
        clearTimeout(timer);
        callbacks.onExit?.(code, signal);
        resolve({ code, signal });
      },
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("fixture did not finish"));
    }, 3000);
    t.after(() => {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill("SIGTERM");
    });
  });
}

test("runDws waits for pipe closure, including output after the process exit", async (t) => {
  const bin = await fakeDws(t, `
    import { spawn } from "node:child_process";
    spawn(process.execPath, ["-e", 'setTimeout(() => process.stdout.write(JSON.stringify({success:true,text:"群聊"})), 60)'], {
      stdio: ["ignore", process.stdout, "ignore"],
    });
    process.exit(0);
  `);
  const result = await runDws(["chat", "query"], { bin, timeoutMs: 2000 });
  assert.equal(result.code, 0);
  assert.deepEqual(result.data, { success: true, text: "群聊" });
});

test("runDws rejects nonzero JSON results and keeps diagnostics", async (t) => {
  const bin = await fakeDws(t, `
    process.stdout.write(JSON.stringify({error:{message:"access denied",code:"AUTH"}}));
    process.stderr.write("fixture diagnostic");
    process.exitCode = 7;
  `);
  await assert.rejects(runDws(["chat"], { bin }), (error) => {
    assert.equal(error.code, 7);
    assert.equal(error.exitCode, 7);
    assert.equal(error.data.error.code, "AUTH");
    assert.equal(error.stderr, "fixture diagnostic");
    assert.match(error.message, /access denied/);
    return true;
  });
});

test("runDws rejects business failures even when the process succeeds", async (t) => {
  for (const payload of [
    { success: false, errorCode: "FORBIDDEN", errorMsg: "not permitted" },
    { error: { code: "BACKEND", message: "backend unavailable" } },
  ]) {
    const bin = await fakeDws(t, `process.stdout.write(${JSON.stringify(JSON.stringify(payload))});`);
    await assert.rejects(runDws(["chat"], { bin }), (error) => {
      assert.equal(error.code, 0);
      assert.deepEqual(error.data, payload);
      assert.match(error.message, /not permitted|backend unavailable/);
      return true;
    });
  }
});

test("runDws times out and safely handles a missing executable", async (t) => {
  const bin = await fakeDws(t, "setInterval(() => {}, 1000);");
  await assert.rejects(runDws(["chat"], { bin, timeoutMs: 50, retries: 0 }), { code: "ETIMEDOUT" });
  await assert.rejects(runDws(["chat"], { bin: `${bin}.missing`, timeoutMs: 100 }), { code: "ENOENT" });
});

test("event stream preserves split UTF-8, trailing JSON and split ready markers", async (t) => {
  const bin = await fakeDws(t, `
    const output = Buffer.from(JSON.stringify({content:"你好😀"}) + "\\n" + JSON.stringify({id:"tail"}));
    const cut = output.indexOf(Buffer.from("你")) + 1;
    process.stdout.write(output.subarray(0, cut));
    process.stderr.write("[eve");
    setTimeout(() => {
      process.stdout.write(output.subarray(cut));
      process.stderr.write("nt] re");
    }, 20);
    setTimeout(() => process.stderr.write("ady event_count=3\\n[event] ready duplicate\\n"), 40);
  `);
  const events = [];
  const errors = [];
  let readyCount = 0;
  const exit = await consume(t, bin, {
    onEvent: (event) => events.push(event),
    onReady: () => { readyCount += 1; },
    onError: (error) => errors.push(error),
  });
  assert.equal(exit.code, 0);
  assert.deepEqual(events, [{ content: "你好😀" }, { id: "tail" }]);
  assert.equal(readyCount, 1);
  assert.deepEqual(errors, []);
});

test("event stream reports malformed records and async handler failures without stopping", async (t) => {
  const bin = await fakeDws(t, `process.stdout.write('not-json\\n{"id":"valid"}\\n');`);
  const errors = [];
  const events = [];
  await consume(t, bin, {
    onEvent: async (event) => {
      events.push(event);
      throw new Error("async processing failed");
    },
    onError: (error) => errors.push(error),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [{ id: "valid" }]);
  assert.equal(errors.length, 2);
  assert.match(errors[0].message, /无法解析钉钉事件/);
  assert.equal(errors[1].message, "async processing failed");
});

test("a stream spawn failure reports one error and only one exit callback", async (t) => {
  const bin = await fakeDws(t, "");
  const errors = [];
  let exitCount = 0;
  const child = startEventStream({
    bin: `${bin}.missing`,
    onError: (error) => errors.push(error),
    onExit: () => { exitCount += 1; },
  });
  await new Promise((resolve) => child.once("close", resolve));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "ENOENT");
  assert.equal(exitCount, 1);
});
