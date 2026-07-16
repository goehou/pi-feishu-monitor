import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function splitCommand(value) {
  const match = value.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  return [match?.[1] ?? value, match?.[2]?.trim() ?? ""];
}

// ponytail: /goal 和 /sisyphus 是用户直觉写法，Pi 实际命令是 /goals-set / /sisyphus-set；在此做别名归一，避免在命令分发里散写
const GOAL_ALIASES = { "/goal": "/goals-set", "/goals": "/goals-set", "/sisyphus": "/sisyphus-set" };
export function normalizeGoalAlias(text) {
  const match = text.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const cmd = match?.[1] ?? "";
  const rest = match?.[2]?.trim() ?? "";
  const mapped = GOAL_ALIASES[cmd.toLowerCase()];
  if (!mapped) return text;
  if (!rest) throw new Error(`${cmd} 命令缺少内容，用法：${cmd} <目标描述>`);
  return `${mapped} ${rest}`;
}

export function requireText(value, command) {
  if (!value) throw new Error(`${command}命令缺少内容`);
}

export function summarizeTool(event) {
  const detail = event.toolName === "bash" ? event.args?.command : event.args?.path;
  return `${event.toolName}${detail ? `: ${safeRemote(detail).slice(0, 120)}` : ""}`;
}

export function agentEndNotice(event, includeText) {
  const assistant = [...(event.messages ?? [])].reverse().find((message) => message?.role === "assistant");
  let notice = "✅ Pi 本轮任务完成。";
  if (assistant?.stopReason === "aborted") notice = "⏹️ Pi 本轮任务已停止。";
  if (assistant?.stopReason === "error") {
    notice = `❌ Pi 本轮任务失败：${safeRemote(assistant.errorMessage ?? "未知错误")}`;
  }
  if (includeText) {
    const output = safeRemote(extractAssistantText(event.messages));
    if (output) notice += `\n\n${output}`;
  }
  return notice;
}

export function formatProgress(progress) {
  return Number.isInteger(progress.current) && Number.isInteger(progress.total)
    ? `${progress.current}/${progress.total} ${progress.message}`
    : progress.message;
}

export function formatTime(value) {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "-";
}

export function formatDuration(startedAt) {
  if (!startedAt) return "-";
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}小时${minutes}分钟`;
}

export function safeRemote(value) {
  return String(value ?? "")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "<redacted-key>")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1<redacted>")
    .replace(/((?:token|secret|password|api[_-]?key)\s*[:=]\s*)\S+/gi, "$1<redacted>")
    .slice(0, 1500);
}

export function safeError(error) {
  return safeRemote(error?.message ?? error).slice(0, 500);
}

export function log(message) {
  console.log(`${new Date().toISOString()} ${message}`);
}

/**
 * Read the pi-goal-x ledger at <cwd>/.pi/goals/goal_events.jsonl and reconstruct
 * the focused goal's current state. Returns null if no goal or ledger missing.
 * Events are an append-only stream (goal-ledger.ts); we replay them.
 */
export function readGoalStatus(cwd) {
  if (!cwd) return null;
  let file;
  try {
    file = readFileSync(resolve(cwd, ".pi", "goals", "goal_events.jsonl"), "utf8");
  } catch {
    return null;
  }
  const events = [];
  for (const line of file.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { events.push(JSON.parse(trimmed)); } catch {}
  }
  if (!events.length) return null;
  // last focused goal
  let focusedId = null;
  for (const e of events) {
    if (e.type === "goal_created" || e.type === "goal_focused") focusedId = e.goalId;
  }
  if (!focusedId) return null;
  // reconstruct that goal
  let objective = "";
  let status = "active";
  let taskTotal = 0;
  let done = 0;
  let skipped = 0;
  let lastAudit = null;
  for (const e of events) {
    if (e.goalId !== focusedId) continue;
    if (e.type === "goal_created") objective = e.objective;
    else if (e.type === "task_list_set") taskTotal = e.taskCount;
    else if (e.type === "task_complete") done++;
    else if (e.type === "task_skipped") skipped++;
    else if (e.type === "goal_paused") status = "paused";
    else if (e.type === "goal_resumed") status = "active";
    else if (e.type === "goal_completed") status = "complete";
    else if (e.type === "goal_aborted") status = "aborted";
    else if (e.type === "audit_result") lastAudit = e;
  }
  return { objective, status, taskTotal, done, skipped, lastAudit };
}

export function formatGoalStatus(goal) {
  if (!goal) return null;
  const icon = goal.status === "complete" ? "✅" : goal.status === "paused" ? "⏸️" : goal.status === "aborted" ? "❌" : "🎯";
  const lines = [`${icon} 目标：${goal.objective.slice(0, 120)}`, `目标状态：${goal.status}`];
  if (goal.taskTotal > 0) {
    lines.push(`任务进度：${goal.done}/${goal.taskTotal} 完成${goal.skipped ? `（跳过 ${goal.skipped}）` : ""}`);
  }
  if (goal.lastAudit) {
    lines.push(`最近审计：${goal.lastAudit.verdict}${goal.lastAudit.report ? " — " + goal.lastAudit.report.slice(0, 80) : ""}`);
  }
  return lines.join("\n");
}

function extractAssistantText(messages = []) {
  for (const message of [...messages].reverse()) {
    if (message?.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content;
    const text = message.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    if (text) return text;
  }
  return "";
}

export const HELP = `Pi 远程命令
状态              查看进度
启动 [任务]       启动 Pi，可同时下任务
恢复 [指令]       打开固定会话并恢复目标
追加 <内容>       当前任务完成后执行
转向 <内容>       当前 turn 后改变方向
停止              停止当前任务，Pi 保持在线
下线              关闭 Pi，桥接保持在线
重启              重启 Pi
新对话            开启全新会话，清空历史上下文
切换 <目录>       切换 Pi 工作目录并重启
日志 [数量]       最近事件（最多 30 条）
批准 <编号>       批准危险操作
拒绝 <编号>       拒绝危险操作`;
