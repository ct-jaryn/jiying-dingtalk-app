import { readFile } from "node:fs/promises";
import YAML from "js-yaml";

const REQUIRED = [
  ["anthropic", "base_url"],
  ["anthropic", "model"],
  ["anthropic", "api_key"],
  ["magicchat", "ws_url"],
  ["magicchat", "app_id"],
  ["magicchat", "app_secret"],
  ["magicchat", "user_id"],
];

export async function loadConfig(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`缺少 ${path}。请复制 config.example.yaml 为 config.yaml 并填入配置。`);
    }
    throw error;
  }
  const config = YAML.load(raw) || {};
  for (const [section, key] of REQUIRED) {
    if (!config[section]?.[key]) throw new Error(`配置缺少 ${section}.${key}`);
  }
  config.agent = {
    max_rounds: 25,
    max_context_tokens: 100_000,
    ...(config.agent || {}),
  };
  config.agent.max_rounds = Number(config.agent.max_rounds) || 25;
  config.agent.max_context_tokens = Number(config.agent.max_context_tokens) || 100_000;
  config.anthropic.request_timeout_ms = Math.min(180_000, Math.max(1000, Number(config.anthropic.request_timeout_ms) || 90_000));
  config.push = {
    all_group_messages: true,
    muted_conversations: false,
    ...(config.push || {}),
  };
  if (config.push.all_group_messages == null) config.push.all_group_messages = true;
  if (config.push.muted_conversations == null) config.push.muted_conversations = false;
  return config;
}
