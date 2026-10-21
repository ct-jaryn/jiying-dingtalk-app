import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runDws } from "./dws.js";
import { attachmentFromBody, urlsFromReadUrls } from "./media.js";
import { stampSentMessage } from "./stamp.js";

const DOWNLOAD_TIMEOUT_MS = 20_000;

// The caller verifies the owner and resolves the DingTalk topic before relaying.
export function createTopicRelay({ chat, root, emotionPath = resolve(root, "data/emotion.json") }) {
  const outboundRoot = resolve(root, "data/outbound");

  return async function relay(payload, record) {
    const targetArgs = relayTargetArgs(record);
    const body = payload?.message?.body || {};
    const attachment = attachmentFromBody(body);
    const messageId = payload?.message?.id || record.topicId || payload?.conversation?.id;
    let contentArgs;
    if (attachment) {
      let url = attachment.directUrl;
      if (!url && attachment.fileIds.length) {
        if (!payload?.conversation?.id || !payload?.message?.id) {
          throw new Error("读取图片缺少即应会话或消息 ID");
        }
        const result = await chat.request("temporary_files.read_urls", {
          conversation_id: payload.conversation.id,
          message_id: payload.message.id,
          file_ids: attachment.fileIds,
        });
        [url] = urlsFromReadUrls(result);
      }
      if (!url) throw new Error("图片消息里没有可下载的文件");
      const path = await downloadToWorkspace(url, messageId || "image", outboundRoot);
      const image = `![图片](${path})`;
      contentArgs = ["--markdown", attachment.caption ? `${attachment.caption}\n\n${image}` : image];
    } else {
      const text = String(body.content || payload?.message?.summary || "").trim();
      if (!text) throw new Error("这条消息没有可转发的文字或图片");
      contentArgs = ["--text", text];
    }

    const sent = await runDws([
      "chat", "+messages-send", "--as", "user", "--ai-tag=false",
      ...targetArgs, ...contentArgs, "--wait-delivery",
      "--idempotency-key", String(messageId || "relay").replace(/[^A-Za-z0-9]/g, "").slice(0, 32) || "relay",
    ], { timeoutMs: 60_000 });
    // A failed decoration must not cause the already-delivered message to resend.
    await stampSentMessage(sent.data, {
      conversationId: record.dingTalkConversationId,
      emotionPath,
    }).catch((error) => console.error("贴使用即应发送失败：", error.message));
    return sent;
  };
}

function relayTargetArgs(record) {
  if (record?.kind === "dm") {
    const id = String(record.openDingTalkId || "").trim();
    if (!id) throw new Error("没有对方的钉钉 ID");
    return ["--open-dingtalk-id", id];
  }
  const id = String(record?.dingTalkConversationId || "").trim();
  if (!id) throw new Error("没有对应的钉钉群会话 ID");
  return ["--group", id];
}

async function downloadToWorkspace(url, baseName, outboundRoot) {
  let response;
  let bytes;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`下载即应图片失败 HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw new Error("下载即应图片超时，请稍后重试", { cause: error });
    }
    // Do not include signed temporary URLs in user-visible errors or logs.
    if (error.message.startsWith("下载即应图片失败 HTTP ")) throw error;
    throw new Error("下载即应图片失败，请稍后重试", { cause: error });
  }
  if (!bytes.length) throw new Error("下载即应图片失败：文件为空");
  const ext = extensionFrom(response.headers.get("content-type"), url);
  const safeName = String(baseName).replace(/[^A-Za-z0-9._-]/g, "_");
  const path = resolve(outboundRoot, `${safeName}${ext}`);
  await mkdir(outboundRoot, { recursive: true });
  await writeFile(path, bytes, { mode: 0o600 });
  return path;
}

function extensionFrom(contentType, url) {
  if (/png/i.test(contentType || "")) return ".png";
  if (/jpe?g/i.test(contentType || "")) return ".jpg";
  if (/gif/i.test(contentType || "")) return ".gif";
  if (/webp/i.test(contentType || "")) return ".webp";
  const match = new URL(url).pathname.match(/\.(png|jpe?g|gif|webp)$/i);
  return match ? `.${match[1].toLowerCase()}` : ".png";
}
