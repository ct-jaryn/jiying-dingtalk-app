import { randomUUID } from "node:crypto";
import WebSocket from "ws";

export class MagicChat {
  constructor({ url, appId, secret, handshakeTimeoutMs = 15_000, heartbeatIntervalMs = 30_000, heartbeatTimeoutMs = 10_000, requestTimeoutMs = 20_000 }) {
    this.url = url;
    this.appId = appId;
    this.secret = secret;
    this.ws = null;
    this.pending = new Map();
    this.connections = new WeakMap();
    this.handshakeTimeoutMs = duration(handshakeTimeoutMs, 15_000);
    this.heartbeatIntervalMs = duration(heartbeatIntervalMs, 30_000);
    this.heartbeatTimeoutMs = duration(heartbeatTimeoutMs, 10_000);
    this.requestTimeoutMs = duration(requestTimeoutMs, 20_000);
    this.onEvent = async () => {};
    this.onClose = () => {};
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, {
        handshakeTimeout: this.handshakeTimeoutMs,
        headers: {
          "X-MagicChat-App-ID": this.appId,
          Authorization: `Bearer ${this.secret}`,
        },
      });
      const previous = this.ws;
      this.ws = ws;
      const state = { heartbeat: null, pongDeadline: null, pingToken: null, closing: false };
      this.connections.set(ws, state);
      if (previous && previous !== ws) this.#disconnect(previous, new Error("即应连接已替换"));
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      ws.once("open", () => {
        settled = true;
        this.#schedulePing(ws);
        resolve();
      });
      ws.once("unexpected-response", (req, res) => {
        const error = new Error(`即应握手失败：HTTP ${res.statusCode}`);
        fail(error);
        // Handling this event disables ws's own abort path. Destroy both the
        // rejected HTTP response and its request rather than leaving them open.
        this.#disconnect(ws, error);
        res.destroy();
        req.destroy();
      });
      // Keep an error listener for the complete lifetime, including aborts
      // during CONNECTING and errors emitted after the connection opened.
      ws.on("error", (error) => {
        fail(error);
        this.#disconnect(ws, error);
      });
      ws.on("message", (raw) => {
        if (this.ws !== ws) return;
        this.#handle(raw, ws).catch((error) => console.error("处理即应消息失败：", error.message));
      });
      ws.on("pong", (data) => {
        if (!state.pingToken || data.toString() !== state.pingToken) return;
        clearTimeout(state.pongDeadline);
        state.pongDeadline = null;
        state.pingToken = null;
        this.#schedulePing(ws);
      });
      ws.on("close", () => {
        const error = new Error("即应连接已关闭");
        fail(error);
        this.#clearHeartbeat(ws);
        this.#rejectFor(ws, error);
        if (this.ws !== ws) return;
        this.ws = null;
        try {
          Promise.resolve(this.onClose()).catch((error) => console.error("处理即应断线失败：", error.message));
        } catch (error) {
          console.error("处理即应断线失败：", error.message);
        }
      });
    });
  }

  close() {
    const ws = this.ws;
    if (!ws) return;
    this.#clearHeartbeat(ws);
    this.#rejectFor(ws, new Error("即应连接已关闭"));
    if (ws.readyState === WebSocket.CONNECTING) this.#disconnect(ws, new Error("即应连接已关闭"));
    else ws.close();
  }

  request(method, payload, id = randomUUID()) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("即应连接未就绪"));
    if (this.pending.has(id)) return Promise.reject(new Error("即应请求 ID 重复"));
    let frame;
    try { frame = JSON.stringify({ v: 1, kind: "request", id, method, payload }); }
    catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.get(id)?.ws !== ws) return;
        this.pending.delete(id);
        reject(Object.assign(new Error(`${method} 超时`), { code: "timeout" }));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, ws });
      try {
        ws.send(frame, (error) => { if (error) this.#disconnect(ws, error); });
      } catch (error) {
        this.#disconnect(ws, error);
      }
    });
  }

  async #handle(raw, ws) {
    const envelope = JSON.parse(raw.toString());
    if (envelope.kind === "response") {
      const current = this.pending.get(envelope.reply_to);
      if (!current || current.ws !== ws) return;
      clearTimeout(current.timer);
      this.pending.delete(envelope.reply_to);
      if (envelope.ok) current.resolve(envelope.payload);
      else current.reject(Object.assign(new Error(envelope.error?.message || "即应请求失败"), envelope.error));
      return;
    }
    if (envelope.kind === "event") await this.onEvent(envelope);
  }

  #rejectFor(ws, error) {
    for (const [id, current] of this.pending) {
      if (current.ws !== ws) continue;
      clearTimeout(current.timer);
      current.reject(error);
      this.pending.delete(id);
    }
  }

  #clearHeartbeat(ws) {
    const state = this.connections.get(ws);
    if (!state) return;
    state.closing = true;
    clearTimeout(state.heartbeat);
    clearTimeout(state.pongDeadline);
    state.heartbeat = null;
    state.pongDeadline = null;
    state.pingToken = null;
  }

  #disconnect(ws, error) {
    this.#clearHeartbeat(ws);
    this.#rejectFor(ws, error);
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  }

  #schedulePing(ws) {
    const state = this.connections.get(ws);
    if (!state || state.closing || this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
    clearTimeout(state.heartbeat);
    state.heartbeat = setTimeout(() => {
      if (state.closing || this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      state.pingToken = randomUUID();
      state.pongDeadline = setTimeout(() => {
        this.#disconnect(ws, Object.assign(new Error("即应心跳响应超时"), { code: "heartbeat_timeout" }));
      }, this.heartbeatTimeoutMs);
      state.pongDeadline.unref?.();
      try {
        ws.ping(state.pingToken, (error) => { if (error) this.#disconnect(ws, error); });
      } catch (error) {
        this.#disconnect(ws, error);
      }
    }, this.heartbeatIntervalMs);
    state.heartbeat.unref?.();
  }
}

function duration(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.trunc(value)) : fallback;
}

export function startStatus(chat, conversationId) {
  let timer;
  let text = "";
  const send = () => {
    if (!text) return;
    chat.request("conversation.status", { conversation_id: conversationId, status: text.slice(0, 32) }).catch(() => {});
  };
  return {
    set(next) {
      text = next;
      send();
      clearInterval(timer);
      timer = setInterval(send, 2500);
    },
    stop() {
      text = "";
      clearInterval(timer);
    },
  };
}
