import { mkdir } from "node:fs/promises";
import { runDws } from "./dws.js";

const NOTICE = "注意：如需下载使用dws chat message download-media命令下载";

export function extractMediaIds(text) {
  const ids = [];
  const re = /mediaId=([^)\s]+)/g;
  let match;
  while ((match = re.exec(String(text || "")))) ids.push(decodeURIComponent(match[1]));
  return [...new Set(ids)];
}

export function isImageContent(text) {
  const value = String(text || "");
  return value.includes("图片消息") || extractMediaIds(value).length > 0;
}

export function textWithoutImages(text) {
  return String(text || "")
    .replace(/\[[^\]]*图片消息[^\]]*\]\(mediaId=[^)]+\)/g, "")
    .replace(/\[图片消息\]\(mediaId=[^)]+\)/g, "")
    .replace(NOTICE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function imageResourceIds(detail) {
  const refs = [];
  walk(detail, refs);
  const images = refs.filter((item) => item.contentType === "image" && item.resourceId);
  const chosen = images.length ? images : refs.filter((item) => item.resourceId);
  return [...new Set(chosen.map((item) => item.resourceId))];
}

export function findDownloadUrl(payload) {
  const found = [];
  walkUrls(payload, found);
  return found.find((url) => /^https?:\/\//i.test(url)) || "";
}

export async function downloadImageUrl({ messageId, conversationId, mediaId }) {
  await mkdir("data/media", { recursive: true });
  const output = `data/media/${safeName(messageId)}-${safeName(mediaId).slice(0, 24)}.bin`;
  const result = await runDws([
    "chat", "message", "download-media",
    "--type", "mediaId",
    "--resource-id", mediaId,
    "--message-id", messageId,
    "--open-conversation-id", conversationId,
    "--output", output,
  ], { timeoutMs: 60_000 });
  const url = publicImageUrl(findDownloadUrl(result.data));
  if (!url) throw new Error("下载图片没有返回可访问的地址");
  return url;
}

export function publicImageUrl(url) {
  if (url.startsWith("http://") && url.includes(".aliyuncs.com/")) return `https://${url.slice("http://".length)}`;
  return url;
}

function walk(value, refs) {
  if (!value || typeof value !== "object") return;
  if (value.resourceId && (value.resourceIdType === "mediaId" || value.type === "mediaId")) refs.push(value);
  for (const child of Object.values(value)) walk(child, refs);
}

function walkUrls(value, found) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && /url/i.test(key)) found.push(child);
    else walkUrls(child, found);
  }
}

function safeName(value) {
  return String(value || "image").replace(/[^A-Za-z0-9._-]/g, "_");
}
