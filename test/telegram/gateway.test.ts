import { describe, expect, it, vi } from "vitest";

import type { TaskRecord } from "../../src/core/types.js";
import type { TelegramApi } from "../../src/telegram/api.js";
import { TelegramInteractiveGateway } from "../../src/telegram/gateway.js";

describe("Telegram Gateway 消息生命周期", () => {
  it("复用一张卡片展示活动工具，并在全部完成后删除", async () => {
    const sendMessage = vi.fn(() => Promise.resolve({ message_id: 42 }));
    const editMessage = vi.fn(() => Promise.resolve({ message_id: 42 }));
    const deleteMessage = vi.fn(() => Promise.resolve(true));
    const api = {
      sendMessage,
      editMessage,
      deleteMessage,
    } as unknown as TelegramApi;
    const gateway = new TelegramInteractiveGateway(
      api,
      10,
      {} as never,
      {} as never,
      1024,
      { error: vi.fn() } as never,
    );
    const task = { id: "12345678-task" } as TaskRecord;

    await gateway.tool(task, { itemId: "a", itemType: "commandExecution", status: "started" });
    await gateway.tool(task, { itemId: "b", itemType: "fileChange", status: "started" });
    await gateway.tool(task, { itemId: "a", itemType: "commandExecution", status: "completed" });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(editMessage).toHaveBeenLastCalledWith(10, 42, expect.stringContaining("fileChange"));
    expect(deleteMessage).not.toHaveBeenCalled();

    await gateway.tool(task, { itemId: "b", itemType: "fileChange", status: "completed" });
    expect(deleteMessage).toHaveBeenCalledWith(10, 42);
  });

  it("任务完成时复用进度卡片，不重复发送最终正文", async () => {
    const sendMessage = vi.fn(() => Promise.resolve({ message_id: 99 }));
    const editMessage = vi.fn(() => Promise.resolve({ message_id: 7 }));
    const gateway = new TelegramInteractiveGateway(
      { sendMessage, editMessage } as unknown as TelegramApi,
      10,
      {} as never,
      {} as never,
      1024,
      { error: vi.fn(), warn: vi.fn() } as never,
    );
    const task = { id: "12345678-task" } as TaskRecord;
    gateway.attachProgress(task.id, 7);
    gateway.progress(task, "相同正文");

    await gateway.final(task, "相同正文");

    expect(sendMessage).not.toHaveBeenCalled();
    expect(editMessage).toHaveBeenLastCalledWith(
      10,
      7,
      "<b>最终结果</b>\n\n相同正文",
      { inline_keyboard: [] },
    );
  });
});
