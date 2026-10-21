import { spawn } from "node:child_process";

export function runDws(args, { timeoutMs = 45_000, bin = "dws" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args, "-f", "json", "-y", "--timeout", "30"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      const error = Object.assign(new Error(`dws 超时：${args.slice(0, 3).join(" ")}`), {
        code: "ETIMEDOUT", data: parseOutput(stdout), stdout, stderr,
      });
      finish(error);
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      finish(Object.assign(error, { data: parseOutput(stdout), stdout, stderr }));
    });
    // close follows stdio closure; exit can arrive before the last output bytes.
    child.on("close", (code, signal) => {
      if (settled) return;
      const data = parseOutput(stdout);
      if (code !== 0 || signal || !stdout.trim() || failedResult(data)) {
        const fallback = signal ? `dws 被信号 ${signal} 终止` : `dws 退出 ${code}`;
        finish(Object.assign(new Error(errorMessage(data, stderr, fallback)), {
          code, exitCode: code, signal, data, stdout, stderr,
        }));
        return;
      }
      finish(null, { code, data, stderr });
    });
  });
}

function parseOutput(stdout) {
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function failedResult(data) {
  return data && typeof data === "object"
    && (data.success === false || data.ok === false || Boolean(data.error));
}

function errorMessage(data, stderr, fallback) {
  const detail = typeof data?.error === "string" ? data.error : data?.error?.message;
  return detail || data?.errorMsg || data?.message || stderr.trim()
    || (failedResult(data) ? "dws 操作失败" : fallback);
}

export function startEventStream({ bin = "dws", onEvent, onReady, onExit, onError }) {
  const child = spawn(bin, [
    "event", "consume",
    "user_im_message_receive_o2o_all",
    "user_im_message_receive_at",
    "user_im_message_receive_group_all",
    "--flatten", "-f", "ndjson", "-y",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let buffer = "";
  let readyTail = "";
  let ready = false;
  let exited = false;
  const readyMarker = "[event] ready";
  const logError = (error) => console.error("钉钉事件错误：", error?.message || error);
  const reportError = (error) => {
    if (!onError) return logError(error);
    try {
      Promise.resolve(onError(error)).catch(logError);
    } catch (handlerError) {
      logError(handlerError);
    }
  };
  const invoke = (callback, ...args) => {
    if (!callback) return;
    try {
      Promise.resolve(callback(...args)).catch(reportError);
    } catch (error) {
      reportError(error);
    }
  };
  const notifyExit = (code, signal) => {
    if (exited) return;
    exited = true;
    invoke(onExit, code, signal);
  };
  const consumeLine = (line) => {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      reportError(new Error(`无法解析钉钉事件：${error.message}`, { cause: error }));
      return;
    }
    invoke(onEvent, event);
  };
  // Readable's decoder retains incomplete UTF-8 characters across data chunks.
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      consumeLine(line);
      nl = buffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (text) => {
    process.stderr.write(text);
    if (ready) return;
    const candidate = readyTail + text;
    if (candidate.includes(readyMarker)) {
      ready = true;
      invoke(onReady);
    }
    readyTail = candidate.slice(-(readyMarker.length - 1));
  });
  child.on("error", (error) => {
    reportError(error);
    // A failed spawn has no exit event, but the caller must still restart safely.
    if (!child.pid) notifyExit(null, null);
  });
  child.on("close", (code, signal) => {
    consumeLine(buffer);
    buffer = "";
    notifyExit(code, signal);
  });
  return child;
}
