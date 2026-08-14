import { describe, expect, it, vi } from "vitest";

import type { ProjectRecord, TaskRecord } from "../../src/core/types.js";
import type { TelegramApi } from "../../src/telegram/api.js";
import { TelegramInteractiveGateway } from "../../src/telegram/gateway.js";

describe("Telegram Gateway 消息生命周期", () => {
  it("审批卡只显示 App Server 明确允许的决定", async () => {
    const sendMessage = vi.fn((chatId: number, text: string, markup?: unknown) => {
      void chatId;
      void text;
      void markup;
      return Promise.resolve({ message_id: 42 });
    });
    const approvalManager = {
      create: vi.fn(() => "signed-token"),
      consume: vi.fn((token: string, binding: unknown, decision: "accept") => {
        void token;
        void binding;
        return decision;
      }),
    };
    const gateway = new TelegramInteractiveGateway(
      { sendMessage } as unknown as TelegramApi,
      10,
      approvalManager as never,
      {} as never,
      1024,
      { error: vi.fn() } as never,
    );
    const task = { id: "12345678-task" } as TaskRecord;
    const project = { id: "project", name: "项目", rootPath: "/tmp/project" } as ProjectRecord;

    const pending = gateway.requestApproval(task, {
      requestId: "1",
      threadId: "thread",
      turnId: "turn",
      itemId: "item",
      project,
      kind: "command",
      command: "npm test",
      availableDecisions: ["accept"],
      expiresAt: Date.now() + 60_000,
    });
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledOnce();
    });
    expect(sendMessage.mock.calls[0]?.[2]).toEqual({
      inline_keyboard: [[{ text: "允许一次", callback_data: "approval:signed-token:a" }]],
    });
    gateway.consumeApproval("signed-token", "accept");
    await expect(pending).resolves.toBe("accept");
  });

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

  it("任务失败时复用进度卡片并明确标记失败", async () => {
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

    await gateway.failure(task, "原因：本机 Codex 登录已失效。\n下一步：重新登录后重试。");

    expect(sendMessage).not.toHaveBeenCalled();
    expect(editMessage).toHaveBeenLastCalledWith(
      10,
      7,
      "<b>任务失败</b>\n\n原因：本机 Codex 登录已失效。\n下一步：重新登录后重试。",
      { inline_keyboard: [] },
    );
  });
});
