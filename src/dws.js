import { spawn } from "node:child_process";

export function runDws(args, { timeoutMs = 45_000, bin = "dws" } = {}) {
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
