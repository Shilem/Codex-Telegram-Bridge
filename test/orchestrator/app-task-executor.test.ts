import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { AppServerRpcError, type AppServerClient } from "../../src/app-server/client.js";
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
  collaborationMode: "default",
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

function appServerRequest(method: string): Promise<unknown> {
  if (method === "config/read") {
    return Promise.resolve({ config: { model: "gpt-test", model_reasoning_effort: "low", service_tier: null } });
  }
  if (method === "collaborationMode/list") {
    return Promise.resolve({
      data: [
        { name: "Plan", mode: "plan", model: null, reasoning_effort: "medium" },
        { name: "Default", mode: "default", model: null, reasoning_effort: null },
      ],
    });
  }
  return Promise.reject(new Error(`未处理的测试请求：${method}`));
}

describe("App Server 任务失败反馈", () => {
  it("当前会话已归档时创建替代会话并继续任务", async () => {
    let notificationListener: ((notification: ServerNotification) => void) | undefined;
    const startTurn = vi.fn(() => Promise.resolve({ turn: { id: "turn-replacement" } }));
    const appServer = {
      request: vi.fn(appServerRequest),
      resumeThread: vi.fn(() => Promise.reject(new AppServerRpcError({
        code: -32600,
        message: "session archived-thread is archived. Run `codex unarchive archived-thread` to unarchive it first.",
      }))),
      startThread: vi.fn(() => Promise.resolve({ thread: { id: "replacement-thread" }, model: "gpt-test", serviceTier: null })),
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
      codexThreadId: vi.fn(() => "archived-thread"),
      saveThread: vi.fn(),
      bindTask: vi.fn(),
      appendTaskEvent: vi.fn(),
      transitionTask: vi.fn(),
      dangerLeaseActive: vi.fn(() => false),
      disarmPlanMode: vi.fn(),
    } satisfies RuntimeStore;
    const gateway = {
      progress: vi.fn(),
      plan: vi.fn(() => Promise.resolve()),
      tool: vi.fn(() => Promise.resolve()),
      final: vi.fn(() => Promise.resolve()),
      planReady: vi.fn(() => Promise.resolve()),
      failure: vi.fn(() => Promise.resolve()),
      artifact: vi.fn(() => Promise.resolve()),
      requestApproval: () => Promise.resolve("decline" as const),
      requestInput: vi.fn(() => Promise.resolve({})),
      cancelTask: vi.fn(),
    } satisfies InteractiveGateway;
    const executor = new AppServerTaskExecutor(appServer, store, gateway, pino({ level: "silent" }));
    const execution = executor.execute(task);

    await vi.waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({ threadId: "replacement-thread" }));
    });
    notificationListener?.({
      method: "turn/completed",
      params: { threadId: "replacement-thread", turn: { id: "turn-replacement", status: "completed" } },
    });

    await execution;
    expect(store.saveThread).toHaveBeenCalledWith(project.id, "replacement-thread", project.permissionProfile, "archived-thread");
    executor.dispose();
  });

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
      disarmPlanMode: vi.fn(),
    } satisfies RuntimeStore;
    const gateway = {
      progress: vi.fn(),
      plan: vi.fn(() => Promise.resolve()),
      tool: vi.fn(() => Promise.resolve()),
      final: vi.fn(() => Promise.resolve()),
      planReady: vi.fn(() => Promise.resolve()),
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
      request: vi.fn(appServerRequest),
      startThread: vi.fn(() => Promise.resolve({ thread: { id: "thread-1" }, model: "gpt-test", serviceTier: null })),
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
      disarmPlanMode: vi.fn(),
    } satisfies RuntimeStore;
    const gateway = {
      progress: vi.fn(),
      plan: vi.fn(() => Promise.resolve()),
      tool: vi.fn(() => Promise.resolve()),
      final: vi.fn(() => Promise.resolve()),
      planReady: vi.fn(() => Promise.resolve()),
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
      request: vi.fn(appServerRequest),
      startThread: vi.fn(() => Promise.resolve({ thread: { id: "thread-1" }, model: "gpt-test", serviceTier: null })),
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
      disarmPlanMode: vi.fn(),
    } satisfies RuntimeStore;
    const requestApproval = vi.fn(() => Promise.resolve("accept" as const));
    const gateway = {
      progress: vi.fn(),
      plan: vi.fn(() => Promise.resolve()),
      tool: vi.fn(() => Promise.resolve()),
      final: vi.fn(() => Promise.resolve()),
      planReady: vi.fn(() => Promise.resolve()),
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
      request: vi.fn(appServerRequest),
      startThread: vi.fn(() => Promise.resolve({ thread: { id: "thread-1" }, model: "gpt-test", serviceTier: null })),
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
      disarmPlanMode: vi.fn(),
    } satisfies RuntimeStore;
    const progress = vi.fn();
    const final = vi.fn(() => Promise.resolve());
    const gateway = {
      progress,
      plan: vi.fn(() => Promise.resolve()),
      tool: vi.fn(() => Promise.resolve()),
      final,
      planReady: vi.fn(() => Promise.resolve()),
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

  it("Plan 任务使用官方 collaborationMode 并以完成的 plan item 生成操作卡", async () => {
    const planTask: TaskRecord = { ...task, id: "task-plan", collaborationMode: "plan", prompt: "设计实现方案" };
    let notificationListener: ((notification: ServerNotification) => void) | undefined;
    const startTurn = vi.fn(() => Promise.resolve({ turn: { id: "turn-plan" } }));
    const appServer = {
      request: vi.fn(appServerRequest),
      startThread: vi.fn(() => Promise.resolve({ thread: { id: "thread-plan" }, model: "gpt-test", serviceTier: null })),
      startTurn,
      onNotification: vi.fn((listener: (notification: ServerNotification) => void) => {
        notificationListener = listener;
        return () => {};
      }),
      onFatal: vi.fn(() => () => {}),
      setServerRequestHandler: vi.fn(() => () => {}),
    } as unknown as AppServerClient;
    const disarmPlanMode = vi.fn();
    const store = {
      getTask: vi.fn(() => planTask),
      project: vi.fn(() => project),
      codexThreadId: vi.fn(() => null),
      saveThread: vi.fn(),
      bindTask: vi.fn(),
      appendTaskEvent: vi.fn(),
      transitionTask: vi.fn(),
      dangerLeaseActive: vi.fn(() => false),
      disarmPlanMode,
    } satisfies RuntimeStore;
    const plan = vi.fn(() => Promise.resolve());
    const planReady = vi.fn(() => Promise.resolve());
    const final = vi.fn(() => Promise.resolve());
    const gateway = {
      progress: vi.fn(),
      plan,
      tool: vi.fn(() => Promise.resolve()),
      final,
      planReady,
      failure: vi.fn(() => Promise.resolve()),
      artifact: vi.fn(() => Promise.resolve()),
      requestApproval: () => Promise.resolve("decline" as const),
      requestInput: vi.fn(() => Promise.resolve({})),
      cancelTask: vi.fn(),
    } satisfies InteractiveGateway;
    const executor = new AppServerTaskExecutor(appServer, store, gateway, pino({ level: "silent" }));
    const execution = executor.execute(planTask);
    await vi.waitFor(() => {
      expect(startTurn).toHaveBeenCalledOnce();
    });

    expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-test",
          reasoning_effort: "medium",
          developer_instructions: null,
        },
      },
    }));
    const emit = (method: string, params: Record<string, unknown>) => {
      notificationListener?.({ method, params });
    };
    const base = { threadId: "thread-plan", turnId: "turn-plan" };
    emit("turn/plan/updated", {
      turnId: "turn-plan",
      explanation: "准备实施",
      plan: [{ step: "检查代码", status: "inProgress" }, { step: "补充测试", status: "pending" }],
    });
    emit("item/started", { ...base, item: { id: "plan-1", type: "plan", text: "" } });
    emit("item/plan/delta", { ...base, itemId: "plan-1", delta: "草稿计划" });
    emit("item/completed", { ...base, item: { id: "plan-1", type: "plan", text: "最终权威计划" } });
    emit("turn/completed", { threadId: "thread-plan", turn: { id: "turn-plan", status: "completed" } });

    await execution;
    expect(plan).toHaveBeenCalledWith(planTask, "准备实施\n→ 检查代码\n○ 补充测试");
    expect(plan).toHaveBeenCalledWith(planTask, "草稿计划");
    expect(planReady).toHaveBeenCalledWith(planTask, "最终权威计划", {
      threadId: "thread-plan",
      turnId: "turn-plan",
      itemId: "plan-1",
    });
    expect(disarmPlanMode).toHaveBeenCalledWith(project.id);
    expect(final).not.toHaveBeenCalled();
    executor.dispose();
  });
});
