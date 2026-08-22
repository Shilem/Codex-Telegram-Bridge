import { afterEach, describe, expect, it, vi } from "vitest";

import type { BridgeConfig } from "../../src/core/config.js";
import { BridgeDatabase, TaskLedger } from "../../src/storage/index.js";
import type { TelegramApi } from "../../src/telegram/api.js";
import { TelegramController, type RestartProvider } from "../../src/telegram/controller.js";
import type { RestartAction, TerminalRestartAction } from "../../src/update/restart-action-store.js";

const databases: BridgeDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("Telegram Bridge 重启终态恢复", () => {
  it("服务重启后启动已落账的待重启动作并写回成功结果", async () => {
    const database = new BridgeDatabase(":memory:");
    databases.push(database);
    new TaskLedger(database).recordNonTaskUpdate(2, "committed", "callback_restart");
    const action = {
      schemaVersion: 1,
      actionId: "ctb-restart-00000000-0000-0000-0000-000000000000",
      chatId: 10,
      messageId: 20,
      createdAt: 1_000,
      updatedAt: 6_000,
      status: "pending",
      sourceUpdateId: 2,
      commands: [{ executable: "systemctl", args: ["--user", "restart", "codex-telegram-bridge.service"] }],
      environment: { PATH: "/usr/bin" },
    } as RestartAction;
    const terminal: TerminalRestartAction = {
      ...action,
      status: "succeeded",
      result: { exitCode: 0, reason: "Bridge 服务已由服务管理器重启" },
    };
    const editMessage = vi.fn(() => Promise.resolve({ message_id: 20 }));
    const restarts = {
      request: vi.fn(),
      launchAfterUpdateCommitted: vi.fn(() => Promise.resolve({ ...action, status: "launching" as const })),
      cancelUncommitted: vi.fn(),
      pendingActions: vi.fn(() => Promise.resolve([action])),
      waitForTerminal: vi.fn(() => Promise.resolve(terminal)),
      markNotified: vi.fn(() => Promise.resolve()),
    } satisfies RestartProvider;
    const controller = new TelegramController(
      { editMessage, sendMessage: vi.fn() } as unknown as TelegramApi,
      database,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      null,
      {} as BridgeConfig,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      restarts,
    );

    await controller.resumePendingUpdateNotifications();

    expect(restarts.launchAfterUpdateCommitted).toHaveBeenCalledWith(action.actionId);
    expect(editMessage).toHaveBeenCalledWith(10, 20, expect.stringContaining("Bridge 重启成功"), { inline_keyboard: [] });
    expect(editMessage).toHaveBeenCalledWith(10, 20, expect.stringContaining("运行中的任务已标记为 unknown"), { inline_keyboard: [] });
    expect(restarts.markNotified).toHaveBeenCalledWith(action.actionId);
  });

  it("服务重启后终态化未落账动作，避免它阻塞后续重启", async () => {
    const database = new BridgeDatabase(":memory:");
    databases.push(database);
    const action = {
      schemaVersion: 1,
      actionId: "ctb-restart-00000000-0000-0000-0000-000000000001",
      chatId: 10,
      messageId: 20,
      createdAt: 1_000,
      updatedAt: 2_000,
      status: "pending",
      sourceUpdateId: 3,
      commands: [{ executable: "systemctl", args: ["--user", "restart", "codex-telegram-bridge.service"] }],
      environment: { PATH: "/usr/bin" },
    } as RestartAction;
    const terminal: TerminalRestartAction = {
      ...action,
      status: "failed",
      result: { exitCode: null, reason: "Telegram update 未完成落账，已取消重启动作以避免重放" },
    };
    const cancelUncommitted = vi.fn(() => Promise.resolve(terminal));
    const restarts = {
      request: vi.fn(),
      launchAfterUpdateCommitted: vi.fn(),
      cancelUncommitted,
      pendingActions: vi.fn(() => Promise.resolve([action])),
      waitForTerminal: vi.fn(() => Promise.resolve(terminal)),
      markNotified: vi.fn(() => Promise.resolve()),
    };
    const controller = new TelegramController(
      { editMessage: vi.fn(), sendMessage: vi.fn(() => Promise.resolve({ message_id: 21 })) } as unknown as TelegramApi,
      database,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      null,
      {} as BridgeConfig,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      restarts as never,
    );

    await controller.resumePendingUpdateNotifications();

    expect(cancelUncommitted).toHaveBeenCalledWith(action.actionId);
  });
});
