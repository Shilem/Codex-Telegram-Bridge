import type { TelegramApi } from "./api.js";
import type { Logger } from "pino";

export class TelegramProgressMessage {
  #lastEditAt = 0;
  #pending: NodeJS.Timeout | null = null;
  #latestText: string | null = null;

  public constructor(
    private readonly api: TelegramApi,
    private readonly chatId: number,
    private readonly messageId: number,
    private readonly logger: Logger,
  ) {}

  public update(text: string): void {
    this.#latestText = text;
    const waitMs = Math.max(0, 1_000 - (Date.now() - this.#lastEditAt));
    if (this.#pending) return;
    this.#pending = setTimeout(() => {
      this.#pending = null;
      void this.flush().catch((error: unknown) => {
        this.logger.error({ error: error instanceof Error ? error.message : String(error) }, "更新 Telegram 进度消息失败");
      });
    }, waitMs);
  }

  public async flush(): Promise<void> {
    if (this.#pending) {
      clearTimeout(this.#pending);
      this.#pending = null;
    }
    const text = this.#latestText;
    this.#latestText = null;
    if (!text) return;
    await this.api.editMessage(this.chatId, this.messageId, text);
    this.#lastEditAt = Date.now();
  }
}
