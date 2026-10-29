const FAILURES = {
  MEDIA_PERMISSION_DENIED: { message: "没有读取图片的权限", permanent: true },
  MEDIA_RESOURCE_INVALID: { message: "图片资源 ID 已失效", permanent: true },
  MEDIA_RESOURCE_MISSING: { message: "图片资源不存在或已过期", permanent: true },
  MEDIA_FORMAT_UNSUPPORTED: { message: "图片格式不支持", permanent: true },
  MEDIA_TIMEOUT: { message: "读取图片超时", permanent: false },
  MEDIA_NETWORK: { message: "图片服务暂时无法连接", permanent: false },
  MEDIA_URL_MISSING: { message: "图片服务未返回可用地址", permanent: false },
  MEDIA_DOWNLOAD_FAILED: { message: "暂时无法读取图片", permanent: false },
};

/** Only safe, fixed messages leave the media boundary; remote errors may hold signed URLs. */
export function createMediaError(code = "MEDIA_DOWNLOAD_FAILED") {
  const failure = FAILURES[code] || FAILURES.MEDIA_DOWNLOAD_FAILED;
  return Object.assign(new Error(failure.message), {
    code: Object.hasOwn(FAILURES, code) ? code : "MEDIA_DOWNLOAD_FAILED",
    mediaFailure: true,
    permanent: failure.permanent,
  });
}

export function mediaError(error) {
  if (error?.mediaFailure && Object.hasOwn(FAILURES, error.code)) return createMediaError(error.code);
  const text = errorText(error);
  if (/\bNO_PERMISSION\b|CrossOrgPermissionDenied|权限不足|没有[^\n]{0,20}权限|无(?:下载|读取|访问)权限/i.test(text)) return createMediaError("MEDIA_PERMISSION_DENIED");
  if (/\bINVALID_MEDIA_ID\b|media\s*id[^\n]{0,20}(?:invalid|无效)|无效[^\n]{0,10}media\s*id/i.test(text)) return createMediaError("MEDIA_RESOURCE_INVALID");
  if (/\bNoSuchKey\b|\bHTTP\s*[:=]?\s*404\b|\bstatus(?:Code)?\s*[:=]?\s*404\b/i.test(text)) return createMediaError("MEDIA_RESOURCE_MISSING");
  if (unsupportedImage(text)) return createMediaError("MEDIA_FORMAT_UNSUPPORTED");
  if (/ETIMEDOUT|timeout|timed out|超时|AbortError/i.test(text)) return createMediaError("MEDIA_TIMEOUT");
  if (/ECONN|ENOTFOUND|EAI_AGAIN|socket|certificate|unknown authority|TLS|network/i.test(text)) return createMediaError("MEDIA_NETWORK");
  return createMediaError("MEDIA_DOWNLOAD_FAILED");
}

// A destination transport failure is not evidence that an image is invalid.
export function imageSendError(error) {
  return unsupportedImage(errorText(error)) ? createMediaError("MEDIA_FORMAT_UNSUPPORTED") : error;
}

export function mediaFailureReason(error) {
  return createMediaError(error?.code).message;
}

function unsupportedImage(text) {
  return /图片格式不支持|不支持的图片格式|unsupported image (?:format|type)|image (?:format|type)[^\n]{0,20}(?:unsupported|not supported)/i.test(text);
}

function errorText(value) {
  const parts = [];
  const seen = new Set();
  function visit(item, depth = 0) {
    if (depth > 5 || item == null) return;
    if (typeof item !== "object") {
      if (typeof item === "string" || typeof item === "number") parts.push(String(item).slice(0, 16_000));
      return;
    }
    if (seen.has(item)) return;
    seen.add(item);
    if (item instanceof Error) visit(item.message, depth + 1);
    // Do not traverse arbitrary remote content or put it on the returned Error.
    for (const key of ["code", "server_error_code", "message", "errorMsg", "error", "data", "cause", "stderr"]) visit(item[key], depth + 1);
  }
  visit(value);
  return parts.join(" ");
}
