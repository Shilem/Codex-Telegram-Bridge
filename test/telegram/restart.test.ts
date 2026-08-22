import { afterEach, describe, expect, it, vi } from "vitest";

import type { BridgeConfig } from "../../src/core/config.js";
import { ApprovalManager, AuditLog, PairingService, PermissionLeaseManager, ProjectRegistry } from "../../src/security/index.js";
import { BridgeDatabase, TaskLedger } from "../../src/storage/index.js";
import type { TelegramApi } from "../../src/telegram/api.js";
import { TelegramController } from "../../src/telegram/controller.js";
import type { RestartAction } from "../../src/update/restart-action-store.js";

const databases: BridgeDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("Telegram Bridge 重启", () => {
  it("/restart 需要一次性确认，并只在 update 落账后启动独立重启动作", async () => {
    const database = new BridgeDatabase(":memory:");
    databases.push(database);
    const pairing = new PairingService(database);
    const code = pairing.requestCode("10", "10", "private");
    pairing.confirmCode(code);
    const sent: Array<{ text: string; markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } }> = [];
    const edited: typeof sent = [];
    const api = {
      sendMessage: vi.fn((_chatId: number, text: string, markup?: typeof sent[number]["markup"]) => {
        sent.push({ text, ...(markup ? { markup } : {}) });
        return Promise.resolve({ message_id: 20, chat: { id: 10, type: "private" }, date: Math.floor(Date.now() / 1000) });
      }),
      editMessage: vi.fn((_chatId: number, _messageId: number, text: string, markup?: typeof sent[number]["markup"]) => {
        edited.push({ text, ...(markup ? { markup } : {}) });
        return Promise.resolve({ message_id: 20, chat: { id: 10, type: "private" }, date: Math.floor(Date.now() / 1000) });
      }),
      answerCallback: vi.fn(() => Promise.resolve(true)),
    } as unknown as TelegramApi;
    const action: RestartAction = {
      schemaVersion: 1,
      actionId: "ctb-restart-00000000-0000-0000-0000-000000000000",
      chatId: 10,
      messageId: 20,
      createdAt: 1_000,
      updatedAt: 1_000,
      status: "pending",
      commands: [{ executable: "systemctl", args: ["--user", "restart", "codex-telegram-bridge.service"] }],
      environment: { PATH: "/usr/bin" },
    };
    const restarts = {
      request: vi.fn(() => Promise.resolve(action)),
      launchAfterUpdateCommitted: vi.fn(() => Promise.resolve(action)),
      pendingActions: vi.fn(() => Promise.resolve([])),
      waitForTerminal: vi.fn(),
      markNotified: vi.fn(),
    };
    const controller = new TelegramController(
      api,
      database,
      new TaskLedger(database),
      pairing,
      new ProjectRegistry(database),
      new PermissionLeaseManager(database),
      new ApprovalManager(database, Buffer.alloc(32, 1)),
      new AuditLog(database, Buffer.alloc(16, 2)),
      { currentTask: null, cancel: vi.fn(), wake: vi.fn() } as never,
      { cleanup: vi.fn() } as never,
      { setChatId: vi.fn(), answerTextInput: vi.fn(), attachProgress: vi.fn() } as never,
      { render: vi.fn() },
      { render: vi.fn() },
      { list: vi.fn(), localState: vi.fn() },
      null,
      { allowDangerFullAccess: false, attachmentRetentionHours: 24, taskRetentionDays: 7, auditRetentionDays: 30 } as BridgeConfig,
      { error: vi.fn(), info: vi.fn(), warn: vi.fn() } as never,
      restarts as never,
    );

    await controller.handle({
      update_id: 1,
      message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: 10, type: "private" }, from: { id: 10, is_bot: false, first_name: "Owner" }, text: "/restart" },
    });
    const confirmation = sent.at(-1);
    expect(confirmation?.text).toContain("确认重启 Bridge");
    expect(confirmation?.text).toContain("运行中的任务将标记为 unknown");
    const button = confirmation?.markup?.inline_keyboard[0]?.[0];
    if (!button) throw new Error("缺少重启确认按钮");

    await controller.handle({
      update_id: 2,
      callback_query: {
        id: "restart-confirm",
        from: { id: 10, is_bot: false, first_name: "Owner" },
        message: { message_id: 20, date: Math.floor(Date.now() / 1000), chat: { id: 10, type: "private" } },
        data: button.callback_data,
      },
    });
    expect(restarts.request).toHaveBeenCalledWith({ chatId: 10, messageId: 20, sourceUpdateId: 2 });
    expect(restarts.launchAfterUpdateCommitted).not.toHaveBeenCalled();
    expect(edited.at(-1)?.text).toContain("重启已确认");
    expect(edited.at(-1)?.markup).toEqual({ inline_keyboard: [] });

    await controller.launchRestartAfterUpdateCommitted(2);
    expect(restarts.launchAfterUpdateCommitted).toHaveBeenCalledWith(action.actionId);
  });
});
