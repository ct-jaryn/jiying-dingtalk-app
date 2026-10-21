import { spawn } from "node:child_process";

const RETRIES = 5;

export async function runDws(args, options = {}) {
  let lastError;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    try {
      const result = await runDwsOnce(args, options);
      if (result?.data?.error && isRetryable(JSON.stringify(result.data))) {
        throw new Error(JSON.stringify(result.data.error));
      }
      return result;
    } catch (error) {
      lastError = error;
      if (attempt === RETRIES || !isRetryable(error.message)) throw error;
      const delay = 1000 * 2 ** attempt;
      console.error(`dws 失败，${delay / 1000}s 后重试 ${attempt + 1}/${RETRIES}：${error.message}`);
      await sleep(delay);
    }
  }
  throw lastError;
}

export function isRetryable(message) {
  const text = String(message || "");
  if (/"retryable"\s*:\s*false/.test(text)) return false;
  return /retryable"\s*:\s*true|certificate|unknown authority|tls:|request_failed|timeout|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket/i.test(text);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runDwsOnce(args, { timeoutMs = 45_000, bin = "dws" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args, "-f", "json", "-y", "--timeout", "30"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`dws 超时：${args.slice(0, 3).join(" ")}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const text = stdout.trim();
      if (!text) {
        reject(new Error(stderr.trim() || `dws 退出 ${code}`));
        return;
      }
      try {
        resolve({ code, data: JSON.parse(text), stderr });
      } catch {
        resolve({ code, data: text, stderr });
      }
    });
  });
}

export function startEventStream({ bin = "dws", onEvent, onReady, onExit }) {
  const child = spawn(bin, [
    "event", "consume",
    "user_im_message_receive_o2o_all",
    "user_im_message_receive_at",
    "user_im_message_receive_group_all",
    "--flatten", "-f", "ndjson", "-y",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        try {
          onEvent(JSON.parse(line));
        } catch (error) {
          console.error("无法解析钉钉事件：", error.message);
        }
      }
      nl = buffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    process.stderr.write(text);
    if (text.includes("[event] ready")) onReady?.();
  });
  child.on("exit", (code, signal) => onExit?.(code, signal));
  return child;
}
