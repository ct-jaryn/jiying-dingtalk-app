import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { MagicChat } from "../src/magicchat.js";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, description) {
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    if (check()) return;
    await pause(10);
  }
  throw new Error(`等待 ${description} 超时`);
}

async function listen(t, server) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { url: `ws://127.0.0.1:${server.address().port}`, sockets };
}

async function wsServer(t, options = {}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, ...options });
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  return { server, url: `ws://127.0.0.1:${server.address().port}` };
}

function client(t, url, options = {}) {
  const chat = new MagicChat({ url, appId: "fixture-app", secret: "fixture-secret", ...options });
  t.after(() => chat.close());
  return chat;
}

test("TCP连接建立后HTTP升级无响应时，握手期限会拒绝并清理socket", async (t) => {
  const { url, sockets } = await listen(t, createTcpServer((socket) => socket.on("data", () => {})));
  const chat = client(t, url, { handshakeTimeoutMs: 100 });
  await assert.rejects(chat.connect(), /timed out/i);
  await waitFor(() => sockets.size === 0 && chat.ws === null, "握手连接清理");
  assert.equal(chat.pending.size, 0);
});

test("连续502握手失败会完整关闭每次HTTP连接而不积累CONNECTING实例", async (t) => {
  const { url, sockets } = await listen(t, createServer((_request, response) => {
    response.writeHead(502, { Connection: "keep-alive", "Content-Type": "text/plain" });
    response.end("fixture unavailable");
  }));
  const chat = client(t, url);
  const attempts = [];
  for (let index = 0; index < 3; index++) {
    const connecting = chat.connect();
    attempts.push(chat.ws);
    await assert.rejects(connecting, /HTTP 502/);
  }
  await waitFor(() => sockets.size === 0 && attempts.every((socket) => socket.readyState === WebSocket.CLOSED), "失败HTTP连接关闭");
  assert.equal(chat.pending.size, 0);
});

test("空闲健康连接持续ping/pong，业务请求仍可正常返回", async (t) => {
  const { server, url } = await wsServer(t);
  let pings = 0;
  server.on("connection", (socket) => {
    socket.on("ping", () => pings++);
    socket.on("message", (raw) => {
      const request = JSON.parse(raw.toString());
      socket.send(JSON.stringify({ kind: "response", reply_to: request.id, ok: true, payload: { result: "fixture-ok" } }));
    });
  });
  const chat = client(t, url, { heartbeatIntervalMs: 25, heartbeatTimeoutMs: 300 });
  let closes = 0;
  chat.onClose = () => closes++;
  await chat.connect();
  await waitFor(() => pings >= 3, "多个空闲心跳");
  assert.equal(chat.ws.readyState, WebSocket.OPEN);
  assert.deepEqual(await chat.request("fixture.read", {}), { result: "fixture-ok" });
  assert.equal(closes, 0);
  assert.equal(chat.pending.size, 0);
});

test("半开连接没有pong时主动断开并立即拒绝其在途请求，触发一次恢复回调", async (t) => {
  const { server, url } = await wsServer(t, { autoPong: false });
  let pings = 0;
  server.on("connection", (socket) => socket.on("ping", () => pings++));
  const chat = client(t, url, { heartbeatIntervalMs: 25, heartbeatTimeoutMs: 100, requestTimeoutMs: 2000 });
  let closes = 0;
  chat.onClose = () => closes++;
  await chat.connect();
  await assert.rejects(chat.request("fixture.read", {}), { code: "heartbeat_timeout" });
  await waitFor(() => closes === 1 && chat.ws === null, "心跳断开回调");
  await pause(50);
  assert.equal(closes, 1);
  assert.equal(chat.pending.size, 0);
  assert.equal(pings, 1);
});

test("不匹配当前ping的pong不能掩盖连接失效", async (t) => {
  const { server, url } = await wsServer(t, { autoPong: false });
  server.on("connection", (socket) => socket.on("ping", () => socket.pong("unrelated-fixture-pong")));
  const chat = client(t, url, { heartbeatIntervalMs: 25, heartbeatTimeoutMs: 100 });
  let closed = false;
  chat.onClose = () => { closed = true; };
  await chat.connect();
  await waitFor(() => closed, "不匹配pong后的断线");
  assert.equal(chat.ws, null);
});

test("替换连接后旧socket迟到的关闭和响应不会取消或污染新请求", async (t) => {
  const { server, url } = await wsServer(t);
  let latest;
  let latestRequest;
  server.on("connection", (socket) => {
    latest = socket;
    socket.on("message", (raw) => { latestRequest = JSON.parse(raw.toString()); });
  });
  const chat = client(t, url);
  let closes = 0;
  chat.onClose = () => closes++;
  await chat.connect();
  const old = chat.ws;
  const oldResult = chat.request("fixture.old", {}, "same-fixture-id").catch((error) => error);
  await chat.connect();
  assert.match((await oldResult).message, /连接已替换/);
  const current = chat.ws;
  const currentResult = chat.request("fixture.current", {}, "same-fixture-id");
  await waitFor(() => latestRequest?.method === "fixture.current", "新连接业务请求");
  old.emit("close");
  old.emit("message", Buffer.from(JSON.stringify({ kind: "response", reply_to: "same-fixture-id", ok: true, payload: { source: "old" } })));
  assert.equal(chat.ws, current);
  assert.equal(chat.pending.size, 1);
  assert.equal(closes, 0);
  latest.send(JSON.stringify({ kind: "response", reply_to: "same-fixture-id", ok: true, payload: { source: "current" } }));
  assert.deepEqual(await currentResult, { source: "current" });
  assert.equal(chat.pending.size, 0);
});

test("CONNECTING期间主动关闭会终止握手，重复关闭不会重复回调或留下请求", async (t) => {
  const { url, sockets } = await listen(t, createTcpServer((socket) => socket.on("data", () => {})));
  const chat = client(t, url);
  let closes = 0;
  chat.onClose = () => closes++;
  const connecting = chat.connect().catch((error) => error);
  await waitFor(() => sockets.size === 1, "本地TCP接入");
  chat.close();
  assert.ok(await connecting instanceof Error);
  await waitFor(() => sockets.size === 0 && chat.ws === null, "主动关闭握手");
  chat.close();
  chat.close();
  assert.equal(closes, 1);
  assert.equal(chat.pending.size, 0);
});

test("业务请求超时或序列化失败会清理自身请求，不破坏健康socket", async (t) => {
  const { url } = await wsServer(t);
  const chat = client(t, url, { requestTimeoutMs: 60 });
  await chat.connect();
  await assert.rejects(chat.request("fixture.read", {}), { code: "timeout" });
  assert.equal(chat.pending.size, 0);
  const circular = {};
  circular.self = circular;
  await assert.rejects(chat.request("fixture.read", circular), /circular/i);
  assert.equal(chat.pending.size, 0);
  assert.equal(chat.ws.readyState, WebSocket.OPEN);
});
