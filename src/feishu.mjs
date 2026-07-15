import * as Lark from "@larksuiteoapi/node-sdk";

export class FeishuBridge {
  #channel;
  #queue = Promise.resolve();

  constructor(options) {
    this.options = options;
    this.target = options.initialTarget;
  }

  async start() {
    const channel = Lark.createLarkChannel({
      appId: this.options.appId,
      appSecret: this.options.appSecret,
      transport: "websocket",
      loggerLevel: Lark.LoggerLevel.error,
      handshakeTimeoutMs: 15_000,
      source: "pi-feishu-monitor",
      policy: {
        dmMode: this.options.discovery ? "open" : "allowlist",
        dmAllowlist: this.options.discovery ? undefined : [...this.options.allowedOpenIds],
        requireMention: true,
        respondToMentionAll: false,
        groupAllowlist: this.options.allowedChatIds.size ? [...this.options.allowedChatIds] : undefined,
      },
    });
    this.#channel = channel;
    channel.on({
      message: (message) => this.#receiveMessage(message),
      error: (error) => this.options.onLog?.(`飞书通道异常: ${safeError(error)}`),
      reconnecting: () => this.options.onLog?.("飞书长连接正在重连"),
      reconnected: () => this.options.onLog?.("飞书长连接已恢复"),
    });
    await channel.connect();
  }

  async stop() {
    const channel = this.#channel;
    this.#channel = undefined;
    await channel?.disconnect();
  }

  async reply(message, text) {
    if (!this.#channel) throw new Error("飞书长连接未启动");
    return this.#channel.send(message.chatId, { text: String(text) }, { replyTo: message.messageId });
  }

  async send(text, target = this.target) {
    if (!this.#channel) throw new Error("飞书长连接未启动");
    if (!target?.chatId) throw new Error("尚未收到授权用户消息，无法主动推送");
    return this.#channel.send(target.chatId, { text: String(text) });
  }

  #receiveMessage(message) {
    if (this.options.discovery) {
      this.options.onLog?.(`飞书发现模式: openId=${cleanId(message.senderId)}, chatId=${cleanId(message.chatId)}`);
      return;
    }
    if (!isAuthorized(this.options.allowedOpenIds, this.options.allowedChatIds, message.senderId, message.chatId)) {
      this.options.onLog?.(`忽略未授权飞书消息: ${cleanId(message.messageId)}`);
      return;
    }
    this.target = {
      chatId: message.chatId,
      chatType: message.chatType,
      senderId: message.senderId,
    };
    this.options.onTarget?.(this.target);
    this.#enqueue(
      () => this.options.onMessage?.(message),
      async (error) => {
        this.options.onLog?.(`处理飞书消息失败: ${safeError(error)}`);
        try { await this.reply(message, `❌ ${safeError(error)}`); } catch {}
      },
    );
  }

  #enqueue(task, onError) {
    this.#queue = this.#queue.then(task).catch(onError);
  }
}

export function isAuthorized(allowedOpenIds, allowedChatIds, openId, chatId) {
  if (!openId || !allowedOpenIds.has(String(openId))) return false;
  return allowedChatIds.size === 0 || allowedChatIds.has(String(chatId));
}

function cleanId(value) {
  return String(value ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128) || "unknown";
}

function safeError(error) {
  return String(error?.message ?? error)
    .replace(/((?:token|secret|password|api[_-]?key)\s*[:=]\s*)\S+/gi, "$1<redacted>")
    .slice(0, 500);
}
