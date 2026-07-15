# 设计说明：Pi × 飞书 24/7 监控桥

## 目标

1. 手机通过飞书查询 Pi 运行状态并远程下任务。
2. Pi 子进程崩溃后自动重启，固定 Session 不丢失；中断任务自动收到恢复指令。
3. 危险内置工具调用必须远程批准或被直接拒绝。
4. 里程碑、完成、工具错误、模型重试和进程崩溃可主动推送。
5. 单机、自部署、无入站公网端口，依赖和运维复杂度尽可能低。

## 非目标

- 不提供远程桌面、任意终端或文件浏览器。
- 不替代 `pi-goal-x` 一类跨 turn 目标循环器。
- 不用正则审批冒充 OS 沙箱。
- 不支持多主 monitor 共享同一 Pi Session。
- 不接收飞书卡片按钮回调；长连接不支持回调订阅，审批使用文本。

## 架构

```text
┌──────────────┐       Feishu WebSocket/API       ┌────────────────────┐
│ 手机飞书     │◄────────────────────────────────►│ FeishuBridge       │
└──────────────┘                                   │ - 身份/会话白名单  │
                                                   │ - 发现模式/消息队列 │
                                                   └─────────┬──────────┘
                                                             │
                                                   ┌─────────▼──────────┐
                   原子 JSON 状态 ◄───────────────│ Monitor            │
                                                   │ - 命令路由          │
                                                   │ - 状态/通知/审批    │
                                                   │ - 指数退避看门狗    │
                                                   └─────────┬──────────┘
                                                             │ JSONL stdin/stdout
                                                   ┌─────────▼──────────┐
                                                   │ Pi --mode rpc      │
                                                   │ 固定 session-id    │
                                                   └─────────┬──────────┘
                                                             │ Extension UI
                                                   ┌─────────▼──────────┐
                                                   │ pi-monitor.ts      │
                                                   │ - tool_call 门禁   │
                                                   │ - 进度/人工决策工具 │
                                                   └────────────────────┘
```

systemd/任务计划程序监控桥；桥内部监控一个 Pi 子进程。

## 组件职责

### `src/feishu.mjs`

- 使用飞书官方 `@larksuiteoapi/node-sdk` Channel 建立 WebSocket 长连接。
- SDK 负责身份 token、事件规范化、消息去重、回复和主动发送。
- 收到消息后校验 `senderId(open_id)`，可选校验 `chatId`。
- 发现模式只输出经过日志清洗的 openId/chatId，永不调用 monitor。
- 授权消息进入单队列，避免“下线”和“启动”等命令并发竞态。
- 回调处理立即入队并返回，耗时 Pi 操作不会占用飞书 3 秒事件处理窗口。
- 飞书断线由 SDK 自动重连，并记录重连状态。

### `src/pi-rpc.mjs`

- 用 `cross-spawn` 跨平台启动 `pi`/`pi.cmd`，启动参数不来自远程消息。
- 按 LF 解析 JSONL，使用 `StringDecoder` 保证分块 UTF-8 字符不损坏。
- 每个请求带本地 ID、超时和 pending map；进程退出时拒绝全部未完成请求。
- 事件按顺序处理。停止时先 `abort`，再关闭 stdin；Pi RPC 在 EOF 后自行清理并退出。
- `exit` 监听在等待 `spawn` 前注册，避免快速退出竞态。

### `src/monitor.mjs`

- 路由手机命令，维护 Pi 生命周期、审批表、通知冷却和可读状态。
- 高频 `message_update`/`tool_execution_update` 只更新内存心跳，不逐 token 写磁盘。
- 丢弃旧 Pi 实例延迟到达的事件，避免重启后状态被旧进程覆盖。
- Pi 首次启动失败不会带走飞书桥；后台继续指数退避。

### `extensions/pi-monitor.ts`

- `tool_call` 钩子调用 `policy.mjs`：`allow`、`approve` 或 `deny`。
- 审批通过 Pi RPC 的 `extension_ui_request/response` 阻塞等待手机文本决定。
- `notify_progress` 同时发 `setStatus` 与 `notify`。
- `request_human_decision` 提供模型主动求助的阻塞式 yes/no 工具。

### `src/state.mjs`

单实例使用一个 JSON 文件，不引入数据库。写入流程是“同目录临时文件 → rename”，写任务串行执行；一次写失败不会毒化后续写队列。

| 字段 | 含义 |
|---|---|
| `desiredRunning` | 用户是否希望 Pi 在线 |
| `resumePending` | 已接受任务尚未收到 `agent_end`，崩溃后需恢复 |
| `status` | `offline/starting/idle/running/approval/retrying/crashed` |
| `startedAt` / `lastProgressAt` | 进程启动与最近活动时间 |
| `currentTool` / `progress` | 技术进度与业务里程碑 |
| `lastTask` | 已脱敏、截断的任务摘要 |
| `lastTarget` | 最近授权飞书 chatId，用于主动推送 |
| `restartCount` | 指数退避计数 |
| `events` | 最多 50 条状态事件 |

## 身份发现与授权

正式运行要求 `FEISHU_ALLOWED_OPEN_IDS` 非空。首次接入不知道 open_id 时，可设置 `FEISHU_DISCOVERY=1`：

1. 飞书桥照常认证并接收事件。
2. 消息只输出 `openId/chatId`，不传给命令路由，也不回复。
3. 部署者把目标 open_id 写入白名单，可选锁定 chat_id。
4. 关闭发现模式并重启。

授权判定为：`open_id ∈ 用户白名单` 且 `chat_id ∈ 会话白名单`；会话白名单为空时只检查用户。CorpId、App ID 和 open_id 是不同身份，不可互换。

## 生命周期与恢复语义

```text
offline ──启动──► starting ──成功──► idle ──prompt──► running
   ▲                  │                         │          │
   │                  └─失败──► crashed ◄─退出─┘          ├─confirm──► approval
   │                              │                       ├─429/5xx──► retrying
   └────────下线──────────────────┘                       └─agent_end► idle
                                  └─5s..300s 后重启
```

- 接受任务或收到 `agent_start` 时设置 `resumePending=true`。
- 正常 `agent_end`、用户 `停止` 或 `下线` 时清除它。
- Pi 意外退出后按 5、10、20、40……最多 300 秒重启。
- 成功运行超过 60 秒后，下一次退出重新从 5 秒开始退避。
- 新 Pi 打开同一 `--session-id`；若 `resumePending=true`，发送 `PI_RESUME_PROMPT`。
- monitor 被直接杀死时若持久状态仍为 `running/approval/retrying`，重启后重新武装恢复。
- `PI_AUTOSTART=1` 在全新状态只启动空闲 Pi，不会凭空创建目标。
- 模型服务重试耗尽时只告警，不进行无限 API 重试，避免无上限费用。

## 审批策略

`policy.mjs` 永久拒绝提权、关机、磁盘操作、下载即执行、fork bomb、根目录递归删除和强推。删除文件、远程 Git、包发布、权限变更、基础设施修改、远程文件传输、数据上传、编码 PowerShell、读取常见敏感文件需要审批。

流程：

1. 扩展调用 `ctx.ui.confirm()`，Pi 发出 `extension_ui_request`。
2. monitor 生成随机短 ID，保存 RPC ID 与超时 timer，并推送飞书文本。
3. 只有白名单用户可发送 `批准 <id>` 或 `拒绝 <id>`。
4. monitor 返回 `confirmed` 或 `cancelled`；超时默认拒绝。
5. Pi 退出、任务停止或下线时清除未完成审批。

短 ID 不是认证凭据；认证边界是飞书应用长连接和 open_id/chat_id 白名单。

## 关键决策

| 决策 | 选择 | 原因与代价 |
|---|---|---|
| 飞书接入 | 企业自建机器人 + WebSocket | 无公网回调；依赖飞书长连接与应用权限 |
| SDK | 官方 Node SDK Channel | 复用规范化、去重、重连与发送；依赖包较大 |
| Pi 控制 | 独立 monitor + RPC | 生命周期不绑在易崩溃扩展内；多一个常驻进程 |
| Session | 固定 `--session-id` | 重启确定性恢复；不适合并行多项目共用实例 |
| 状态 | 原子 JSON | 单机足够、易检查；不支持多主并发写 |
| 进程守护 | 内层看 Pi、外层 supervisor | 故障域清晰；外部 supervisor 必须配置 |
| 审批 UI | 文本命令 | 无公网服务；暂时没有按钮体验 |
| 命令门禁 | 少量 deny/approve 正则 | 低成本第二防线；不能替代权限隔离 |

## 信任边界与威胁模型

### 资产

- 飞书 App Secret 和机器人发送权限
- Pi 使用的模型 API Key
- 项目代码、Git 凭据及部署凭据
- Session、任务摘要与审批结果

| 威胁 | 控制 | 残余风险 |
|---|---|---|
| 未授权用户发命令 | open_id 必填白名单；可叠加 chat_id | 白名单账号或手机失陷后仍可控制 |
| 发现模式误执行 | 发现模式在命令路由前直接返回 | 日志会包含 open_id/chat_id，应限制日志访问 |
| 远程命令注入 monitor | 用户文本只作为 JSON RPC 消息，不拼入启动命令 | 模型可能选择危险工具，仍需审批/沙箱 |
| Pi 读取机器人密钥 | 子进程环境移除 `FEISHU_*` 及遗留 `DINGTALK_*` | Pi 仍需模型 Key，也可能读取磁盘 `.env` |
| 密钥进入通知/日志 | 常见 key、Bearer、password 模式脱敏并截断 | 无标签或编码后的秘密可能漏出 |
| 正则门禁绕过 | 高危常见模式拒绝/审批 | 解释器、自定义工具、别名、符号链接均可绕过 |
| 审批重放 | pending map 一次性删除、超时拒绝 | 多个白名单管理员可互相审批 |
| 状态损坏 | 原子 rename、最多 50 条事件、POSIX 0600 | Windows ACL 需部署者单独配置 |
| 子进程泄漏 | stdin EOF 优雅退出；systemd control-group | 非 supervisor 环境强杀失败时仍需管理员处理 |

最终安全边界必须是**专用低权限账号/容器/VM + 最小挂载目录**。扩展策略只用于减少误操作。

## 可用性与故障处理

| 故障 | 行为 |
|---|---|
| Pi 启动命令不存在 | 飞书桥保持在线，状态为 crashed，后台退避重试 |
| Pi RPC 输出坏 JSON | 记录截断解析错误，后续行继续处理 |
| Pi 进程退出 | pending RPC 失败，审批清空，推送告警并重启 |
| 飞书断线 | 官方 SDK 自动重连并记录状态 |
| 飞书主动推送失败 | 记录脱敏错误；Pi 工作不被中止 |
| 尚无主动推送目标 | 通知写日志；授权用户首次发消息后恢复 |
| 状态文件单次写失败 | 当前错误被记录，下一次保存仍可继续 |
| monitor 崩溃 | 外部 supervisor 拉起，固定 Session/持久状态恢复 |
| 电脑关机、断网或睡眠 | 无法远程控制；需电源策略或 Wake-on-LAN |

## 已知限制

1. 只运行一个 Pi 实例；多项目需要独立配置、状态文件和 Session。
2. 长连接只支持事件订阅，不支持卡片回调；按钮需额外部署 HTTPS webhook。
3. 只门禁 Pi 的内置 `bash/read/write/edit`；其他扩展工具必须自行审计。
4. 进度是事件与模型主动里程碑，不是可证明的完成百分比。
5. 状态 JSON 不做跨进程锁；禁止两个 monitor 指向同一个状态文件/Session。

## 变更历史

- **2026-07-15 / v0.2.0**：将钉钉桥替换为飞书官方 SDK 长连接，增加安全发现模式与 open_id/chat_id 白名单。
- **2026-07-15 / v0.1.0**：完成 Pi RPC 生命周期、状态查询、文本审批、进度工具与崩溃恢复。
