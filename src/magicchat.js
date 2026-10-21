import { randomUUID } from "node:crypto";
import WebSocket from "ws";

export class MagicChat {
  constructor({ url, appId, secret }) {
    this.url = url;
    this.appId = appId;
    this.secret = secret;
    this.ws = null;
    this.pending = new Map();
    this.onEvent = async () => {};
    this.onClose = () => {};
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, {
        headers: {
          "X-MagicChat-App-ID": this.appId,
          Authorization: `Bearer ${this.secret}`,
        },
      });
      this.ws = ws;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      ws.once("open", () => {
        settled = true;
        resolve();
      });
      ws.once("unexpected-response", (_req, res) => fail(new Error(`即应握手失败：HTTP ${res.statusCode}`)));
      ws.once("error", fail);
      ws.on("message", (raw) => {
        this.#handle(raw).catch((error) => console.error("处理即应消息失败：", error.message));
      });
      ws.on("close", () => {
        this.#rejectAll(new Error("即应连接已关闭"));
        this.onClose();
      });
    });
  }

  close() {
    this.ws?.close();
  }

  request(method, payload, id = randomUUID()) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("即应连接未就绪"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`${method} 超时`), { code: "timeout" }));
      }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ v: 1, kind: "request", id, method, payload }));
    });
  }

  async #handle(raw) {
    const envelope = JSON.parse(raw.toString());
    if (envelope.kind === "response") {
      const current = this.pending.get(envelope.reply_to);
      if (!current) return;
      clearTimeout(current.timer);
      this.pending.delete(envelope.reply_to);
      if (envelope.ok) current.resolve(envelope.payload);
      else current.reject(Object.assign(new Error(envelope.error?.message || "即应请求失败"), envelope.error));
      return;
    }
    if (envelope.kind === "event") await this.onEvent(envelope);
  }

  #rejectAll(error) {
    for (const [id, current] of this.pending) {
      clearTimeout(current.timer);
      current.reject(error);
      this.pending.delete(id);
    }
  }
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
