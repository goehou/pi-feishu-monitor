import { StringDecoder } from "node:string_decoder";
import spawn from "cross-spawn";

export class JsonlDecoder {
  #buffer = "";
  #decoder = new StringDecoder("utf8");

  constructor(onValue, onError) {
    this.onValue = onValue;
    this.onError = onError;
  }

  push(chunk) {
    this.#buffer += this.#decoder.write(chunk);
    this.#drain(false);
  }

  end() {
    this.#buffer += this.#decoder.end();
    this.#drain(true);
  }

  #drain(flush) {
    let newline;
    while ((newline = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      this.#parse(line);
    }
    if (flush && this.#buffer.trim()) this.#parse(this.#buffer.replace(/\r$/, ""));
    if (flush) this.#buffer = "";
  }

  #parse(line) {
    if (!line.trim()) return;
    try {
      this.onValue(JSON.parse(line));
    } catch (error) {
      this.onError?.(error, line);
    }
  }
}

export class PiRpc {
  #child;
  #nextId = 1;
  #pending = new Map();
  #eventQueue = Promise.resolve();
  #stderr = "";

  constructor(options) {
    this.options = options;
  }

  get running() {
    return Boolean(this.#child && this.#child.exitCode === null);
  }

  get pid() {
    return this.#child?.pid;
  }

  get stderrTail() {
    return this.#stderr.slice(-4000);
  }

  async start() {
    if (this.running) return;
    const { command, args, cwd, env, onEvent, onExit, onLog } = this.options;
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    this.#stderr = "";

    const decoder = new JsonlDecoder(
      (value) => this.#handleValue(value, onEvent),
      (error, line) => onLog?.(`Pi RPC JSON 解析失败: ${error.message}; ${line.slice(0, 200)}`),
    );
    child.stdout.on("data", (chunk) => decoder.push(chunk));
    child.stdout.on("end", () => decoder.end());
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      this.#stderr = (this.#stderr + text).slice(-8000);
      onLog?.(text.trimEnd());
    });
    child.on("error", (error) => onLog?.(`Pi 进程错误: ${error.message}`));

    child.once("exit", (code, signal) => {
      this.#rejectPending(new Error(`Pi 已退出 (${signal ?? code ?? "unknown"})`));
      if (this.#child === child) this.#child = undefined;
      Promise.resolve(onExit?.({ code, signal, stderr: this.stderrTail }))
        .catch((error) => onLog?.(`处理 Pi 退出事件失败: ${error.message}`));
    });

    try {
      await new Promise((resolve, reject) => {
        const failed = (error) => reject(error);
        child.once("error", failed);
        child.once("spawn", () => {
          child.off("error", failed);
          resolve();
        });
      });
    } catch (error) {
      if (this.#child === child) this.#child = undefined;
      throw error;
    }
  }

  async request(command, timeoutMs = 10_000) {
    if (!this.running) throw new Error("Pi 未运行");
    const id = `monitor-${this.#nextId++}`;
    const payload = { ...command, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Pi RPC ${command.type} 超时`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      });
    });
  }

  send(command) {
    if (!this.running) throw new Error("Pi 未运行");
    this.#child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  async stop() {
    const child = this.#child;
    if (!child || child.exitCode !== null) return;
    try {
      await this.request({ type: "abort" }, 2000);
    } catch {}
    child.stdin.end();
    await waitForExit(child, 5000);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child, 2000);
    }
  }

  #handleValue(value, onEvent) {
    if (value?.type === "response" && value.id && this.#pending.has(value.id)) {
      const pending = this.#pending.get(value.id);
      clearTimeout(pending.timer);
      this.#pending.delete(value.id);
      if (value.success === false) pending.reject(new Error(value.error ?? `${value.command} 失败`));
      else pending.resolve(value);
      return;
    }
    this.#eventQueue = this.#eventQueue
      .then(() => onEvent?.(value))
      .catch((error) => this.options.onLog?.(`处理 Pi 事件失败: ${error.message}`));
  }

  #rejectPending(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      child.off("exit", done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    child.once("exit", done);
  });
}
