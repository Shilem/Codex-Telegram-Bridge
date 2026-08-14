import { afterEach, describe, expect, it, vi } from "vitest";

import type { BridgeConfig } from "../../src/core/config.js";
import { BridgeDatabase } from "../../src/storage/index.js";
import type { TelegramApi } from "../../src/telegram/api.js";
import { TelegramController, type UpdateProvider } from "../../src/telegram/controller.js";
import type { TerminalUpdateAction } from "../../src/update/action-store.js";

const databases: BridgeDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function terminal(status: TerminalUpdateAction["status"]): TerminalUpdateAction {
  return {
    schemaVersion: 1,
    actionId: "ctb-update-00000000-0000-0000-0000-000000000000",
    currentVersion: "1.0.0",
    expectedVersion: "1.1.0",
    chatId: 10,
    messageId: 20,
    createdAt: 1_000,
    updatedAt: 6_000,
    status,
    command: { executable: "/bin/bash", args: [], environment: {} },
    result: {
      exitCode: status === "succeeded" ? 0 : 1,
      reason: status === "rolled_back" ? "健康检查失败，已回滚" : "安装依赖失败",
    },
  };
}

function controllerFor(action: TerminalUpdateAction, editRejects = false) {
  const database = new BridgeDatabase(":memory:");
  databases.push(database);
  const editMessage = editRejects
    ? vi.fn(() => Promise.reject(new Error("message cannot be edited")))
    : vi.fn(() => Promise.resolve({ message_id: 20 }));
  const sendMessage = vi.fn(() => Promise.resolve({ message_id: 21 }));
  const api = { editMessage, sendMessage } as unknown as TelegramApi;
  const updates = {
    check: vi.fn(),
    install: vi.fn(),
    pendingActions: vi.fn(() => Promise.resolve([action])),
    waitForTerminal: vi.fn(() => Promise.resolve(action)),
    markNotified: vi.fn(() => Promise.resolve()),
  } satisfies UpdateProvider;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const controller = new TelegramController(
    api,
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
    updates,
    {} as BridgeConfig,
    logger as never,
  );
  return { controller, editMessage, sendMessage, updates, logger };
}

describe("Telegram 更新终态恢复", () => {
  it("服务重启后把成功结果更新到原消息并清理动作", async () => {
    const fixture = controllerFor(terminal("succeeded"));
    await fixture.controller.resumePendingUpdateNotifications();
    expect(fixture.editMessage).toHaveBeenCalledWith(10, 20, expect.stringContaining("更新成功"), { inline_keyboard: [] });
    expect(fixture.editMessage).toHaveBeenCalledWith(10, 20, expect.stringContaining("健康检查：通过"), { inline_keyboard: [] });
    expect(fixture.updates.markNotified).toHaveBeenCalledWith("ctb-update-00000000-0000-0000-0000-000000000000");
  });

  it("原消息不可编辑时发送新的回滚终态消息", async () => {
    const fixture = controllerFor(terminal("rolled_back"), true);
    await fixture.controller.resumePendingUpdateNotifications();
    expect(fixture.sendMessage).toHaveBeenCalledWith(10, expect.stringContaining("更新失败，已自动回滚"));
    expect(fixture.updates.markNotified).toHaveBeenCalledOnce();
    expect(fixture.logger.warn).toHaveBeenCalledOnce();
  });
});
