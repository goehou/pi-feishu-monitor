import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { classifyCommand, classifyPath } from "../src/policy.mjs";

const configuredTimeout = Number(process.env.PI_APPROVAL_TIMEOUT_MS ?? 600_000);
const APPROVAL_TIMEOUT = clamp(Number.isFinite(configuredTimeout) ? configuredTimeout : 600_000, 10_000, 86_400_000);

export default function piMonitorExtension(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const decision = classifyToolCall(event, ctx.cwd);
    if (decision.action === "allow") return;
    if (decision.action === "deny") return { block: true, reason: decision.reason };
    if (!ctx.hasUI) return { block: true, reason: `${decision.reason}；无远程审批界面` };

    const approved = await ctx.ui.confirm(
      `Pi 请求审批：${decision.reason}`,
      redact(decision.summary),
      { timeout: APPROVAL_TIMEOUT },
    );
    if (!approved) return { block: true, reason: "用户拒绝或审批超时" };
  });

  pi.registerTool({
    name: "notify_progress",
    label: "Notify progress",
    description: "Send a concise task milestone to the remote operator.",
    promptSnippet: "Report meaningful progress milestones to the remote operator",
    promptGuidelines: [
      "Use notify_progress only for meaningful milestones, completion, or actionable failure; " +
      "do not call it for every tool.",
    ],
    parameters: Type.Object({
      message: Type.String({ minLength: 1, maxLength: 1000 }),
      current: Type.Optional(Type.Integer({ minimum: 0 })),
      total: Type.Optional(Type.Integer({ minimum: 1 })),
      level: Type.Optional(Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")])),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const progress = { message: params.message, current: params.current, total: params.total, at: Date.now() };
      ctx.ui.setStatus("pi-progress", JSON.stringify(progress));
      ctx.ui.notify(formatProgress(progress), params.level ?? "info");
      return { content: [{ type: "text", text: "Progress notification sent." }], details: progress };
    },
  });

  pi.registerTool({
    name: "request_human_decision",
    label: "Request human decision",
    description: "Ask the remote operator for a blocking yes/no decision.",
    promptSnippet: "Request a blocking yes/no decision from the remote operator",
    promptGuidelines: [
      "Use request_human_decision only when work cannot safely continue without a human choice.",
      "Treat rejection or timeout as final; do not immediately ask the same question again.",
    ],
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 500 }),
      details: Type.Optional(Type.String({ maxLength: 2000 })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      if (!ctx.hasUI) return decisionResult(false, "No remote approval UI is available.");
      const approved = await ctx.ui.confirm(params.question, redact(params.details ?? ""), {
        timeout: APPROVAL_TIMEOUT,
      });
      return decisionResult(Boolean(approved), approved ? "Approved by operator." : "Rejected or timed out.");
    },
  });
}

function classifyToolCall(event: any, cwd: string) {
  if (event.toolName === "bash") {
    const decision = classifyCommand(event.input?.command);
    return { ...decision, summary: event.input?.command ?? "" };
  }
  const path = event.input?.path;
  if (typeof path === "string" && ["read", "write", "edit"].includes(event.toolName)) {
    const decision = classifyPath(cwd, path);
    return { ...decision, summary: `${event.toolName}: ${path}` };
  }
  return { action: "allow", summary: "" };
}

function decisionResult(approved: boolean, message: string) {
  return { content: [{ type: "text", text: JSON.stringify({ approved, message }) }], details: { approved } };
}

function formatProgress(progress: { message: string; current?: number; total?: number }) {
  return Number.isInteger(progress.current) && Number.isInteger(progress.total)
    ? `进度 ${progress.current}/${progress.total}：${progress.message}`
    : `进度：${progress.message}`;
}

function redact(value: string) {
  return String(value)
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "<redacted-key>")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1<redacted>")
    .replace(/((?:token|secret|password|api[_-]?key)\s*[:=]\s*)\S+/gi, "$1<redacted>")
    .slice(0, 3000);
}

function clamp(value: number, min: number, max: number) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}
