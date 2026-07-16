import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clamp, loadConfig, piEnvironment } from "./config.mjs";
import { FeishuBridge } from "./feishu.mjs";
import { PiRpc } from "./pi-rpc.mjs";
import { StateStore } from "./state.mjs";
import { HELP, agentEndNotice, formatDuration, formatGoalStatus, formatProgress, formatTime, log, readGoalStatus } from "./text.mjs";
import { requireText, safeError, safeRemote, splitCommand, summarizeTool } from "./text.mjs";

const STATUS_NAMES = {
  offline: "⚫ 已下线",
  starting: "🟡 启动中",
  idle: "🟢 空闲",
  running: "🔵 工作中",
  approval: "🟠 等待审批",
  retrying: "🟣 服务商重试中",
  crashed: "🔴 已崩溃",
};

export class Monitor {
  #pi;
  #bridge;
  #store;
  #startPromise;
  #restartTimer;
  #stopping = false;
  #approvals = new Map();
  #recentNotifications = new Map();

  constructor(config) {
    this.config = config;
    this.#store = new StateStore(config.stateFile, config.autostart);
  }

  async run() {
    const state = await this.#store.load();
    if (state.desiredRunning && state.lastTask && ["running", "approval", "retrying"].includes(state.status)) {
      state.resumePending = true;
    }
    this.#bridge = new FeishuBridge({
      ...this.config.feishu,
      initialTarget: state.lastTarget,
      onMessage: (message) => this.#handleMessage(message),
      onTarget: (target) => this.#rememberTarget(target),
      onLog: log,
    });
    await this.#bridge.start();
    log("飞书长连接已连接");
    const shutdown = () => { void this.shutdown().catch((error) => log(`关闭失败: ${safeError(error)}`)); };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    if (this.config.autostart && state.desiredRunning && !this.config.feishu.discovery) {
      await this.#ensurePi().catch((error) => log(`Pi 启动失败，飞书桥接继续运行: ${safeError(error)}`));
    }
  }

  async shutdown() {
    if (this.#stopping) return;
    this.#stopping = true;
    clearTimeout(this.#restartTimer);
    this.#clearApprovals();
    await this.#bridge?.stop();
    await this.#pi?.stop();
  }

  async #ensurePi() {
    if (this.#pi?.running) return this.#pi;
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = this.#startPi().finally(() => { this.#startPromise = undefined; });
    return this.#startPromise;
  }

  async #startPi() {
    clearTimeout(this.#restartTimer);
    this.#restartTimer = undefined;
    const state = this.#store.state;
    state.desiredRunning = true;
    state.status = "starting";
    this.#event("正在启动 Pi");

    const rpc = new PiRpc({
      command: this.config.pi.command,
      args: this.config.pi.args,
      cwd: this.#effectiveCwd(),
      env: piEnvironment(process.env),
      onEvent: (event) => this.#handlePiEvent(rpc, event),
      onExit: (result) => this.#handlePiExit(rpc, result),
      onLog: (message) => message && log(`[pi] ${safeRemote(message)}`),
    });
    this.#pi = rpc;
    try {
      await rpc.start();
      const response = await rpc.request({ type: "get_state" }, 15_000);
      state.status = response.data?.isStreaming ? "running" : "idle";
      state.startedAt = Date.now();
      state.lastProgressAt = Date.now();
      this.#event(`Pi 已启动，session=${response.data?.sessionId ?? this.config.pi.sessionId}`);
      if (state.resumePending && !response.data?.isStreaming) {
        await rpc.request({ type: "prompt", message: this.config.pi.resumePrompt }, 10_000);
        state.status = "running";
        state.lastProgressAt = Date.now();
        this.#event("已自动发送崩溃恢复指令");
      }
      return rpc;
    } catch (error) {
      if (this.#pi === rpc) this.#pi = undefined;
      if (rpc.running) await rpc.stop().catch(() => {});
      state.status = "crashed";
      state.startedAt = null;
      this.#event(`Pi 启动失败: ${safeError(error)}`);
      await this.#scheduleRestart();
      throw error;
    }
  }

  async #handlePiExit(rpc, result) {
    if (this.#pi !== rpc) return;
    this.#pi = undefined;
    const state = this.#store.state;
    const previousStatus = state.status;
    const uptime = state.startedAt ? Date.now() - state.startedAt : 0;
    if (uptime > 60_000) state.restartCount = 0;
    if (state.desiredRunning && ["running", "approval", "retrying"].includes(previousStatus)) {
      state.resumePending = true;
    }
    if (!state.desiredRunning) state.resumePending = false;
    state.status = state.desiredRunning ? "crashed" : "offline";
    state.startedAt = null;
    state.currentTool = null;
    this.#clearApprovals();
    this.#event(`Pi 已退出 (${result.signal ?? result.code ?? "unknown"})`);
    if (!this.#stopping && state.desiredRunning) {
      await this.#notifyOnce("pi-exit", "🔴 Pi 进程退出，正在安排自动恢复。", 30_000);
      await this.#scheduleRestart();
    }
  }

  async #scheduleRestart() {
    const state = this.#store.state;
    if (this.#stopping || !state.desiredRunning || this.#restartTimer) return;
    state.restartCount += 1;
    const delay = Math.min(300_000, 5000 * 2 ** Math.min(state.restartCount - 1, 6));
    this.#event(`${Math.ceil(delay / 1000)} 秒后重启 Pi`);
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined;
      this.#ensurePi().catch((error) => log(`Pi 重启失败: ${safeError(error)}`));
    }, delay);
  }

  async #handleMessage(message) {
    if (message.rawContentType !== "text") return this.#bridge.reply(message, "仅支持文本命令。");
    const text = String(message.content ?? "").trim();
    if (!text) return this.#bridge.reply(message, "消息内容为空。");
    const [command, rest = ""] = splitCommand(text);

    try {
      switch (command) {
        case "帮助": case "/help": return this.#bridge.reply(message, HELP);
        case "状态": case "/status": return this.#bridge.reply(message, await this.#status());
        case "启动": case "/start":
          await this.#ensurePi();
          if (rest) await this.#submit(rest);
          return this.#bridge.reply(message, rest ? "✅ Pi 已启动，任务已提交。" : "✅ Pi 已启动。");
        case "恢复": case "/resume": {
          const alreadyPending = this.#store.state.resumePending;
          await this.#ensurePi();
          if (!alreadyPending || rest) await this.#submit(rest || this.config.pi.resumePrompt);
          return this.#bridge.reply(message, alreadyPending && !rest ? "✅ 任务已经在运行或自动恢复。" : "✅ 已向固定会话发送恢复指令。");
        }
        case "追加": case "/follow":
          requireText(rest, "追加");
          await this.#submit(rest, "follow_up");
          return this.#bridge.reply(message, "✅ 已加入后续队列。");
        case "转向": case "/steer":
          requireText(rest, "转向");
          await this.#submit(rest, "steer");
          return this.#bridge.reply(message, "✅ 已发送转向指令。");
        case "停止": case "/abort":
          if (!this.#pi?.running) return this.#bridge.reply(message, "Pi 当前未运行。");
          this.#store.state.resumePending = false;
          this.#cancelApprovals();
          await this.#pi.request({ type: "abort" }, 5000);
          this.#store.state.resumePending = false;
          this.#store.state.status = "idle";
          this.#store.state.currentTool = null;
          this.#store.state.lastProgressAt = Date.now();
          await this.#save();
          return this.#bridge.reply(message, "⏹️ 已请求停止当前任务，Pi 保持在线。");
        case "下线": case "/offline":
          await this.#takeOffline();
          return this.#bridge.reply(message, "⚫ Pi 已下线，飞书桥接仍在线。");
        case "重启": case "/restart":
          await this.#restartPi();
          return this.#bridge.reply(message, "✅ Pi 已重启并打开固定会话。");
        case "新对话": case "/new": {
          await this.#ensurePi();
          this.#cancelApprovals();
          const res = await this.#pi.request({ type: "new_session" }, 10_000);
          const cancelled = res?.data?.cancelled;
          if (cancelled) return this.#bridge.reply(message, "⚠️ 新对话被扩展取消，保持原会话。");
          this.#store.state.resumePending = false;
          this.#store.state.lastTask = "";
          this.#store.state.currentTool = null;
          this.#store.state.progress = null;
          this.#store.state.lastProgressAt = Date.now();
          await this.#save();
          return this.#bridge.reply(message, "✅ 已开启新对话，历史上下文已清空。");
        }
        case "切换": case "/cd": {
          requireText(rest, "切换");
          const target = resolve(rest);
          let stat;
          try { stat = statSync(target); } catch { return this.#bridge.reply(message, `❌ 目录不存在：${target}`); }
          if (!stat.isDirectory()) return this.#bridge.reply(message, `❌ 不是目录：${target}`);
          this.#store.state.cwd = target;
          this.#store.state.resumePending = false;
          this.#store.state.lastTask = "";
          await this.#save();
          await this.#restartPi();
          return this.#bridge.reply(message, `✅ 已切换工作目录并重启 Pi：\n${target}`);
        }
        case "日志": case "/logs": return this.#bridge.reply(message, this.#logs(rest));
        case "批准": case "/approve": return this.#resolveApproval(message, rest, true);
        case "拒绝": case "/reject": return this.#resolveApproval(message, rest, false);
        default:
          await this.#ensurePi();
          await this.#submit(text);
          return this.#bridge.reply(message, "✅ 已作为新任务提交。");
      }
    } catch (error) {
      return this.#bridge.reply(message, `❌ ${safeError(error)}`);
    }
  }

  async #submit(message, mode = "prompt") {
    const pi = await this.#ensurePi();
    const state = this.#store.state;
    if (mode === "steer" || mode === "follow_up") {
      await pi.request({ type: mode, message }, 10_000);
    } else {
      const streaming = state.status === "running" || state.status === "retrying";
      await pi.request({ type: "prompt", message, ...(streaming && { streamingBehavior: "followUp" }) }, 10_000);
      if (!streaming) state.progress = null;
    }
    state.resumePending = true;
    state.lastTask = safeRemote(message).slice(0, 1000);
    this.#event(`收到远程任务: ${safeRemote(message).slice(0, 120)}`);
  }

  async #takeOffline() {
    clearTimeout(this.#restartTimer);
    this.#restartTimer = undefined;
    const state = this.#store.state;
    state.desiredRunning = false;
    state.resumePending = false;
    this.#cancelApprovals();
    await this.#save();
    const pi = this.#pi;
    if (pi) await pi.stop();
    state.status = "offline";
    state.startedAt = null;
    await this.#save();
  }

  async #restartPi() {
    clearTimeout(this.#restartTimer);
    this.#restartTimer = undefined;
    const state = this.#store.state;
    const resume = state.resumePending || ["running", "approval", "retrying"].includes(state.status);
    state.desiredRunning = false;
    if (this.#pi) await this.#pi.stop();
    state.resumePending = resume;
    state.desiredRunning = true;
    await this.#ensurePi();
  }

  async #handlePiEvent(rpc, event) {
    if (this.#pi !== rpc || !event?.type) return;
    const state = this.#store.state;
    if (event.type === "extension_ui_request") return this.#handleUiRequest(event);
    if (["message_start", "message_update", "message_end", "tool_execution_update"].includes(event.type)) {
      state.lastProgressAt = Date.now();
      return;
    }

    let changed = false;
    let notification;
    if (event.type === "agent_start") {
      state.status = "running";
      state.resumePending = true;
      state.lastProgressAt = Date.now();
      changed = true;
    }
    if (event.type === "turn_start" || event.type === "turn_end") {
      state.lastProgressAt = Date.now();
      changed = true;
    }
    if (event.type === "tool_execution_start") {
      state.currentTool = summarizeTool(event);
      state.lastProgressAt = Date.now();
      changed = true;
    }
    if (event.type === "tool_execution_end") {
      state.currentTool = null;
      state.lastProgressAt = Date.now();
      changed = true;
      if (event.isError) notification = [`tool-${event.toolName}`, `⚠️ Pi 工具失败：${event.toolName}`, 60_000];
    }
    if (event.type === "compaction_start") {
      state.currentTool = "压缩会话";
      state.lastProgressAt = Date.now();
      changed = true;
    }
    if (event.type === "compaction_end") {
      state.currentTool = null;
      state.lastProgressAt = Date.now();
      changed = true;
    }
    if (event.type === "auto_retry_start") {
      state.status = "retrying";
      state.lastProgressAt = Date.now();
      changed = true;
      if (event.attempt === 1) notification = ["retry", "🟣 模型服务异常，Pi 正在自动重试。", 60_000];
    }
    if (event.type === "auto_retry_end") {
      state.status = event.success ? "running" : "idle";
      state.lastProgressAt = Date.now();
      changed = true;
      if (event.success === false) {
        notification = ["retry-failed", `❌ 模型服务重试耗尽：${safeRemote(event.finalError)}`, 60_000];
      }
    }
    if (event.type === "extension_error") {
      notification = ["extension-error", `❌ Pi 扩展异常：${safeRemote(event.error)}`, 60_000];
    }
    if (event.type === "agent_end") {
      state.status = "idle";
      state.resumePending = false;
      state.currentTool = null;
      state.lastProgressAt = Date.now();
      changed = true;
      notification = ["agent-end", agentEndNotice(event, this.config.sendAssistantText), 5000];
    }
    if (changed) await this.#save();
    if (notification) await this.#notifyOnce(...notification);
  }

  async #handleUiRequest(event) {
    if (event.method === "notify") {
      const message = safeRemote(event.message ?? "Pi 通知");
      this.#event(message);
      return this.#notifyOnce(`notify-${message}`, message, 5000);
    }
    if (event.method === "setStatus" && event.statusKey === "pi-progress") {
      try {
        const progress = JSON.parse(event.statusText);
        if (progress && typeof progress.message === "string") {
          this.#store.state.progress = progress;
          this.#store.state.lastProgressAt = Date.now();
        }
      } catch {}
      return this.#save();
    }
    if (event.method !== "confirm") {
      if (["select", "input", "editor"].includes(event.method)) {
        this.#respondUi({ id: event.id, cancelled: true });
      }
      return;
    }

    const id = uniqueApprovalId(this.#approvals);
    const timeout = clamp(Number(event.timeout ?? this.config.approvalTimeout), 10_000, 86_400_000);
    const timer = setTimeout(() => this.#expireApproval(id), timeout);
    this.#approvals.set(id, { rpcId: event.id, timer });
    this.#store.state.status = "approval";
    await this.#save();
    const text = [
      `🟠 Pi 等待审批 [${id}]`,
      safeRemote(event.title),
      safeRemote(event.message),
      "",
      `回复：批准 ${id}`,
      `或：拒绝 ${id}`,
      `有效期：${Math.ceil(timeout / 60_000)} 分钟`,
    ].filter(Boolean).join("\n");
    try { await this.#bridge.send(text); }
    catch (error) {
      clearTimeout(timer);
      this.#approvals.delete(id);
      this.#respondUi({ id: event.id, cancelled: true });
      this.#store.state.status = this.#approvals.size ? "approval" : "running";
      await this.#save();
      log(`发送审批失败: ${safeError(error)}`);
    }
  }

  async #resolveApproval(message, rawId, approved) {
    const id = rawId.trim().toLowerCase();
    const pending = this.#approvals.get(id);
    if (!pending) return this.#bridge.reply(message, "审批不存在或已经过期。");
    clearTimeout(pending.timer);
    this.#approvals.delete(id);
    const delivered = this.#respondUi({ id: pending.rpcId, confirmed: approved });
    this.#store.state.status = this.#approvals.size ? "approval" : "running";
    this.#event(`${approved ? "批准" : "拒绝"}审批 ${id}`);
    if (!delivered) return this.#bridge.reply(message, "Pi 已退出，审批未执行。");
    return this.#bridge.reply(message, approved ? `✅ 已批准 ${id}` : `⛔ 已拒绝 ${id}`);
  }

  async #expireApproval(id) {
    const pending = this.#approvals.get(id);
    if (!pending) return;
    this.#approvals.delete(id);
    this.#respondUi({ id: pending.rpcId, cancelled: true });
    this.#store.state.status = this.#approvals.size ? "approval" : "running";
    await this.#save();
    await this.#notifyOnce(`approval-${id}`, `⏰ 审批 ${id} 已超时并自动拒绝。`, 1000);
  }

  #effectiveCwd() {
    const stored = this.#store.state.cwd;
    if (stored) {
      try { if (statSync(stored).isDirectory()) return stored; }
      catch { /* stale cwd, fall back to config */ }
    }
    return this.config.pi.cwd;
  }

  async #status() {
    let remote;
    if (this.#pi?.running) {
      try { remote = (await this.#pi.request({ type: "get_state" }, 5000)).data; } catch {}
    }
    const state = this.#store.state;
    const lines = [
      "Pi 24/7 状态",
      `状态：${STATUS_NAMES[state.status] ?? state.status}`,
      `PID：${this.#pi?.pid ?? "-"}`,
      `工作目录：${this.#effectiveCwd()}`,
      `Session：${remote?.sessionId ?? this.config.pi.sessionId}`,
      `模型：${remote?.model ? `${remote.model.provider}/${remote.model.id}` : "-"}`,
      `当前工具：${state.currentTool ?? "-"}`,
      `最近进展：${formatTime(state.lastProgressAt)}`,
      `运行时间：${formatDuration(state.startedAt)}`,
      `待处理消息：${remote?.pendingMessageCount ?? 0}`,
      `等待审批：${this.#approvals.size}`,
    ];
    if (state.progress) lines.push(`任务进度：${formatProgress(state.progress)}`);
    const goal = readGoalStatus(this.config.pi.cwd);
    const goalText = formatGoalStatus(goal);
    if (goalText) lines.push(goalText);
    if (state.lastTask) lines.push(`最近任务：${state.lastTask.slice(0, 180)}`);
    return lines.join("\n");
  }

  #logs(rawCount) {
    const count = clamp(Number.parseInt(rawCount, 10) || 10, 1, 30);
    const events = this.#store.state.events.slice(-count);
    if (!events.length) return "暂无事件。";
    return events.map((event) => `${formatTime(event.at)} ${event.message}`).join("\n");
  }

  #rememberTarget(target) {
    this.#store.state.lastTarget = {
      chatId: target.chatId,
      chatType: target.chatType,
      senderId: target.senderId,
    };
    void this.#save();
  }

  #event(message) {
    this.#store.addEvent(message);
    log(message);
    void this.#save();
  }

  #save() {
    return this.#store.save().catch((error) => log(safeError(error)));
  }

  async #notifyOnce(key, message, cooldownMs) {
    const now = Date.now();
    if (this.#recentNotifications.get(key) > now - cooldownMs) return;
    this.#recentNotifications.set(key, now);
    if (this.#recentNotifications.size > 500) {
      this.#recentNotifications.delete(this.#recentNotifications.keys().next().value);
    }
    try { await this.#bridge.send(message); } catch (error) { log(`飞书推送失败: ${safeError(error)}`); }
  }

  #respondUi(response) {
    if (!this.#pi?.running) return false;
    try {
      this.#pi.send({ type: "extension_ui_response", ...response });
      return true;
    } catch {
      return false;
    }
  }
  #cancelApprovals() {
    for (const pending of this.#approvals.values()) {
      clearTimeout(pending.timer);
      this.#respondUi({ id: pending.rpcId, cancelled: true });
    }
    this.#approvals.clear();
  }
  #clearApprovals() {
    for (const pending of this.#approvals.values()) clearTimeout(pending.timer);
    this.#approvals.clear();
  }
}

function uniqueApprovalId(pending) {
  let id; do { id = randomBytes(3).toString("hex"); } while (pending.has(id));
  return id;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => new Monitor(loadConfig()).run()).catch((error) => {
    console.error(safeError(error)); process.exitCode = 1;
  });
}
