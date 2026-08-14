import type { TelegramApi } from "./api.js";
import type { Logger } from "pino";

export class TelegramProgressMessage {
  #lastEditAt = 0;
  #latestText: string | null = null;
  #drainPromise: Promise<void> | null = null;
  #releaseWait: (() => void) | null = null;
  #terminal = false;
  #coalescedUpdates = 0;

  public constructor(
    private readonly api: TelegramApi,
    private readonly chatId: number,
    private readonly messageId: number,
    private readonly taskId: string,
    private readonly logger: Logger,
  ) {}

  public update(text: string): void {
    if (this.#terminal) return;
    this.#latestText = text;
    this.#coalescedUpdates += 1;
    this.#startDrain();
  }

  public async flush(): Promise<void> {
    if (this.#terminal) return;
    this.#startDrain();
    await this.#drainPromise;
  }

  public async finalize(text: string): Promise<void> {
    this.#terminal = true;
    this.#latestText = null;
    this.#coalescedUpdates = 0;
    this.#releaseWait?.();
    await this.#drainPromise;
    await this.api.editMessage(this.chatId, this.messageId, text, { inline_keyboard: [] });
    this.#lastEditAt = Date.now();
  }

  #startDrain(): void {
    if (this.#drainPromise || this.#terminal || this.#latestText === null) return;
    const drain = this.#drain()
      .catch((error: unknown) => {
        this.logger.error({
          taskId: this.taskId,
          error: error instanceof Error ? error.message : String(error),
        }, "更新 Telegram 进度消息失败");
      })
      .finally(() => {
        if (this.#drainPromise === drain) this.#drainPromise = null;
        if (!this.#terminal && this.#latestText !== null) this.#startDrain();
      });
    this.#drainPromise = drain;
  }

  async #drain(): Promise<void> {
    while (this.#hasPendingText()) {
      await this.#waitForRateLimit();
      const pending = this.#takePendingText();
      if (!pending) return;
      try {
        await this.api.editMessage(this.chatId, this.messageId, pending.text);
      } finally {
        this.#lastEditAt = Date.now();
      }
      if (pending.coalescedUpdates > 1) {
        this.logger.debug({
          taskId: this.taskId,
          coalescedUpdates: pending.coalescedUpdates,
        }, "已合并 Telegram 进度更新");
      }
    }
  }

  #hasPendingText(): boolean {
    return !this.#terminal && this.#latestText !== null;
  }

  #takePendingText(): { text: string; coalescedUpdates: number } | null {
    if (this.#terminal || this.#latestText === null) return null;
    const pending = { text: this.#latestText, coalescedUpdates: this.#coalescedUpdates };
    this.#latestText = null;
    this.#coalescedUpdates = 0;
    return pending;
  }

  async #waitForRateLimit(): Promise<void> {
    const waitMs = Math.max(0, 1_000 - (Date.now() - this.#lastEditAt));
    if (waitMs === 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#releaseWait = null;
        resolve();
      }, waitMs);
      this.#releaseWait = () => {
        clearTimeout(timer);
        this.#releaseWait = null;
        resolve();
      };
    });
  }
}
