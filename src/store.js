import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const writes = new Map();

export async function loadJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(fallback);
    throw error;
  }
}

export function saveJson(path, value) {
  // Capture at the call site: callers may mutate their shared state while a
  // previous write is still pending.
  const text = JSON.stringify(value, null, 2) + "\n";
  const previous = writes.get(path) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    await mkdir(dirname(path), { recursive: true });
    const tmp = path + "." + process.pid + "." + randomUUID() + ".tmp";
    try {
      await writeFile(tmp, text, { mode: 0o600 });
      await rename(tmp, path);
    } finally {
      await rm(tmp, { force: true });
    }
  });
  writes.set(path, operation);
  operation.finally(() => {
    if (writes.get(path) === operation) writes.delete(path);
  }).catch(() => {});
  return operation;
}

export async function flushWrites() {
  await Promise.all([...writes.values()]);
}
