import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDws } from "./dws.js";
import { createMediaError, mediaError } from "./media-errors.js";

export const MEDIA_REQUEST_TIMEOUT_MS = 12_000;

const NOTICE = "注意：如需下载使用dws chat message download-media命令下载";

export function attachmentFromBody(body) {
  if (!body || !["image", "file"].includes(body.type)) return null;
  const fileIds = [];
  for (const value of [body.file_id, body.fileId, body.image?.file_id, body.image?.fileId]) {
    if (value) fileIds.push(String(value));
  }
  for (const list of [body.file_ids, body.fileIds, body.files, body.attachments]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item === "string") fileIds.push(item);
      else if (item?.id) fileIds.push(String(item.id));
      else if (item?.file_id) fileIds.push(String(item.file_id));
    }
  }
  const directUrl = /^https?:\/\//.test(String(body.content || "")) ? String(body.content) : "";
  return {
    type: body.type,
    fileIds: [...new Set(fileIds)],
    directUrl,
    caption: String(body.caption || "").trim(),
  };
}

export function urlsFromReadUrls(payload) {
  const found = [];
  walkUrls(payload, found);
  return [...new Set(found.filter((url) => /^https?:\/\//.test(url)))];
}

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

export async function downloadImageUrl({ messageId, conversationId, mediaId }, { query = runDws, timeoutMs = MEDIA_REQUEST_TIMEOUT_MS } = {}) {
  let directory;
  try {
    // The CLI requires a local output file even when the destination needs its
    // download URL. Keep that mandatory download temporary, including failures.
    directory = await mkdtemp(join(tmpdir(), "jiying-media-"));
    const result = await query([
      "chat", "message", "download-media",
      "--type", "mediaId",
      "--resource-id", mediaId,
      "--message-id", messageId,
      "--open-conversation-id", conversationId,
      "--output", join(directory, "download.bin"),
    ], { timeoutMs: Math.max(1, Math.min(MEDIA_REQUEST_TIMEOUT_MS, Number(timeoutMs) || MEDIA_REQUEST_TIMEOUT_MS)), retries: 0 });
    const url = publicImageUrl(findDownloadUrl(result.data));
    if (!url) throw createMediaError("MEDIA_URL_MISSING");
    return url;
  } catch (error) {
    throw mediaError(error);
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
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
