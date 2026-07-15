# Pi × 飞书 24/7 监控桥

在电脑上常驻一个飞书长连接机器人，通过手机查询 Pi 进度、下任务、启动/停止/重启 Pi，并远程审批危险操作。电脑主动连接飞书，不需要公网 IP 或回调地址。

## 已实现

- 飞书单聊/群聊文本控制，按用户 `open_id` 和可选 `chat_id` 白名单鉴权
- 安全发现模式：只打印 `openId/chatId`，不执行任何远程命令
- `状态`、`日志`、远程下任务、停止、下线、启动、重启与新对话
- 固定 Pi Session，进程崩溃后指数退避重启并恢复中断任务
- `notify_progress` 里程碑推送与 `request_human_decision` 人工决策工具
- 删除、发布、远程传输等危险操作的手机审批；提权、磁盘格式化等操作直接拒绝
- 状态原子落盘；systemd/任务计划程序负责桥本身的崩溃拉起

```text
手机飞书
   │  WebSocket 长连接 / 飞书消息 API
   ▼
monitor.mjs ── JSONL stdin/stdout ── Pi --mode rpc
   │                                  │
   │ 状态、看门狗、审批               └─ extensions/pi-monitor.ts
   ▼
.pi-monitor-state.json
```

## 前置条件

- Node.js `>= 22.19`
- 已安装并能正常运行的 Pi：`@earendil-works/pi-coding-agent >= 0.80.3`
- 一个飞书企业自建应用及其机器人能力
- 建议让 Pi 使用专用的非管理员系统账号或容器

## 1. 配置飞书应用

1. 打开[飞书开放平台](https://open.feishu.cn/)，创建**企业自建应用**。
2. 在“应用能力”中启用机器人。
3. 在“权限管理”中开通应用身份权限 `im:message:send_as_bot`；接收消息所需权限按控制台提示一并开通。
4. 在“事件与回调 → 事件配置”中选择**使用长连接接收事件**。
5. 添加事件 `im.message.receive_v1`。
6. 创建并发布应用版本，设置可用范围；群聊使用时把机器人加入群。
7. 在“凭证与基础信息”复制 App ID（通常以 `cli_` 开头）和 App Secret。

无需配置公网 Request URL。App Secret 只写到本机 `.env`，不要发到聊天或提交 Git。

## 2. 首次发现 open_id

安装并创建配置：

```powershell
cd C:\Users\25837\Desktop\loop-toy
npm install
Copy-Item .env.example .env
notepad .env
```

首次配置：

```dotenv
FEISHU_APP_ID=<你的App-ID>
FEISHU_APP_SECRET=<你的App-Secret>
FEISHU_DISCOVERY=1
FEISHU_ALLOWED_OPEN_IDS=
PI_CWD=C:\work\your-project
```

启动：

```powershell
npm start
```

然后在飞书单聊机器人发送任意文字；群聊中请先 `@机器人`。终端会输出：

```text
飞书发现模式: openId=ou_xxxxxxxxx, chatId=oc_xxxxxxxxx
```

发现模式不会启动任何远程命令。把配置改成：

```dotenv
FEISHU_DISCOVERY=0
FEISHU_ALLOWED_OPEN_IDS=ou_xxxxxxxxx
# 可选，只允许这个单聊或群聊
FEISHU_ALLOWED_CHAT_IDS=oc_xxxxxxxxx
```

重启 `npm start`。`CorpId` 是企业 ID，不是员工身份；本项目需要消息发送者的 `open_id`。

## 3. 手机测试

在飞书给机器人发送；群聊命令需要 `@机器人`：

```text
帮助
状态
启动 请检查项目测试并修复失败项
```

首次收到授权用户消息后，桥会记住该单聊或群聊，后续才能主动推送里程碑和审批请求。

## 手机命令

| 命令 | 作用 |
|---|---|
| `状态` | Pi 状态、PID、Session、模型、当前工具、最近进度；跑 `/goal` 长任务时额外显示目标状态、任务进度和最近审计 |
| `启动 [任务]` | 启动 Pi；可同时提交任务 |
| `恢复 [指令]` | 从固定 Session 恢复目标 |
| `追加 <内容>` | 当前任务完成后执行 |
| `转向 <内容>` | 当前 turn 完成工具调用后改变方向 |
| `停止` | 中止当前任务，Pi 进程保持在线 |
| `下线` | 关闭 Pi，飞书桥保持在线；不会自动恢复旧任务 |
| `重启` | 重启 Pi；正在执行的任务会自动恢复 |
| `新对话` | 开启全新会话，清空历史上下文 |
| `切换 <目录>` | 切换 Pi 工作目录并重启；目录必须存在 |
| `日志 [1-30]` | 最近状态事件 |
| `批准 <编号>` / `拒绝 <编号>` | 处理危险操作审批 |

未匹配命令的普通文本会作为新任务提交。英文别名可发送 `/status`、`/start`、`/resume`、`/follow`、`/steer`、`/abort`、`/offline`、`/restart`、`/new`、`/cd`、`/logs`、`/approve`、`/reject`。

## 任务进度

扩展向 Pi 注册了 `notify_progress`。模型在重要里程碑调用它后，手机会收到推送，`状态` 也会展示最后一次业务进度：

```json
{"message":"单元测试已通过，开始集成测试","current":2,"total":3}
```

Pi 的 `agent_start`、工具执行、压缩、服务商重试和 `agent_end` 事件也会更新运行状态。流式 token 只更新内存心跳，不会逐 token 写磁盘。

要让一个目标跨 turn 持续推进，仍需配置 `pi-goal-x` 或等价目标循环扩展。本桥负责进程存活、远程控制和崩溃恢复，不替代目标规划器。建议：

```dotenv
PI_RESUME_PROMPT=/goal continue
```

### 目标状态（与 pi-goal-x 集成）

跑 `/goal` 长任务时，`状态` 命令会额外读取 `pi-goal-x` 的 ledger（`<PI_CWD>/.pi/goals/goal_events.jsonl`）并重构当前聚焦目标的状态，不打扰正在运行的 agent：

```text
🎯 目标：把测试覆盖率提到 80%
目标状态：active
任务进度：2/7 完成（跳过 1）
最近审计：disapproved — 测试还没跑通
```

没有 goal 或 ledger 不存在时这几行不出现，不影响原有输出。

## 推荐扩展

本桥负责进程存活、远程控制和崩溃恢复，不替代目标规划器。以下三个 pi 扩展补齐 24/7 自主运行的剩余缺口，全部为全局安装后随 Pi 子进程自动加载，无需改本桥配置：

```bash
pi install npm:pi-goal-x
pi install npm:@narumitw/pi-caffeinate
pi install npm:pi-loop-police
```

| 扩展 | 解决的问题 |
|---|---|
| [`pi-goal-x`](https://www.npmjs.com/package/pi-goal-x) | 目标跨 turn 持续推进，turn 结束自动续跑；配合 `PI_RESUME_PROMPT=/goal continue` 实现崩溃后自动恢复目标 |
| [`@narumitw/pi-caffeinate`](https://www.npmjs.com/package/@narumitw/pi-caffeinate) | agent 运行时阻止电脑睡眠/息屏，空闲时恢复；堵住“电脑睡着桥拉不醒”的缺口 |
| [`pi-loop-police`](https://www.npmjs.com/package/pi-loop-police) | 实时检测并打断无限思维块和重复工具调用循环；堵住“进程没崩但 agent 空转烧钱”的缺口 |

安装后验证加载：

```bash
pi list
pi --verbose -p "ok" 2>&1 | grep -iE "caffeinate|loop.police"
```

## 危险操作审批

长连接模式不接收飞书卡片回调，因此审批使用文本，避免额外开放公网 webhook：

```text
🟠 Pi 等待审批 [a1b2c3]
删除文件
rm build.tmp

回复：批准 a1b2c3
或：拒绝 a1b2c3
```

审批超时会自动拒绝。如以后确实需要按钮，再增加 HTTPS webhook 和 `card.action.trigger` 回调；当前不为一个按钮引入公网服务。

## 配置项

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `FEISHU_APP_ID` | 必填 | 飞书企业自建应用 App ID |
| `FEISHU_APP_SECRET` | 必填 | App Secret，仅由桥使用，不传给 Pi |
| `FEISHU_DISCOVERY` | `0` | 为 `1` 时只发现身份，不执行命令 |
| `FEISHU_ALLOWED_OPEN_IDS` | 正式运行必填 | 可控制 Pi 的用户 open_id，逗号分隔 |
| `FEISHU_ALLOWED_CHAT_IDS` | 空 | 可选会话白名单，逗号分隔 |
| `PI_CWD` | 必填 | Pi 工作项目目录 |
| `PI_COMMAND` | Windows `pi.cmd`；其他 `pi` | Pi 启动命令 |
| `PI_SESSION_ID` | `pi-247` | 固定 Session ID |
| `PI_ARGS_JSON` | `[]` | 额外 Pi 参数的 JSON 字符串数组 |
| `PI_AUTOSTART` | `1` | 桥启动时是否启动 Pi |
| `PI_RESUME_PROMPT` | 内置恢复指令 | 崩溃后的恢复消息，可设 `/goal continue` |
| `PI_APPROVAL_TIMEOUT_MS` | `600000` | 审批超时，限制为 10 秒至 24 小时 |
| `PI_SEND_ASSISTANT_TEXT` | `0` | 完成通知是否附带模型最终文本。开启后手机可直接看到 Pi 的回答内容，但可能把业务内容发到飞书 |
| `PI_STATE_FILE` | 项目根目录状态文件 | 持久化状态路径 |
| `PI_EXTENSION` | 内置扩展路径 | 使用定制副本时覆盖 |

指定模型：

```dotenv
PI_ARGS_JSON='["--provider","openai","--model","openai/your-model-id"]'
```

`PI_ARGS_JSON` 不允许覆盖 RPC 模式、固定 Session 或禁用扩展，但允许继续加载其他扩展。

## 24/7 部署

### Windows：任务计划程序

创建“计算机启动时”任务：

- 程序：`C:\Program Files\nodejs\node.exe`
- 参数：`--env-file=C:\path\to\pi-monitor\.env C:\path\to\pi-monitor\src\monitor.mjs`
- 起始于：项目目录
- 勾选“失败后重新启动”，并关闭电脑自动睡眠

### Linux：systemd

编辑 `deploy/pi-monitor.service` 中的用户和目录后：

```bash
sudo cp deploy/pi-monitor.service /etc/systemd/system/
sudo install -m 600 .env /etc/pi-feishu-monitor.env
sudo systemctl daemon-reload
sudo systemctl enable --now pi-monitor
sudo journalctl -u pi-monitor -f
```

确保服务账号能写 `PI_CWD`、Pi Session 目录和 `PI_STATE_FILE`，但不要赋予 root/sudo 权限。systemd 的 `PATH` 通常不包含用户 npm bin，应把 `PI_COMMAND` 配成绝对路径。

监控桥离线时无法从飞书启动它自己；电脑关机或睡眠时也无法响应，需依靠 supervisor、电源策略或 Wake-on-LAN。

## 安全边界

1. 正式运行必须配置 `open_id` 白名单，建议同时配置 `chat_id` 白名单。
2. 发现模式只记录身份，不处理任务；发现完成后立即关闭。
3. 桥不会把 `FEISHU_*` 凭证传给 Pi，日志和手机消息会遮盖常见 token/key。
4. 命令正则和手机审批只是第二道防线，**不是沙箱**。
5. Pi 应在专用非管理员账号、容器或 VM 中运行，只挂载允许修改的项目目录；不要让 `PI_CWD` 指向本监控项目。
6. `.env` 与状态文件应限制为仅服务账号可读；`PI_SEND_ASSISTANT_TEXT=1` 可能把业务内容发到飞书，默认关闭。

## 目录

```text
src/                      飞书桥、Pi RPC、状态与配置
extensions/               Pi 审批/进度扩展
test/                     Node 内置测试
deploy/pi-monitor.service  systemd 示例
DESIGN.md                 架构、恢复语义和威胁模型
```

验证：

```bash
npm test
npm run check
```
