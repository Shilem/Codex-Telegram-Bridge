import type { Logger } from "pino";

import type { AppServerClient } from "../app-server/client.js";
import { isPublicAppServerNotification } from "../app-server/notification-policy.js";
import type {
  CommandApprovalDecision,
  CommandApprovalRequest,
  FileChangeApprovalRequest,
  RequestUserInputParams,
  ServerNotification,
  ServerRequest,
  UserInput,
} from "../app-server/types.js";
import type { PermissionProfile, ProjectRecord, TaskRecord, TaskStatus } from "../core/types.js";
import { BridgeError } from "../core/types.js";
import type { TaskExecutor } from "../scheduler/task-scheduler.js";

export interface RuntimeStore {
  getTask(taskId: string): TaskRecord | null;
  project(projectId: string): ProjectRecord;
  codexThreadId(projectId: string, permission: PermissionProfile): string | null;
  saveThread(projectId: string, codexThreadId: string, permission: PermissionProfile): void;
  bindTask(taskId: string, threadId: string, turnId: string): void;
  appendTaskEvent(taskId: string, sequence: number, eventType: string, payload: unknown): void;
  transitionTask(taskId: string, status: TaskStatus): void;
  dangerLeaseActive(projectId: string): boolean;
}

export type ApprovalChoice = "accept" | "accept_for_session" | "decline" | "cancel";

export interface ApprovalCard {
  requestId: string;
  threadId: string;
  turnId: string;
  itemId: string;
  project: ProjectRecord;
  kind: "command" | "file-change";
  command?: string;
  cwd?: string;
  reason?: string;
  grantRoot?: string;
  expiresAt: number;
}

export interface InteractiveGateway {
  progress(task: TaskRecord, text: string): void;
  plan(task: TaskRecord, summary: string): Promise<void>;
  tool(task: TaskRecord, summary: string): Promise<void>;
  final(task: TaskRecord, text: string): Promise<void>;
  artifact(task: TaskRecord, filePath: string, projectRoot: string): Promise<void>;
  requestApproval(task: TaskRecord, card: ApprovalCard): Promise<ApprovalChoice>;
  requestInput(task: TaskRecord, request: ServerRequest<RequestUserInputParams>): Promise<Record<string, string[]>>;
  cancelTask(taskId: string, reason: string): void;
}

interface ActiveTurn {
  task: TaskRecord;
  project: ProjectRecord;
  threadId: string;
  turnId: string;
  sequence: number;
  finalText: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function sandboxFor(profile: PermissionProfile): "read-only" | "workspace-write" | "danger-full-access" {
  if (profile === "workspace-write + on-request") return "workspace-write";
  return profile;
}

export class AppServerTaskExecutor implements TaskExecutor {
  readonly #activeTurns = new Map<string, ActiveTurn>();
  readonly #earlyNotifications = new Map<string, ServerNotification[]>();
  readonly #unsubscribeNotification: () => void;
  readonly #unsubscribeFatal: () => void;
  readonly #unsubscribeRequests: Array<() => void>;
  #notificationQueue: Promise<void> = Promise.resolve();
  #current: ActiveTurn | null = null;

  public constructor(
    private readonly appServer: AppServerClient,
    private readonly store: RuntimeStore,
    private readonly gateway: InteractiveGateway,
    private readonly logger: Logger,
  ) {
    this.#unsubscribeNotification = appServer.onNotification((notification) => {
      this.#notificationQueue = this.#notificationQueue
        .then(() => this.#handleNotification(notification))
        .catch((error: unknown) => {
          const normalized = error instanceof Error ? error : new Error(String(error));
          const active = this.#current;
          this.logger.error({ error: normalized.message, taskId: active?.task.id }, "处理 App Server 通知失败");
          if (active) this.#failActive(active, normalized);
        });
    });
    this.#unsubscribeFatal = appServer.onFatal((error) => {
      for (const active of [...this.#activeTurns.values()]) {
        const current = this.store.getTask(active.task.id);
        if (current && ["running", "waiting_input", "waiting_approval"].includes(current.status)) {
          this.store.transitionTask(active.task.id, "unknown");
        }
        this.gateway.cancelTask(active.task.id, "Codex App Server 已退出，任务状态需要人工确认");
        this.#failActive(active, error);
      }
    });
    this.#unsubscribeRequests = [appServer.setServerRequestHandler(
      "item/commandExecution/requestApproval",
      (request) => this.#handleCommandApproval(request as ServerRequest<CommandApprovalRequest>),
    ), appServer.setServerRequestHandler(
      "item/fileChange/requestApproval",
      (request) => this.#handleFileApproval(request as ServerRequest<FileChangeApprovalRequest>),
    ), appServer.setServerRequestHandler(
      "item/tool/requestUserInput",
      (request) => this.#handleUserInput(request as ServerRequest<RequestUserInputParams>),
    )];
  }

  public dispose(): void {
    this.#unsubscribeNotification();
    this.#unsubscribeFatal();
    for (const unsubscribe of this.#unsubscribeRequests) unsubscribe();
  }

  public async execute(task: TaskRecord): Promise<void> {
    if (!task.prompt) throw new BridgeError("任务正文已过期或为空，无法执行", "TASK_BODY_MISSING");
    if (this.#current) throw new BridgeError("全局已有 Codex 任务在运行", "GLOBAL_TASK_BUSY");
    const project = this.store.project(task.projectId);
    const profile = project.permissionProfile;
    if (profile === "danger-full-access" && !this.store.dangerLeaseActive(project.id)) {
      throw new BridgeError("当前项目的完全访问授权已过期", "DANGER_LEASE_REQUIRED");
    }
    const existingThreadId = this.store.codexThreadId(project.id, profile);
    const threadResponse = existingThreadId
      ? await this.appServer.resumeThread({
          threadId: existingThreadId,
          cwd: project.rootPath,
          runtimeWorkspaceRoots: [project.rootPath],
          approvalPolicy: profile === "danger-full-access" ? "never" : "on-request",
          sandbox: sandboxFor(profile),
          excludeTurns: true,
        })
      : await this.appServer.startThread({
          cwd: project.rootPath,
          runtimeWorkspaceRoots: [project.rootPath],
          model: project.defaultModel,
          approvalPolicy: profile === "danger-full-access" ? "never" : "on-request",
          sandbox: sandboxFor(profile),
          ephemeral: false,
        });
    const threadId = threadResponse.thread.id;
    if (!existingThreadId) this.store.saveThread(project.id, threadId, profile);
    const input: UserInput[] = [{ type: "text", text: task.prompt, text_elements: [] }];
    const turnResponse = await this.appServer.startTurn({
      threadId,
      input,
      cwd: project.rootPath,
      runtimeWorkspaceRoots: [project.rootPath],
      model: project.defaultModel,
      effort: project.defaultEffort,
      summary: "concise",
    });
    const turnId = turnResponse.turn.id;
    this.store.bindTask(task.id, threadId, turnId);
    await new Promise<void>((resolve, reject) => {
      const active: ActiveTurn = {
        task,
        project,
        threadId,
        turnId,
        sequence: 0,
        finalText: "",
        resolve,
        reject,
      };
      this.#activeTurns.set(`${threadId}:${turnId}`, active);
      this.#current = active;
      const early = this.#earlyNotifications.get(`${threadId}:${turnId}`) ?? [];
      this.#earlyNotifications.delete(`${threadId}:${turnId}`);
      for (const notification of early) {
        this.#notificationQueue = this.#notificationQueue.then(() => this.#handleNotification(notification));
      }
    });
  }

  public async cancel(task: TaskRecord): Promise<void> {
    const active = this.#current;
    if (!active || active.task.id !== task.id) return;
    this.gateway.cancelTask(task.id, "任务已取消");
    await this.appServer.interruptTurn({ threadId: active.threadId, turnId: active.turnId });
  }

  async #handleNotification(notification: ServerNotification): Promise<void> {
    if (!isPublicAppServerNotification(notification)) return;
    const params = objectValue(notification.params);
    if (!params) return;
    const threadId = stringValue(params.threadId);
    const turn = objectValue(params.turn);
    const turnId = stringValue(params.turnId) ?? stringValue(turn?.id);
    if (!threadId || !turnId) return;
    const active = this.#activeTurns.get(`${threadId}:${turnId}`);
    if (!active) {
      const key = `${threadId}:${turnId}`;
      const buffered = this.#earlyNotifications.get(key) ?? [];
      if (buffered.length < 100) buffered.push(notification);
      this.#earlyNotifications.set(key, buffered);
      return;
    }
    active.sequence += 1;
    this.store.appendTaskEvent(active.task.id, active.sequence, notification.method, {
      method: notification.method,
      itemType: stringValue(objectValue(params.item)?.type),
      status: stringValue(objectValue(params.turn)?.status) ?? stringValue(params.status),
    });
    switch (notification.method) {
      case "item/agentMessage/delta": {
        const delta = stringValue(params.delta);
        if (delta) {
          active.finalText += delta;
          this.gateway.progress(active.task, active.finalText);
        }
        break;
      }
      case "turn/plan/updated": {
        const explanation = stringValue(params.explanation) ?? "计划已更新";
        await this.gateway.plan(active.task, explanation);
        break;
      }
      case "item/started":
      case "item/completed": {
        const item = objectValue(params.item);
        const itemType = item ? stringValue(item.type) : null;
        if (itemType === "agentMessage") {
          const authoritativeText = item ? stringValue(item.text) : null;
          const phase = item ? stringValue(item.phase) : null;
          if (authoritativeText && phase !== "commentary") active.finalText = authoritativeText;
        }
        if (itemType === "imageGeneration") {
          const savedPath = item ? stringValue(item.savedPath) : null;
          if (savedPath) await this.gateway.artifact(active.task, savedPath, active.project.rootPath);
        }
        if (itemType && itemType !== "agentMessage" && itemType !== "reasoning") {
          await this.gateway.tool(active.task, `${notification.method === "item/started" ? "开始" : "完成"}：${itemType}`);
        }
        break;
      }
      case "turn/completed": {
        const completedTurn = objectValue(params.turn);
        const status = stringValue(completedTurn?.status);
        if (status === "completed") {
          try {
            await this.gateway.final(active.task, active.finalText || "任务已完成，但没有可公开的文本结果。");
          } finally {
            this.#finishActive(active);
          }
        } else {
          const turnError = objectValue(completedTurn?.error);
          const message = stringValue(turnError?.message) ?? (status === "interrupted" ? "任务已被中断" : "Codex turn 执行失败");
          this.#failActive(active, new BridgeError(message, status === "interrupted" ? "TASK_INTERRUPTED" : "APP_SERVER_TURN_FAILED"));
        }
        break;
      }
      case "error": {
        if (params.willRetry === true) {
          this.gateway.progress(active.task, "Codex 遇到暂时错误，正在重试……");
          break;
        }
        const error = objectValue(params.error);
        const message = stringValue(error?.message) ?? stringValue(params.message) ?? "Codex App Server 返回错误";
        this.#failActive(active, new BridgeError(message, "APP_SERVER_TURN_ERROR"));
        break;
      }
    }
  }

  async #handleCommandApproval(request: ServerRequest<CommandApprovalRequest>): Promise<{ decision: CommandApprovalDecision }> {
    const active = await this.#waitForActive(request.params.threadId, request.params.turnId);
    this.store.transitionTask(active.task.id, "waiting_approval");
    try {
      const choice = await this.gateway.requestApproval(active.task, {
        requestId: String(request.id),
        threadId: request.params.threadId,
        turnId: request.params.turnId,
        itemId: request.params.itemId,
        project: active.project,
        kind: "command",
        ...(request.params.command ? { command: request.params.command } : {}),
        ...(request.params.cwd ? { cwd: request.params.cwd } : {}),
        ...(request.params.reason ? { reason: request.params.reason } : {}),
        expiresAt: Date.now() + 10 * 60_000,
      });
      const decision = choice === "accept_for_session" ? "acceptForSession" : choice;
      const available = request.params.availableDecisions;
      if (available && !available.includes(decision)) {
        throw new BridgeError("所选审批决定不在 App Server 允许范围内", "APPROVAL_DECISION_NOT_AVAILABLE");
      }
      return { decision };
    } finally {
      this.#resumeWaitingTask(active.task.id, "waiting_approval");
    }
  }

  async #handleFileApproval(request: ServerRequest<FileChangeApprovalRequest>): Promise<{ decision: CommandApprovalDecision }> {
    const active = await this.#waitForActive(request.params.threadId, request.params.turnId);
    this.store.transitionTask(active.task.id, "waiting_approval");
    try {
      const choice = await this.gateway.requestApproval(active.task, {
        requestId: String(request.id),
        threadId: request.params.threadId,
        turnId: request.params.turnId,
        itemId: request.params.itemId,
        project: active.project,
        kind: "file-change",
        ...(request.params.reason ? { reason: request.params.reason } : {}),
        ...(request.params.grantRoot ? { grantRoot: request.params.grantRoot } : {}),
        expiresAt: Date.now() + 10 * 60_000,
      });
      return { decision: choice === "accept_for_session" ? "acceptForSession" : choice };
    } finally {
      this.#resumeWaitingTask(active.task.id, "waiting_approval");
    }
  }

  async #handleUserInput(request: ServerRequest<RequestUserInputParams>): Promise<{ answers: Record<string, { answers: string[] }> }> {
    const active = await this.#waitForActive(request.params.threadId, request.params.turnId);
    this.store.transitionTask(active.task.id, "waiting_input");
    try {
      const answers = await this.gateway.requestInput(active.task, request);
      return { answers: Object.fromEntries(Object.entries(answers).map(([id, values]) => [id, { answers: values }])) };
    } finally {
      this.#resumeWaitingTask(active.task.id, "waiting_input");
    }
  }

  #requireActive(threadId: string, turnId: string): ActiveTurn {
    const active = this.#activeTurns.get(`${threadId}:${turnId}`);
    if (!active) throw new BridgeError("审批或提问不属于当前任务", "REQUEST_TURN_MISMATCH");
    return active;
  }

  async #waitForActive(threadId: string, turnId: string): Promise<ActiveTurn> {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const active = this.#activeTurns.get(`${threadId}:${turnId}`);
      if (active) return active;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    return this.#requireActive(threadId, turnId);
  }

  #finishActive(active: ActiveTurn): void {
    this.#activeTurns.delete(`${active.threadId}:${active.turnId}`);
    if (this.#current === active) this.#current = null;
    active.resolve();
  }

  #failActive(active: ActiveTurn, error: Error): void {
    this.logger.error({ taskId: active.task.id, error: error.message }, "App Server turn 失败");
    this.#activeTurns.delete(`${active.threadId}:${active.turnId}`);
    if (this.#current === active) this.#current = null;
    active.reject(error);
  }

  #resumeWaitingTask(taskId: string, expected: TaskStatus): void {
    const current = this.store.getTask(taskId);
    if (current?.status === expected) this.store.transitionTask(taskId, "running");
  }
}
