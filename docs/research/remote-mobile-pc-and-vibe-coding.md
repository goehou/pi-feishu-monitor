# 手机连接电脑：远程桌面与远程 Vibe Coding 项目调研

> 调研日期：2026-07-15。只引用项目仓库、官方文档和官方商店页面；GitHub 活跃度会随时间变化。

## 结论先行

- **只用 Claude Code：**优先用官方 **Remote Control**，不用额外开端口。
- **同时用 Codex 和 Claude Code：**优先试 **Happy**；想自托管并管理多种 agent，再看 **Paseo**。
- **要文件树、Git、终端等完整 Web 工作台：**看 **CloudCLI**。
- **只想从手机接管任意终端：**macOS/Linux 可看 **VibeTunnel**。
- **要控制整台电脑：**优先 **RustDesk**；追求低延迟画面则用 **Sunshine + Moonlight**。
- 个人单机不必上 Apache Guacamole、MeshCentral 一类管理平台，除非确实要统一管理多台机器。

## 一、远程 Vibe Coding

### 1. Claude Code Remote Control（Claude 用户首选）

官方功能把本机 Claude Code 会话同步到 `claude.ai/code`、Claude iOS/Android App 或另一台设备的浏览器。本地文件、命令、MCP 和执行仍在电脑上；本机只建立出站 HTTPS 连接，不开放入站端口。会话 transcript 会存到 Anthropic 服务端以完成同步，需接受其数据策略。

```bash
claude --remote-control
# 已在会话中也可运行：/remote-control
```

随后用手机 Claude App 扫终端二维码，或打开会话 URL。电脑和本地 Claude 进程必须保持运行。

来源：[Remote Control 官方文档](https://code.claude.com/docs/en/remote-control)

### 2. Happy（Codex + Claude Code 的最短路径）

[slopus/happy](https://github.com/slopus/happy) 是 MIT 开源的 iOS、Android、Web 客户端，支持 Codex 和 Claude Code，提供推送通知、桌面/手机切换，并声明端到端加密、无遥测。

```bash
npm install -g happy
happy codex
# 或：happy claude
```

适合“不想搭服务器，只想在手机继续当前 agent 会话”。默认方案依赖 Happy 的同步服务，但项目也包含开源 server 组件。

来源：[Happy README](https://github.com/slopus/happy#readme)、[官网文档](https://happy.engineering/docs/)

### 3. Paseo（自托管、多 agent、跨设备）

[getpaseo/paseo](https://github.com/getpaseo/paseo) 支持 Claude Code、Codex、Copilot、OpenCode 和 Pi；提供 iOS、Android、桌面、Web 和 CLI。agent 在自己的电脑上运行，桌面端可扫码配对手机；项目声明无遥测、跟踪和强制登录，并提供自托管 relay。

```bash
npm install -g @getpaseo/cli
paseo
```

适合同时跑多个 agent、worktree 或希望统一手机控制面的用户；只跑单个 Codex/Claude 会话时比 Happy 重。

来源：[Paseo README](https://github.com/getpaseo/paseo#readme)、[官方文档](https://paseo.sh/docs)

### 4. CloudCLI（手机上的 Web IDE/agent 面板）

[siteboon/claudecodeui](https://github.com/siteboon/claudecodeui) 提供适配手机的 Web UI，支持 Claude Code、Codex 和 Cursor CLI，并集成聊天、文件树、编辑、Git、终端和会话管理。可托管，也可在电脑本地启动：

```bash
npx @cloudcli-ai/cloudcli
```

本地版默认入口为 `http://localhost:3001`。若要跨公网访问，应用层端口不要直接暴露到互联网，应通过 Tailscale/可信 VPN 或配置正确的 HTTPS、认证和访问控制。项目默认禁用 Claude Code 工具，需要按需开启。

来源：[CloudCLI README](https://github.com/siteboon/claudecodeui#readme)、[官方文档](https://cloudcli.ai/docs)

### 5. VibeTunnel（任意终端进手机浏览器）

[amantus-ai/vibetunnel](https://github.com/amantus-ai/vibetunnel) 把终端转成移动端友好的 Web 会话，可运行 Claude Code、Codex 或普通 shell。原生 macOS App 要求 Apple Silicon；npm 版支持 macOS/Linux，官方仍注明 Windows 未支持。iOS 原生 App 尚属 WIP，响应式 Web UI 可直接使用。

```bash
npm install -g vibetunnel
vt codex
# 或：vt claude
```

官方把 Tailscale 列为首选远程访问方式，并提供系统账号、环境变量、SSH key 等认证模式。不要使用无认证模式对公网开放终端。

来源：[VibeTunnel README](https://github.com/amantus-ai/vibetunnel#readme)、[官方文档](https://docs.vibetunnel.sh/)

## 二、手机远程控制整台电脑

### 1. RustDesk（个人用户首选）

[rustdesk/rustdesk](https://github.com/rustdesk/rustdesk) 是开源的 TeamViewer 替代品，手机端支持 Android/iOS，电脑端支持 Windows/macOS/Linux。默认可使用项目公共 rendezvous/relay，也可以自建 RustDesk Server；连接优先直连，无法打洞时中继。

最短路径是电脑和手机都安装 RustDesk，手机输入电脑显示的设备 ID 和一次性密码。需要无人值守时再设置强永久密码；对数据归属有要求时再自建服务，不必一开始就搭服务器。

来源：[客户端文档](https://rustdesk.com/docs/en/client/)、[自建 OSS Server](https://rustdesk.com/docs/en/self-host/rustdesk-server-oss/)、[项目 README](https://github.com/rustdesk/rustdesk#readme)

### 2. Sunshine + Moonlight（低延迟/高画质）

电脑装 [Sunshine](https://github.com/LizardByte/Sunshine)，Android/iPhone 分别装 [Moonlight Android](https://github.com/moonlight-stream/moonlight-android) 或 [Moonlight iOS](https://github.com/moonlight-stream/moonlight-ios)。它原本面向游戏串流，但也可串流完整桌面，画面和延迟通常更适合视频、3D 或外接蓝牙键鼠的场景。

局域网使用最省事；跨公网应优先叠加 Tailscale/WireGuard，而不是随意映射 Sunshine 端口。配置量明显高于 RustDesk。

来源：[Sunshine README](https://github.com/LizardByte/Sunshine#readme)、[Sunshine 入门](https://github.com/LizardByte/Sunshine/blob/master/docs/getting_started.md)、[Moonlight 设置指南](https://github.com/moonlight-stream/moonlight-docs/wiki/Setup-Guide)

### 3. Apache Guacamole（已有服务器或多电脑管理）

[Apache Guacamole](https://guacamole.apache.org/) 是浏览器里的 RDP/VNC/SSH 网关，手机无需专用 App，并有触屏鼠标和屏幕键盘模式。代价是要自建网关、数据库/认证以及后端 RDP/VNC/SSH，个人只连一台电脑通常不如 RustDesk 省事。

生产环境必须配置 HTTPS 和强认证，可按需启用 TOTP。

来源：[架构](https://guacamole.apache.org/doc/gug/guacamole-architecture.html)、[移动触控](https://guacamole.apache.org/doc/gug/using-guacamole.html#mobile-or-touch-devices)、[安全指南](https://guacamole.apache.org/doc/gug/security.html)

## 三、推荐组合

| 目标 | 最小组合 |
|---|---|
| 手机继续本机 Claude Code | Claude Remote Control |
| 手机继续 Codex 或在 Codex/Claude 间切换 | Happy |
| 自托管、多 agent、多 worktree | Paseo |
| 手机还要改文件、看 Git、开终端 | CloudCLI + Tailscale |
| 手机接管 Windows/macOS/Linux 整个桌面 | RustDesk |
| 低延迟桌面/视频/3D | Sunshine + Moonlight + Tailscale |

最实用的双保险是：**Happy（或 Claude Remote Control）负责日常 vibe coding，RustDesk 只在 agent 卡住、需要操作 GUI 时兜底**。这样手机端不用长期忍受缩小后的桌面 IDE，也不必为一个需求搭复杂平台。

## 安全与运行前提

1. 本地方案都要求电脑开机、联网且对应 agent/服务进程仍在运行；电脑睡眠后通常只能等待唤醒或另配 Wake-on-LAN。
2. CloudCLI、VibeTunnel、Paseo Web 等服务端口不要裸露公网；优先使用 [Tailscale](https://tailscale.com/kb/1017/install) 或其他可信 VPN。
3. 开启强密码、设备配对和 MFA（如项目支持）；遗失手机后立即撤销设备/会话。
4. agent 拥有本地 shell 和文件权限。即使连接链路安全，也应保留工具审批、沙箱和最小权限。
