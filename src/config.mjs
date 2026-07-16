import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig(env = process.env) {
  const appId = required(env, "FEISHU_APP_ID");
  const appSecret = required(env, "FEISHU_APP_SECRET");
  const discovery = bool(env.FEISHU_DISCOVERY, false);
  const openIds = list(env.FEISHU_ALLOWED_OPEN_IDS);
  if (!discovery && !openIds.length) {
    throw new Error("FEISHU_ALLOWED_OPEN_IDS 至少需要一个 open_id；首次接入可设置 FEISHU_DISCOVERY=1");
  }
  const cwd = resolve(required(env, "PI_CWD"));
  const sessionId = (env.PI_SESSION_ID || "pi-247").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) {
    throw new Error("PI_SESSION_ID 只能包含字母、数字、点、下划线和连字符");
  }
  const customArgs = parsePiArgs(env.PI_ARGS_JSON);
  const extension = resolve(env.PI_EXTENSION || resolve(ROOT, "extensions/pi-monitor.ts"));
  return {
    autostart: bool(env.PI_AUTOSTART, true),
    approvalTimeout: clamp(integer(env.PI_APPROVAL_TIMEOUT_MS, 600_000), 10_000, 86_400_000),
    sendAssistantText: bool(env.PI_SEND_ASSISTANT_TEXT, true),
    stateFile: resolve(env.PI_STATE_FILE || resolve(ROOT, ".pi-monitor-state.json")),
    feishu: {
      appId,
      appSecret,
      discovery,
      allowedOpenIds: new Set(openIds),
      allowedChatIds: new Set(list(env.FEISHU_ALLOWED_CHAT_IDS)),
    },
    pi: {
      cwd,
      sessionId,
      command: env.PI_COMMAND || (process.platform === "win32" ? "pi.cmd" : "pi"),
      resumePrompt: env.PI_RESUME_PROMPT || "继续当前目标；先检查持久化状态，再从未完成步骤恢复。",
      args: [...customArgs, "--mode", "rpc", "--session-id", sessionId, "--name", "pi-24x7", "--extension", extension],
    },
  };
}

export function piEnvironment(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !/^(?:FEISHU|DINGTALK)_/.test(key)),
  );
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parsePiArgs(value) {
  if (!value) return [];
  let args;
  try { args = JSON.parse(value); } catch { throw new Error("PI_ARGS_JSON 必须是 JSON 字符串数组"); }
  if (!Array.isArray(args) || args.some((item) => typeof item !== "string")) {
    throw new Error("PI_ARGS_JSON 必须是 JSON 字符串数组");
  }
  const forbidden = [
    "--mode", "--session", "--session-id", "--continue", "-c", "--resume", "-r", "--fork",
    "--no-session", "--no-extensions", "--print", "-p",
  ];
  if (args.some((arg) => forbidden.some((flag) => arg === flag || arg.startsWith(`${flag}=`)))) {
    throw new Error(`PI_ARGS_JSON 不得覆盖 ${forbidden.join(", ")}`);
  }
  return args;
}

function required(env, name) {
  const value = env[name]?.trim();
  if (!value || /^<.*>$/.test(value)) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

function list(value = "") {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function bool(value, fallback) {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function integer(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
