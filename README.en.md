# Pi × Feishu 24/7 Monitor Bridge

Run a persistent Feishu long-connection bot on your computer to query Pi progress, dispatch tasks, start/stop/restart Pi from your phone, and approve dangerous operations remotely. The computer connects outbound to Feishu — no public IP or callback URL required.

**中文文档见 [README.md](./README.md)。**

## Features

- Feishu direct message / group chat text control, authorized by user `open_id` and optional `chat_id` allowlist
- Safe discovery mode: prints `openId/chatId` only, executes no remote commands
- `status`, `logs`, remote task dispatch, stop, offline, start, restart, and new conversation
- Fixed Pi Session with exponential-backoff restart and interrupted-task recovery after crashes
- `notify_progress` milestone push and `request_human_decision` human-decision tool
- Phone approval for dangerous operations (delete, publish, remote transfer); privilege escalation and disk formatting are denied outright
- Atomic state persistence; systemd / Task Scheduler brings the bridge itself back up

```text
Phone Feishu
   │  WebSocket long connection / Feishu message API
   ▼
monitor.mjs ── JSONL stdin/stdout ── Pi --mode rpc
   │                                  │
   │ state, watchdog, approval        └─ extensions/pi-monitor.ts
   ▼
.pi-monitor-state.json
```

## Prerequisites

- Node.js `>= 22.19`
- Pi installed and working: `@earendil-works/pi-coding-agent >= 0.80.3`
- A Feishu enterprise self-built app with bot capability enabled
- Recommended: run Pi under a dedicated non-admin system account or container

## 1. Configure the Feishu App

1. Open the [Feishu Open Platform](https://open.feishu.cn/) and create an **enterprise self-built app**.
2. Under **App Capabilities**, enable the **Bot**.
3. Under **Permission Management**, grant `im:message:send_as_bot`; also grant the receive-message permissions shown in the console.
4. Under **Events & Callbacks → Event Configuration**, choose **Use long connection to receive events**.
5. Add the event `im.message.receive_v1`.
6. Create and publish an app version; set the availability scope. Add the bot to any group chats you want to use.
7. Under **Credentials & Basic Info**, copy the App ID (usually starts with `cli_`) and App Secret.

No public Request URL is needed. The App Secret is only stored in the local `.env` — never share it in chat or commit it to Git.

## 2. First-Time open_id Discovery

Install and create the config:

```bash
cd path/to/loop-toy
npm install
cp .env.example .env
# edit .env
```

First-time config:

```dotenv
FEISHU_APP_ID=<your-app-id>
FEISHU_APP_SECRET=<your-app-secret>
FEISHU_DISCOVERY=1
FEISHU_ALLOWED_OPEN_IDS=
PI_CWD=/path/to/your-project
```

Start:

```bash
npm start
```

Then send any text to the bot in a Feishu direct message; in a group, `@mention` the bot first. The terminal will print:

```text
飞书发现模式: openId=ou_xxxxxxxxx, chatId=oc_xxxxxxxxx
```

Discovery mode starts no remote commands. Update the config:

```dotenv
FEISHU_DISCOVERY=0
FEISHU_ALLOWED_OPEN_IDS=ou_xxxxxxxxx
# optional: restrict to this DM or group chat
FEISHU_ALLOWED_CHAT_IDS=oc_xxxxxxxxx
```

Restart `npm start`. `CorpId` is the enterprise ID, not a user identity; this project needs the message sender's `open_id`.

## 3. Test from Your Phone

Send commands to the bot in Feishu; in a group, `@mention` the bot:

```text
帮助
状态
启动 Check the project tests and fix failures
```

After the first authorized-user message, the bridge remembers that DM/group chat and can then push milestones and approval requests proactively.

## Phone Commands

| Command | Action |
|---|---|
| `状态` / `status` | Pi status: PID, session, model, current tool, recent progress; additionally shows goal status, task progress, and latest audit while a `/goal` long task is running |
| `启动 [task]` / `start` | Start Pi; optionally submit a task at the same time |
| `恢复 [instr]` / `resume` | Resume the goal from the fixed session |
| `追加 <text>` / `follow` | Queue work to run after the current task finishes |
| `转向 <text>` / `steer` | Change direction after the current turn's tool calls |
| `停止` / `abort` | Abort the current task; Pi stays online |
| `下线` / `offline` | Shut down Pi; bridge stays online; old task is not auto-resumed |
| `重启` / `restart` | Restart Pi; an in-progress task is auto-resumed |
| `新对话` / `new` | Start a fresh session, clearing conversation history |
| `切换 <dir>` / `cd` | Switch Pi's working directory and restart; directory must exist |
| `日志 [1-30]` / `logs` | Recent state events |
| `批准 <id>` / `approve` | Approve a dangerous operation |
| `拒绝 <id>` / `reject` | Reject a dangerous operation |

Any unmatched plain text is submitted as a new task. English aliases: `/status`, `/start`, `/resume`, `/follow`, `/steer`, `/abort`, `/offline`, `/restart`, `/new`, `/cd`, `/logs`, `/approve`, `/reject`.

## Task Progress

The extension registers `notify_progress` with Pi. When the model calls it at meaningful milestones, the phone receives a push and `status` shows the latest business progress:

```json
{"message":"Unit tests passed, starting integration tests","current":2,"total":3}
```

Pi's `agent_start`, tool execution, compaction, provider retries, and `agent_end` events also update runtime state. Streaming tokens only update an in-memory heartbeat — they are not written to disk per-token.

### Goal Status (pi-goal-x integration)

While a `/goal` long task is running, the `status` command additionally reads `pi-goal-x`'s ledger (`<PI_CWD>/.pi/goals/goal_events.jsonl`) and reconstructs the focused goal's state without disturbing the running agent:

```text
🎯 Goal: Raise test coverage to 80%
Goal status: active
Task progress: 2/7 done (1 skipped)
Latest audit: disapproved — tests not passing yet
```

These lines do not appear when no goal is set or the ledger is absent, leaving the original output unchanged.

## Recommended Extensions

The bridge handles process liveness, remote control, and crash recovery — it does not replace a goal planner. These three pi extensions fill the remaining gaps for 24/7 autonomous operation. All are installed globally and auto-load with the Pi subprocess; no bridge config change required:

```bash
pi install npm:pi-goal-x
pi install npm:@narumitw/pi-caffeinate
pi install npm:pi-loop-police
```

| Extension | Gap it closes |
|---|---|
| [`pi-goal-x`](https://www.npmjs.com/package/pi-goal-x) | Keeps a goal advancing across turns and auto-continues when a turn ends; pair with `PI_RESUME_PROMPT=/goal continue` for crash recovery |
| [`@narumitw/pi-caffeinate`](https://www.npmjs.com/package/@narumitw/pi-caffeinate) | Prevents sleep/display-off while the agent is running, releases on idle; closes the "computer asleep, bridge can't wake it" gap |
| [`pi-loop-police`](https://www.npmjs.com/package/pi-loop-police) | Detects and interrupts infinite thinking blocks and repeated tool-call loops in real time; closes the "process alive but agent spinning, burning tokens" gap |

Verify loading after install:

```bash
pi list
pi --verbose -p "ok" 2>&1 | grep -iE "caffeinate|loop.police"
```

## Dangerous-Operation Approval

Long-connection mode does not receive Feishu card callbacks, so approvals use text — avoiding the need for an extra public webhook:

```text
🟠 Pi 等待审批 [a1b2c3]
删除文件
rm build.tmp

回复：批准 a1b2c3
或：拒绝 a1b2c3
```

Approvals auto-reject on timeout. If button UX is truly needed later, add an HTTPS webhook and `card.action.trigger` callback; for now a public service is not introduced for a single button.

## Configuration

| Env var | Default | Description |
|---|---|---|
| `FEISHU_APP_ID` | required | Feishu self-built app App ID |
| `FEISHU_APP_SECRET` | required | App Secret; used only by the bridge, never passed to Pi |
| `FEISHU_DISCOVERY` | `0` | `1` = identity discovery only, no commands executed |
| `FEISHU_ALLOWED_OPEN_IDS` | required in production | User open_ids allowed to control Pi, comma-separated |
| `FEISHU_ALLOWED_CHAT_IDS` | empty | Optional chat allowlist, comma-separated |
| `PI_CWD` | required | Project directory Pi works in |
| `PI_COMMAND` | `pi.cmd` on Windows; `pi` elsewhere | Pi launch command |
| `PI_SESSION_ID` | `pi-247` | Fixed session ID |
| `PI_ARGS_JSON` | `[]` | Extra Pi args as a JSON string array |
| `PI_AUTOSTART` | `1` | Whether to start Pi when the bridge starts |
| `PI_RESUME_PROMPT` | built-in resume instruction | Message sent after crash recovery; can be `/goal continue` |
| `PI_APPROVAL_TIMEOUT_MS` | `600000` | Approval timeout; clamped to 10s–24h |
| `PI_SEND_ASSISTANT_TEXT` | `0` | Whether completion notices include the model's final text. Enable to see Pi's answer on your phone; may send business content to Feishu |
| `PI_STATE_FILE` | project-root state file | Persistent state path |
| `PI_EXTENSION` | built-in extension path | Override when using a customized copy |

Specifying a model:

```dotenv
PI_ARGS_JSON='["--provider","openai","--model","openai/your-model-id"]'
```

`PI_ARGS_JSON` may not override RPC mode, the fixed session, or disable extensions, but may load additional extensions.

## 24/7 Deployment

### Windows: Task Scheduler

Create a task that runs **at computer startup**:

- Program: `C:\Program Files\nodejs\node.exe`
- Arguments: `--env-file=C:\path\to\pi-monitor\.env C:\path\to\pi-monitor\src\monitor.mjs`
- Start in: the project directory
- Enable "restart on failure", and disable automatic sleep

### Linux: systemd

Edit the user and directory in `deploy/pi-monitor.service`, then:

```bash
sudo cp deploy/pi-monitor.service /etc/systemd/system/
sudo install -m 600 .env /etc/pi-feishu-monitor.env
sudo systemctl daemon-reload
sudo systemctl enable --now pi-monitor
sudo journalctl -u pi-monitor -f
```

Ensure the service account can write `PI_CWD`, the Pi session directory, and `PI_STATE_FILE`, but does not have root/sudo. systemd's `PATH` usually excludes the user npm bin — set `PI_COMMAND` to an absolute path.

The bridge cannot start itself from Feishu when it is offline; it also cannot respond when the computer is off or asleep — rely on a supervisor, power policy, or Wake-on-LAN.

## Security Boundaries

1. Production must configure an `open_id` allowlist; a `chat_id` allowlist is also recommended.
2. Discovery mode only logs identities and processes no tasks; turn it off once discovery is done.
3. The bridge never passes `FEISHU_*` credentials to Pi; logs and phone messages redact common tokens/keys.
4. Command regexes and phone approval are a second line of defense — **not a sandbox**.
5. Run Pi in a dedicated non-admin account, container, or VM, mounting only the project directory it may modify; do not point `PI_CWD` at this monitor project.
6. Restrict `.env` and the state file to the service account only; `PI_SEND_ASSISTANT_TEXT=1` may send business content to Feishu and is off by default.

## Directory Layout

```text
src/                      Feishu bridge, Pi RPC, state, config
extensions/               Pi approval/progress extension
test/                     Node built-in tests
deploy/pi-monitor.service  systemd example
DESIGN.md                 architecture, recovery semantics, threat model
```

Verify:

```bash
npm test
npm run check
```
