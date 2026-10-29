import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { callModel, runAgent } from "../src/agent.js";

async function fixture(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const config = {
    anthropic: { base_url: `http://127.0.0.1:${server.address().port}`, api_key: "fixture", model: "fixture", request_timeout_ms: 150 },
    agent: { max_rounds: 1, max_context_tokens: 1000 },
  };
  return config;
}

const valid = { content: [{ type: "text", text: "正常回复" }], stop_reason: "end_turn" };

test("模型未返回响应头时也会中止请求，后续指令仍可处理", { timeout: 5000 }, async (t) => {
  let stalled = true;
  const config = await fixture(t, (_req, res) => {
    if (stalled) return;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(valid));
  });
  const input = { config, session: { summary: "", messages: [] }, pushIndex: [], instruction: "测试" };
  await assert.rejects(runAgent(input), { code: "MODEL_TIMEOUT" });
  stalled = false;
  assert.equal(await runAgent(input), "正常回复");
});

test("模型只返回响应头但响应体挂住时仍受同一预算限制", { timeout: 5000 }, async (t) => {
  let sentHeaders = false;
  const config = await fixture(t, (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.writeHead(200);
    res.flushHeaders();
    res.write('{"content":[');
    sentHeaders = true;
  });
  await assert.rejects(callModel(config, [], "", [], false), { code: "MODEL_TIMEOUT" });
  assert.equal(sentHeaders, true);
});

test("模型返回无效 JSON 或缺少 content 时明确报错", async (t) => {
  let payload = "not json";
  const config = await fixture(t, (_req, res) => res.end(payload));
  await assert.rejects(callModel(config, [], "", [], false), /无效的 JSON/);
  payload = JSON.stringify({ result: "wrong protocol" });
  await assert.rejects(callModel(config, [], "", [], false), /content 数组/);
});

test("HTTP 错误保留服务端原因，非 JSON 错误保留状态码", async (t) => {
  let payload = JSON.stringify({ error: { message: "fixture quota error" } });
  const config = await fixture(t, (_req, res) => { res.statusCode = 503; res.end(payload); });
  await assert.rejects(callModel(config, [], "", [], false), /fixture quota error/);
  payload = "service unavailable";
  await assert.rejects(callModel(config, [], "", [], false), /HTTP 503/);
});
