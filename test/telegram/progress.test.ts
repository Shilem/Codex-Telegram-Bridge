import { afterEach, describe, expect, it, vi } from "vitest";

import type { TelegramApi } from "../../src/telegram/api.js";
import { TelegramProgressMessage } from "../../src/telegram/progress.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Telegram 进度消息", () => {
  it("合并发送中的增量，并保证最终定稿不会被旧请求覆盖", async () => {
    vi.useFakeTimers();
    let finishFirstEdit: (() => void) | undefined;
    const editMessage = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        finishFirstEdit = resolve;
      }))
      .mockResolvedValue({ message_id: 7 });
    const logger = { debug: vi.fn(), error: vi.fn() };
    const progress = new TelegramProgressMessage(
      { editMessage } as unknown as TelegramApi,
      10,
      7,
      "task-1",
      logger as never,
    );

    progress.update("过程一");
    await vi.advanceTimersByTimeAsync(0);
    expect(editMessage).toHaveBeenCalledTimes(1);

    progress.update("过程二");
    progress.update("过程三");
    const finalized = progress.finalize("最终答案");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(editMessage).toHaveBeenCalledTimes(1);

    finishFirstEdit?.();
    await finalized;
    expect(editMessage).toHaveBeenCalledTimes(2);
    expect(editMessage.mock.calls[1]).toEqual([10, 7, "最终答案", { inline_keyboard: [] }]);

    progress.update("过期过程");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(editMessage).toHaveBeenCalledTimes(2);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("同一时刻的数百个增量只发送最新内容", async () => {
    vi.useFakeTimers();
    const editMessage = vi.fn(() => Promise.resolve({ message_id: 7 }));
    const logger = { debug: vi.fn(), error: vi.fn() };
    const progress = new TelegramProgressMessage(
      { editMessage } as unknown as TelegramApi,
      10,
      7,
      "task-2",
      logger as never,
    );

    for (let index = 1; index <= 624; index += 1) progress.update(`第 ${index} 段`);
    await progress.flush();

    expect(editMessage).toHaveBeenCalledOnce();
    expect(editMessage).toHaveBeenCalledWith(10, 7, "第 624 段");
    expect(logger.debug).toHaveBeenCalledWith(
      { taskId: "task-2", coalescedUpdates: 624 },
      "已合并 Telegram 进度更新",
    );
  });
});
