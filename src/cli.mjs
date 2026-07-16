#!/usr/bin/env node
// CLI entry: global install boots into first-run setup if no config exists.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const pkg = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));

const CONFIG_DIR = resolve(homedir(), ".pi-feishu-monitor");
const ENV_FILE = resolve(CONFIG_DIR, ".env");
const STATE_FILE = resolve(CONFIG_DIR, "state.json");

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    printHelp();
    return;
  }
  if (args.includes("-v") || args.includes("--version")) {
    console.log(pkg.version);
    return;
  }
  if (args.includes("--config")) {
    console.log(`配置目录: ${CONFIG_DIR}`);
    console.log(`配置文件: ${ENV_FILE}`);
    console.log(`状态文件: ${STATE_FILE}`);
    if (!existsSync(ENV_FILE)) console.log("(尚未创建配置)");
    return;
  }
  ensureConfigDir();
  if (!existsSync(ENV_FILE)) {
    console.log("未找到配置，进入首次配置向导。\n");
    await firstRunSetup();
    console.log(`\n配置已写入 ${ENV_FILE}\n可手动编辑后重新运行，或直接启动。\n`);
  }
  loadEnvIntoProcess();
  process.env.PI_STATE_FILE = process.env.PI_STATE_FILE || STATE_FILE;
  const { loadConfig } = await import("./config.mjs");
  const { Monitor } = await import("./monitor.mjs");
  await new Monitor(loadConfig()).run();
}

function printHelp() {
  console.log(`pi-feishu-monitor v${pkg.version}
Pi × 飞书 24/7 监控桥

用法:
  pi-feishu-monitor            启动监控桥（首次运行进入配置向导）
  pi-feishu-monitor --version   显示版本号
  pi-feishu-monitor --help      显示本帮助
  pi-feishu-monitor --config    显示配置文件路径

配置文件位于 ${ENV_FILE}
文档: https://www.npmjs.com/package/pi-feishu-monitor`);
}

function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
}

async function firstRunSetup() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => rl.question(q);
  const appId = await required(ask, "飞书 App ID (cli_xxx): ");
  const appSecret = await required(ask, "飞书 App Secret: ");
  const piCwd = await required(ask, "Pi 工作目录 (绝对路径): ");
  console.log("\n首次接入建议先用发现模式抓取 open_id。");
  const discovery = (await ask("启用发现模式? (Y/n): ")).trim().toLowerCase() !== "n" ? "1" : "0";
  const openIds = discovery === "0" ? (await ask("授权 open_id (逗号分隔): ")).trim() : "";
  rl.close();

  const lines = [
    `FEISHU_APP_ID=${appId}`,
    `FEISHU_APP_SECRET=${appSecret}`,
    `FEISHU_DISCOVERY=${discovery}`,
    `FEISHU_ALLOWED_OPEN_IDS=${openIds}`,
    `PI_CWD=${piCwd}`,
  ];
  const { writeFileSync } = await import("node:fs");
  writeFileSync(ENV_FILE, lines.join("\n") + "\n", { mode: 0o600 });
}

async function required(ask, prompt) {
  while (true) {
    const value = (await ask(prompt)).trim();
    if (value) return value;
    console.log("⚠� 必填项，请重新输入。");
  }
}

function loadEnvIntoProcess() {
  const content = readFileSync(ENV_FILE, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
}

main().catch((error) => {
  console.error(error?.message ?? error);
  process.exit(1);
});
