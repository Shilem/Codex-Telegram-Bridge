import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AppServerClient } from "../../src/app-server/client.js";
import type { CommandApprovalRequest, ServerNotification, ServerRequest } from "../../src/app-server/types.js";
import type { ProjectRecord, TaskRecord } from "../../src/core/types.js";
import { AppServerTaskExecutor, type InteractiveGateway, type RuntimeStore } from "../../src/orchestrator/app-task-executor.js";

const task: TaskRecord = {
  id: "task-1",
  telegramUpdateId: 1,
  sourceMessageId: 1,
  projectId: "project-1",
  threadId: null,
  turnId: null,
  status: "running",
  prompt: "检查登录状态",
  error: null,
  createdAt: 1,
  updatedAt: 1,
};

const project: ProjectRecord = {
  id: "project-1",
  name: "测试项目",
  rootPath: "/private/tmp/project",
  defaultModel: null,
  defaultEffort: null,
  serviceTier: null,
  permissionProfile: "workspace-write + on-request",
  enabled: true,
};

describe("App Server 任务失败反馈", () => {
  it("本机 Codex 登录失效时向 Telegram 发送可操作的失败提示", async () => {
    const failure = vi.fn(() => Promise.resolve());
    const appServer = {
      request: vi.fn(() => Promise.reject(new Error("HTTP 401 token_invalidated: Please sign in again."))),
      onNotification: vi.fn(() => () => {}),
      onFatal: vi.fn(() => () => {}),
      setServerRequestHandler: vi.fn(() => () => {}),
    } as unknown as AppServerClient;
    const store = {
      getTask: vi.fn(() => task),
      project: vi.fn(() => project),
      codexThreadId: vi.fn(() => null),
      saveThread: vi.fn(),
      bindTask: vi.fn(),
      appendTaskEvent: vi.fn(),
      transitionTask: vi.fn(),
      dangerLeaseActive: vi.fn(() => false),
    } satisfies RuntimeStore;
    const gateway = {
      progress: vi.fn(),
      plan: vi.fn(() => Promise.resolve()),
      tool: vi.fn(() => Promise.resolve()),
      final: vi.fn(() => Promise.resolve()),
      failure,
      artifact: vi.fn(() => Promise.resolve()),
      requestApproval: () => Promise.resolve("decline" as const),
      requestInput: vi.fn(() => Promise.resolve({})),
      cancelTask: vi.fn(),
    } satisfies InteractiveGateway;
    const executor = new AppServerTaskExecutor(appServer, store, gateway, pino({ level: "silent" }));

    await expect(executor.execute(task)).rejects.toThrow("token_invalidated");

    expect(failure).toHaveBeenCalledWith(task, expect.stringContaining("本机 Codex 登录已失效"));
    expect(failure).toHaveBeenCalledWith(task, expect.stringContaining("重新登录"));
    executor.dispose();
  });

  it("App Server 因失效登录退出时也会结束 Telegram 进度卡", async () => {
    let fatalListener: ((error: Error) => void) | undefined;
    const failure = vi.fn(() => Promise.resolve());
    const cancelTask = vi.fn();
    const startTurn = vi.fn(() => Promise.resolve({ turn: { id: "turn-1" } }));
    const appServer = {
      request: vi.fn(() => Promise.resolve({ config: { model: null, model_reasoning_effort: null, service_tier: null } })),
      startThread: vi.fn(() => Promise.resolve({ thread: { id: "thread-1" }, model: null, serviceTier: null })),
      startTurn,
      onNotification: vi.fn(() => () => {}),
      onFatal: vi.fn((listener: (error: Error) => void) => {
        fatalListener = listener;
        return () => {};
      }),
      setServerRequestHandler: vi.fn(() => () => {}),
    } as unknown as AppServerClient;
    const store = {
      getTask: vi.fn(() => task),
      project: vi.fn(() => project),
      codexThreadId: vi.fn(() => null),
      saveThread: vi.fn(),
      bindTask: vi.fn(),
      appendTaskEvent: vi.fn(),
      transitionTask: vi.fn(),
      dangerLeaseActive: vi.fn(() => false),
    } satisfies RuntimeStore;
    const gateway = {
      progress: vi.fn(),
      plan: vi.fn(() => Promise.resolve()),
      tool: vi.fn(() => Promise.resolve()),
      final: vi.fn(() => Promise.resolve()),
      failure,
      artifact: vi.fn(() => Promise.resolve()),
      requestApproval: () => Promise.resolve("decline" as const),
      requestInput: vi.fn(() => Promise.resolve({})),
      cancelTask,
    } satisfies InteractiveGateway;
    const executor = new AppServerTaskExecutor(appServer, store, gateway, pino({ level: "silent" }));
    const execution = executor.execute(task);

    await vi.waitFor(() => {
      expect(startTurn).toHaveBeenCalledOnce();
    });
    fatalListener?.(new Error("HTTP 401 token_invalidated: Please sign in again."));

    await expect(execution).rejects.toThrow("token_invalidated");
    expect(cancelTask).toHaveBeenCalledWith(task.id, "Codex App Server 已退出，任务状态需要人工确认");
    expect(failure).toHaveBeenCalledWith(task, expect.stringContaining("本机 Codex 登录已失效"));
    executor.dispose();
  });
});

describe("App Server Agent 消息阶段", () => {
  it("将 App Server 允许的审批决定原样约束到 Telegram 卡片", async () => {
    let notificationListener: ((notification: ServerNotification) => void) | undefined;
    let approvalHandler: ((request: ServerRequest<CommandApprovalRequest>) => unknown) | undefined;
    const startTurn = vi.fn(() => Promise.resolve({ turn: { id: "turn-1" } }));
    const appServer = {
      request: vi.fn(() => Promise.resolve({ config: { model: null, model_reasoning_effort: null, service_tier: null } })),
      startThread: vi.fn(() => Promise.resolve({ thread: { id: "thread-1" }, model: null, serviceTier: null })),
      startTurn,
      onNotification: vi.fn((listener: (notification: ServerNotification) => void) => {
        notificationListener = listener;
        return () => {};
      }),
      onFatal: vi.fn(() => () => {}),
      setServerRequestHandler: vi.fn((method: string, handler: (request: ServerRequest<CommandApprovalRequest>) => unknown) => {
        if (method === "item/commandExecution/requestApproval") approvalHandler = handler;
        return () => {};
      }),
    } as unknown as AppServerClient;
    const store = {
      getTask: vi.fn(() => task),
      project: vi.fn(() => project),
      codexThreadId: vi.fn(() => null),
      saveThread: vi.fn(),
      bindTask: vi.fn(),
      appendTaskEvent: vi.fn(),
      transitionTask: vi.fn(),
      dangerLeaseActive: vi.fn(() => false),
    } satisfies RuntimeStore;
    const requestApproval = vi.fn(() => Promise.resolve("accept" as const));
    const gateway = {
      progress: vi.fn(),
      plan: vi.fn(() => Promise.resolve()),
      tool: vi.fn(() => Promise.resolve()),
      final: vi.fn(() => Promise.resolve()),
      failure: vi.fn(() => Promise.resolve()),
      artifact: vi.fn(() => Promise.resolve()),
      requestApproval,
      requestInput: vi.fn(() => Promise.resolve({})),
      cancelTask: vi.fn(),
    } satisfies InteractiveGateway;
    const executor = new AppServerTaskExecutor(appServer, store, gateway, pino({ level: "silent" }));
    const execution = executor.execute(task);
    await vi.waitFor(() => {
      expect(startTurn).toHaveBeenCalledOnce();
    });
    if (!approvalHandler) throw new Error("缺少命令审批 handler");

    await expect(approvalHandler({
      id: 8,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
        startedAtMs: Date.now(),
        environmentId: null,
        command: "npm test",
        availableDecisions: ["accept"],
      },
    })).resolves.toEqual({ decision: "accept" });
    expect(requestApproval).toHaveBeenCalledWith(task, expect.objectContaining({ availableDecisions: ["accept"] }));

    notificationListener?.({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
    await execution;
    executor.dispose();
  });

  it("过程消息逐条替换，最终结果只采用 final_answer 权威正文", async () => {
    let notificationListener: ((notification: ServerNotification) => void) | undefined;
    const startTurn = vi.fn(() => Promise.resolve({ turn: { id: "turn-1" } }));
    const appServer = {
      request: vi.fn(() => Promise.resolve({ config: { model: null, model_reasoning_effort: null, service_tier: null } })),
      startThread: vi.fn(() => Promise.resolve({ thread: { id: "thread-1" }, model: null, serviceTier: null })),
      startTurn,
      onNotification: vi.fn((listener: (notification: ServerNotification) => void) => {
        notificationListener = listener;
        return () => {};
      }),
      onFatal: vi.fn(() => () => {}),
      setServerRequestHandler: vi.fn(() => () => {}),
    } as unknown as AppServerClient;
    const store = {
      getTask: vi.fn(() => task),
      project: vi.fn(() => project),
      codexThreadId: vi.fn(() => null),
      saveThread: vi.fn(),
      bindTask: vi.fn(),
      appendTaskEvent: vi.fn(),
      transitionTask: vi.fn(),
      dangerLeaseActive: vi.fn(() => false),
    } satisfies RuntimeStore;
    const progress = vi.fn();
    const final = vi.fn(() => Promise.resolve());
    const gateway = {
      progress,
      plan: vi.fn(() => Promise.resolve()),
      tool: vi.fn(() => Promise.resolve()),
      final,
      failure: vi.fn(() => Promise.resolve()),
      artifact: vi.fn(() => Promise.resolve()),
      requestApproval: () => Promise.resolve("decline" as const),
      requestInput: vi.fn(() => Promise.resolve({})),
      cancelTask: vi.fn(),
    } satisfies InteractiveGateway;
    const executor = new AppServerTaskExecutor(appServer, store, gateway, pino({ level: "silent" }));
    const execution = executor.execute(task);

    await vi.waitFor(() => {
      expect(startTurn).toHaveBeenCalledOnce();
    });
    const emit = (method: string, params: Record<string, unknown>) => {
      notificationListener?.({ method, params });
    };
    const base = { threadId: "thread-1", turnId: "turn-1" };
    emit("item/started", { ...base, item: { id: "comment-1", type: "agentMessage", text: "", phase: "commentary" } });
    emit("item/agentMessage/delta", { ...base, itemId: "comment-1", delta: "过程一" });
    emit("item/completed", { ...base, item: { id: "comment-1", type: "agentMessage", text: "过程一", phase: "commentary" } });
    emit("item/started", { ...base, item: { id: "comment-2", type: "agentMessage", text: "", phase: "commentary" } });
    emit("item/agentMessage/delta", { ...base, itemId: "comment-2", delta: "过程二" });
    emit("item/completed", { ...base, item: { id: "comment-2", type: "agentMessage", text: "过程二", phase: "commentary" } });
    emit("item/started", { ...base, item: { id: "final-1", type: "agentMessage", text: "", phase: "final_answer" } });
    emit("item/agentMessage/delta", { ...base, itemId: "final-1", delta: "最终" });
    emit("item/completed", { ...base, item: { id: "final-1", type: "agentMessage", text: "最终答案", phase: "final_answer" } });
    emit("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });

    await execution;
    const renderedProgress = progress.mock.calls.map((call) => String(call[1]));
    expect(renderedProgress).toContain("过程一");
    expect(renderedProgress).toContain("过程二");
    expect(renderedProgress).not.toContain("过程一过程二");
    expect(final).toHaveBeenCalledWith(task, "最终答案");
    expect(store.appendTaskEvent).toHaveBeenCalledWith(
      task.id,
      expect.any(Number),
      "item/completed",
      expect.objectContaining({ itemId: "final-1", phase: "final_answer" }),
    );
    executor.dispose();
  });
});
