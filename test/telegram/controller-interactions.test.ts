import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { BridgeConfig } from "../../src/core/config.js";
import { RuntimeSettings } from "../../src/runtime/settings.js";
import { ApprovalManager, AuditLog, PairingService, PermissionLeaseManager, ProjectRegistry } from "../../src/security/index.js";
import { BridgeDatabase, TaskLedger } from "../../src/storage/index.js";
import type { TelegramApi } from "../../src/telegram/api.js";
import { TelegramController } from "../../src/telegram/controller.js";
import type { TelegramMessage } from "../../src/telegram/types.js";

const databases: BridgeDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("Telegram 交互式管理菜单", () => {
  it("通过 project 按钮切换项目，并为其他管理能力生成按钮", async () => {
    const database = new BridgeDatabase(":memory:");
    databases.push(database);
    const pairing = new PairingService(database);
    const code = pairing.requestCode("10", "10", "private");
    const owner = pairing.confirmCode(code);
    const projects = new ProjectRegistry(database);
    const first = projects.register(mkdtempSync(path.join(tmpdir(), "ctb-first-")), "First");
    const second = projects.register(mkdtempSync(path.join(tmpdir(), "ctb-second-")), "Second");
    new RuntimeSettings(database).set("active_project_id", first.id);
    const tasks = new TaskLedger(database);
    tasks.ingestTelegramTask({ updateId: 1, messageId: 1, projectId: first.id, body: "test" });
    database.connection.prepare("INSERT INTO threads(id, project_id, codex_thread_id, permission_profile, closed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("session-12345678", first.id, "codex-thread", "workspace-write + on-request", Date.now(), Date.now(), Date.now());

    const sent: Array<{ text: string; markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } }> = [];
    const edited: typeof sent = [];
    const api = {
      sendMessage: vi.fn((_chatId: number, text: string, markup?: typeof sent[number]["markup"]) => {
        sent.push({ text, ...(markup ? { markup } : {}) });
        return Promise.resolve({ message_id: sent.length, chat: { id: 10, type: "private" }, date: Math.floor(Date.now() / 1000) });
      }),
      editMessage: vi.fn((_chatId: number, _messageId: number, text: string, markup?: typeof sent[number]["markup"]) => {
        edited.push({ text, ...(markup ? { markup } : {}) });
        return Promise.resolve({ message_id: 1, chat: { id: 10, type: "private" }, date: Math.floor(Date.now() / 1000) });
      }),
      answerCallback: vi.fn(() => Promise.resolve(true)),
    } as unknown as TelegramApi;
    const approvals = new ApprovalManager(database, Buffer.alloc(32, 1));
    const cancel = vi.fn(() => Promise.resolve());
    const controller = new TelegramController(
      api,
      database,
      tasks,
      pairing,
      projects,
      new PermissionLeaseManager(database),
      approvals,
      new AuditLog(database, Buffer.alloc(16, 2)),
      { currentTask: { id: "current-task" }, cancel, wake: vi.fn() } as never,
      { cleanup: vi.fn(() => Promise.resolve({ attachments: 0, artifacts: 0 })) } as never,
      { setChatId: vi.fn(), answerTextInput: vi.fn(() => false), attachProgress: vi.fn() } as never,
      { render: vi.fn(() => Promise.resolve("健康")) },
      { render: vi.fn(() => Promise.resolve("<b>Codex 剩余额度</b>\n剩余 75%")) },
      {
        list: vi.fn(() => Promise.resolve([{ id: "gpt", model: "gpt-test", displayName: "GPT Test", description: "test", hidden: false, isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "低" }, { reasoningEffort: "medium", description: "中" }], serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed" }], defaultServiceTier: "priority" }])),
        localState: vi.fn(() => Promise.resolve({ model: "gpt-test", reasoningEffort: "low", serviceTier: "default" })),
      },
      null,
      { allowDangerFullAccess: false, attachmentRetentionHours: 24, taskRetentionDays: 7, auditRetentionDays: 30 } as BridgeConfig,
      { error: vi.fn() } as never,
    );
    let updateId = 10;
    const command = async (text: string): Promise<void> => {
      const message: TelegramMessage = { message_id: updateId, date: Math.floor(Date.now() / 1000), chat: { id: 10, type: "private" }, from: { id: 10, is_bot: false, first_name: "Owner" }, text };
      await controller.handle({ update_id: updateId++, message });
    };

    await command("/project");
    expect(sent.at(-1)?.markup?.inline_keyboard).toHaveLength(3);
    const secondButton = sent.at(-1)?.markup?.inline_keyboard[1]?.[0];
    expect(secondButton?.text).toContain("Second");
    if (!secondButton) throw new Error("缺少 Second 项目按钮");
    await controller.handle({ update_id: updateId++, callback_query: { id: "cb", from: { id: 10, is_bot: false, first_name: "Owner" }, message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: 10, type: "private" } }, data: secondButton.callback_data } });
    expect(new RuntimeSettings(database).get("active_project_id")).toBe(second.id);
    expect(edited.at(-1)?.text).toContain("Second");
    expect(edited.at(-1)?.markup).toEqual({ inline_keyboard: [] });

    await command("/project");
    const removeMenuButton = sent.at(-1)?.markup?.inline_keyboard.at(-1)?.[0];
    expect(removeMenuButton?.text).toBe("移除项目");
    if (!removeMenuButton) throw new Error("缺少移除项目按钮");
    await controller.handle({ update_id: updateId++, callback_query: { id: "cb-remove-menu", from: { id: 10, is_bot: false, first_name: "Owner" }, message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: 10, type: "private" } }, data: removeMenuButton.callback_data } });
    expect(edited.at(-1)?.text).toContain("点击项目即可");
    const removeSecondButton = edited.at(-1)?.markup?.inline_keyboard.find((row) => row[0]?.text.includes("Second"))?.[0];
    if (!removeSecondButton) throw new Error("缺少移除 Second 项目按钮");
    await controller.handle({ update_id: updateId++, callback_query: { id: "cb-remove", from: { id: 10, is_bot: false, first_name: "Owner" }, message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: 10, type: "private" } }, data: removeSecondButton.callback_data } });
    expect(projects.require(second.id).enabled).toBe(false);
    expect(new RuntimeSettings(database).get("active_project_id")).toBe(first.id);
    expect(edited.at(-1)?.text).toContain("项目已移除");
    expect(edited.at(-1)?.markup).toEqual({ inline_keyboard: [] });

    new RuntimeSettings(database).set("active_project_id", first.id);
    for (const text of ["/tasks", "/sessions", "/model", "/effort", "/fast", "/permissions", "/cleanup"]) {
      await command(text);
      expect(sent.at(-1)?.markup?.inline_keyboard.length).toBeGreaterThan(0);
    }
    expect(sent.find((item) => item.text.includes("选择模型"))?.text).toContain("选择模型");
    expect(sent.find((item) => item.text.includes("选择模型"))?.text).toContain("本机：gpt-test");
    expect(sent.find((item) => item.text.includes("选择推理强度"))?.text).toContain("本机：low");
    expect(sent.find((item) => item.text.includes("选择 Fast 模式"))?.text).toContain("本机：default");
    expect(sent.find((item) => item.text.includes("确认本地清理"))?.text).toContain("不会删除项目源码");

    const chooseLastMenuRow = async (rowIndex: number): Promise<void> => {
      const button = sent.at(-1)?.markup?.inline_keyboard[rowIndex]?.[0];
      if (!button) throw new Error(`菜单缺少第 ${rowIndex + 1} 个选项`);
      await controller.handle({
        update_id: updateId++,
        callback_query: {
          id: `cb-${updateId}`,
          from: { id: 10, is_bot: false, first_name: "Owner" },
          message: { message_id: sent.length, date: Math.floor(Date.now() / 1000), chat: { id: 10, type: "private" } },
          data: button.callback_data,
        },
      });
      expect(edited.at(-1)?.markup).toEqual({ inline_keyboard: [] });
    };

    await command("/model");
    await chooseLastMenuRow(1);
    expect(edited.at(-1)?.text).toContain("模型已更新");
    await command("/effort");
    await chooseLastMenuRow(1);
    expect(edited.at(-1)?.text).toContain("思考深度已更新");
    await command("/fast");
    await chooseLastMenuRow(1);
    expect(edited.at(-1)?.text).toContain("Fast 已更新");
    await command("/permissions");
    await chooseLastMenuRow(0);
    expect(edited.at(-1)?.text).toContain("权限已更新");
    await command("/cleanup");
    await chooseLastMenuRow(1);
    expect(edited.at(-1)?.text).toContain("操作已取消");

    await command("/new");
    expect(sent.at(-1)?.text).toContain("新对话配置");
    expect(sent.at(-1)?.text).toContain("项目：First");
    expect(sent.at(-1)?.text).toContain("模型：<code>gpt-test</code>");
    expect(sent.at(-1)?.text).toContain("思考深度：<code>low</code>");
    expect(sent.at(-1)?.text).toContain("Fast：关闭");
    database.connection.prepare("UPDATE projects SET service_tier = ? WHERE id = ?").run("priority", first.id);
    await command("/new");
    expect(sent.at(-1)?.text).toContain("Fast：开启（<code>priority</code>）");

    await command("/stop");
    expect(cancel).toHaveBeenLastCalledWith("current-task");
    expect(sent.at(-1)?.text).toContain("已取消");
    await command("/cancel");
    expect(cancel).toHaveBeenCalledTimes(2);
    await command("/quota");
    expect(sent.at(-1)?.text).toContain("剩余 75%");

    await command("/version");
    expect(sent.at(-1)?.text).toBe("Codex Telegram Bridge 1.1.2");

    await command("/plan");
    expect(new RuntimeSettings(database).get(`plan_mode:${first.id}`)).toBe("plan");
    expect(sent.at(-1)?.text).toContain("Plan 模式已开启");
    await command("先分析并生成计划");
    expect(tasks.listTasks([], 1)[0]?.collaborationMode).toBe("plan");
    await command("/plan off");
    expect(new RuntimeSettings(database).get(`plan_mode:${first.id}`)).toBeNull();

    database.connection.prepare("UPDATE projects SET permission_profile = ? WHERE id = ?")
      .run("workspace-write + on-request", first.id);
    const executeToken = approvals.create({
      requestId: `plan:${first.id}`,
      threadId: "codex-thread",
      turnId: "plan-turn",
      itemId: "plan-item",
    }, Date.now() + 60_000);
    await controller.handle({
      update_id: updateId++,
      callback_query: {
        id: "cb-plan-execute",
        from: { id: 10, is_bot: false, first_name: "Owner" },
        message: { message_id: 99, date: Math.floor(Date.now() / 1000), chat: { id: 10, type: "private" }, text: "计划内容" },
        data: `pm:${executeToken}:e`,
      },
    });
    const executionTask = tasks.listTasks([], 1)[0];
    expect(executionTask?.body).toBe("Implement the plan.");
    expect(executionTask?.collaborationMode).toBe("default");
    expect(edited.at(-1)?.text).toContain("计划执行已进入队列");

    const skipToken = approvals.create({
      requestId: `plan:${first.id}`,
      threadId: "codex-thread",
      turnId: "plan-turn-2",
      itemId: "plan-item-2",
    }, Date.now() + 60_000);
    await controller.handle({
      update_id: updateId++,
      callback_query: {
        id: "cb-plan-skip",
        from: { id: 10, is_bot: false, first_name: "Owner" },
        message: { message_id: 100, date: Math.floor(Date.now() / 1000), chat: { id: 10, type: "private" }, text: "计划正文" },
        data: `pm:${skipToken}:s`,
      },
    });
    expect(edited.at(-1)?.text).toContain("计划已跳过");
    expect(edited.at(-1)?.markup).toEqual({ inline_keyboard: [] });
    expect(owner.id).toBe(1);
  });
});
