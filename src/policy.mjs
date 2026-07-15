import { isAbsolute, relative, resolve, sep } from "node:path";

const DENIED_COMMANDS = [
  [/(?:^|[;&|]\s*)(?:sudo|doas|su)(?:\s|$)/i, "禁止提权"],
  [/\b(?:shutdown|reboot|poweroff|halt)\b/i, "禁止关闭或重启主机"],
  [/\b(?:mkfs(?:\.\w+)?|fdisk|parted|diskpart)\b/i, "禁止磁盘操作"],
  [/\b(?:curl|wget)\b[^\n|;&]*\|\s*(?:sh|bash|zsh|fish|pwsh|powershell)\b/i, "禁止下载后直接执行"],
  [/\bgit\s+push\b[^\n]*\s--force(?:-with-lease)?\b/i, "禁止强制推送"],
  [/\brm\s+(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)\s+(?:\/|~|\$HOME)(?:\s|$)/i, "禁止递归删除根目录"],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, "禁止 fork bomb"],
];

const APPROVAL_COMMANDS = [
  [/\b(?:rm|rmdir|del)\b|\bRemove-Item\b/i, "删除文件"],
  [/\bgit\s+(?:push|reset\s+--hard|clean\b|branch\s+-D)\b/i, "破坏性或远程 Git 操作"],
  [/\b(?:npm|pnpm|yarn)\s+(?:publish|unpublish)\b/i, "发布软件包"],
  [/\b(?:chmod|chown|icacls|takeown)\b/i, "修改权限"],
  [/\b(?:kubectl\s+(?:apply|delete)|helm\s+(?:install|upgrade|uninstall)|terraform\s+(?:apply|destroy))\b/i, "修改基础设施"],
  [/\bdocker\s+(?:system\s+prune|rm\b|rmi\b|compose\s+down)\b/i, "破坏性容器操作"],
  [/\b(?:scp|sftp|rsync)\b/i, "远程传输文件"],
  [/\b(?:curl|wget)\b[^\n]*(?:--data|-d\s|--form|-F\s|--upload-file|-T\s)/i, "向外发送数据"],
  [/\b(?:powershell|pwsh)\b[^\n]*(?:-e|-en|-enc|-encodedcommand)\b/i, "执行编码后的 PowerShell"],
  [
    /\b(?:cat|type|Get-Content|gc|head|tail)\b[^\n]*(?:\.env(?:\.[\w-]+)?|\.ssh[\\\/]|\.pi[\\\/])/i,
    "读取敏感文件",
  ],
];

const SENSITIVE_PATHS = new Set([".env", ".ssh", ".git", ".pi"]);

export function classifyCommand(command) {
  if (typeof command !== "string" || !command.trim()) return deny("命令为空或格式错误");
  if (command.length > 20_000) return deny("命令过长，无法安全审核");
  for (const [pattern, reason] of DENIED_COMMANDS) {
    if (pattern.test(command)) return deny(reason);
  }
  for (const [pattern, reason] of APPROVAL_COMMANDS) {
    if (pattern.test(command)) return { action: "approve", reason };
  }
  return { action: "allow" };
}

export function classifyPath(cwd, candidate) {
  if (typeof candidate !== "string" || !candidate.trim()) return deny("路径为空或格式错误");
  const root = resolve(cwd);
  const rel = relative(root, resolve(root, candidate));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return deny("禁止访问工作区外部");
  }
  if (rel.split(/[\\/]+/).some((part) => SENSITIVE_PATHS.has(part.toLowerCase()))) {
    return { action: "approve", reason: "访问敏感项目元数据" };
  }
  return { action: "allow" };
}

function deny(reason) {
  return { action: "deny", reason };
}
