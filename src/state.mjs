import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class StateStore {
  #queue = Promise.resolve();

  constructor(path, autostart) {
    this.path = path;
    this.state = initialState(autostart);
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      this.state = { ...this.state, ...parsed, events: Array.isArray(parsed.events) ? parsed.events.slice(-50) : [] };
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`读取状态文件失败: ${error.message}`);
    }
    return this.state;
  }

  addEvent(message) {
    this.state.events.push({ at: Date.now(), message: String(message).slice(0, 500) });
    this.state.events = this.state.events.slice(-50);
  }

  save() {
    const snapshot = JSON.stringify(this.state, null, 2);
    const temp = `${this.path}.${process.pid}.tmp`;
    this.#queue = this.#queue.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(temp, snapshot, { encoding: "utf8", mode: 0o600 });
      await rename(temp, this.path);
    });
    return this.#queue;
  }
}

function initialState(autostart) {
  return {
    desiredRunning: autostart,
    resumePending: false,
    status: "offline",
    startedAt: null,
    lastProgressAt: null,
    currentTool: null,
    progress: null,
    lastTask: null,
    lastTarget: null,
    restartCount: 0,
    cwd: null,
    events: [],
  };
}
