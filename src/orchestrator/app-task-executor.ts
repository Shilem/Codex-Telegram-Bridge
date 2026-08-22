import type { Logger } from "pino";

import { AppServerRpcError, type AppServerClient } from "../app-server/client.js";
import { isPublicAppServerNotification } from "../app-server/notification-policy.js";
import type {
  CommandApprovalDecision,
  CommandApprovalRequest,
  CollaborationMode,
  CollaborationModeListResponse,
  ConfigReadResponse,
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
  saveThread(projectId: string, codexThreadId: string, permission: PermissionProfile, replacedCodexThreadId?: string): void;
  bindTask(taskId: string, threadId: string, turnId: string): void;
  appendTaskEvent(taskId: string, sequence: number, eventType: string, payload: unknown): void;
  transitionTask(taskId: string, status: TaskStatus): void;
  dangerLeaseActive(projectId: string): boolean;
  disarmPlanMode(projectId: string): void;
}

export type ApprovalChoice = "accept" | "accept_for_session" | "decline" | "cancel";

export interface ToolActivity {
  itemId: string;
  itemType: string;
  status: "started" | "completed";
}

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
  availableDecisions: readonly ApprovalChoice[];
  expiresAt: number;
}

export interface InteractiveGateway {
  progress(task: TaskRecord, text: string): void;
  plan(task: TaskRecord, summary: string): Promise<void>;
  tool(task: TaskRecord, activity: ToolActivity): Promise<void>;
  final(task: TaskRecord, text: string): Promise<void>;
  planReady(task: TaskRecord, text: string, context: { threadId: string; turnId: string; itemId: string }): Promise<void>;
  failure(task: TaskRecord, text: string): Promise<void>;
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
  agentMessages: Map<string, { phase: string | null; text: string }>;
  planDrafts: Map<string, string>;
  latestAgentMessageId: string | null;
  latestPlanItemId: string | null;
  finalPlanText: string;
  finalPlanItemId: string | null;
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

function renderPlanUpdate(params: Record<string, unknown>): string {
  const explanation = stringValue(params.explanation);
  const steps = Array.isArray(params.plan)
    ? params.plan.flatMap((candidate) => {
        const step = objectValue(candidate);
        const text = stringValue(step?.step);
        const status = stringValue(step?.status);
        if (!text) return [];
        const marker = status === "completed" ? "✓" : status === "inProgress" ? "→" : "○";
        return [`${marker} ${text}`];
      })
    : [];
  return [explanation, ...steps].filter((value): value is string => Boolean(value)).join("\n") || "计划已更新";
}

function sandboxFor(profile: PermissionProfile): "read-only" | "workspace-write" | "danger-full-access" {
  if (profile === "workspace-write + on-request") return "workspace-write";
  return profile;
}

function isArchivedThreadError(error: unknown): error is AppServerRpcError {
  return error instanceof AppServerRpcError
    && error.code === -32600
    && /\bsession\s+\S+\s+is archived\b/i.test(error.message);
}

function renderTaskFailure(error: Error): string {
  if (/token_invalidated|authentication token has been invalidated|access token could not be refreshed|please sign in again|\b401\b/i.test(error.message)) {
    return [
      "原因：本机 Codex 登录已失效或已切换账号。",
      "影响：本次任务未执行完成。",
      "下一步：请在此 Mac 的 Codex 或 ChatGPT 中重新登录；Bridge 重启后重新发送任务。",
    ].join("\n");
  }
  return [
    `原因：${error.message.slice(0, 1_200)}`,
    "影响：本次任务未执行完成。",
    "下一步：运行 /health 检查本机服务，处理后重新发送任务。",
  ].join("\n");
}

export class AppServerTaskExecutor implements TaskExecutor {
  readonly #activeTurns = new Map<string, ActiveTurn>();
  readonly #earlyNotifications = new Map<string, ServerNotification[]>();
  readonly #unsubscribeNotification: () => void;
  readonly #unsubscribeFatal: () => void;
  readonly #unsubscribeRequests: Array<() => void>;
  #notificationQueue: Promise<void> = Promise.resolve();
  #collaborationModes: Promise<CollaborationModeListResponse> | null = null;
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
    try {
      if (!task.prompt) throw new BridgeError("任务正文已过期或为空，无法执行", "TASK_BODY_MISSING");
      if (this.#current) throw new BridgeError("全局已有 Codex 任务在运行", "GLOBAL_TASK_BUSY");
      const project = this.store.project(task.projectId);
      const localConfig = await this.appServer.request<ConfigReadResponse>("config/read", {
        includeLayers: false,
        cwd: project.rootPath,
      });
      const effectiveModel = project.defaultModel ?? localConfig.config.model;
      const effectiveEffort = project.defaultEffort ?? localConfig.config.model_reasoning_effort;
      const effectiveServiceTier = project.serviceTier ?? localConfig.config.service_tier ?? "default";
      const profile = project.permissionProfile;
      if (profile === "danger-full-access" && !this.store.dangerLeaseActive(project.id)) {
        throw new BridgeError("当前项目的完全访问授权已过期", "DANGER_LEASE_REQUIRED");
      }
      const existingThreadId = this.store.codexThreadId(project.id, profile);
      let replacedArchivedThread = false;
      let threadResponse;
      if (existingThreadId) {
        try {
          threadResponse = await this.appServer.resumeThread({
            threadId: existingThreadId,
            cwd: project.rootPath,
            runtimeWorkspaceRoots: [project.rootPath],
            serviceTier: project.serviceTier,
            approvalPolicy: profile === "danger-full-access" ? "never" : "on-request",
            sandbox: sandboxFor(profile),
            excludeTurns: true,
          });
        } catch (error) {
          if (!isArchivedThreadError(error)) throw error;
          replacedArchivedThread = true;
          this.logger.warn({ taskId: task.id, projectId: project.id, threadId: existingThreadId }, "存储的 Codex 会话已归档，将创建替代会话");
        }
      }
      if (!threadResponse) {
        threadResponse = await this.appServer.startThread({
            cwd: project.rootPath,
            runtimeWorkspaceRoots: [project.rootPath],
            model: project.defaultModel,
            serviceTier: project.serviceTier,
            approvalPolicy: profile === "danger-full-access" ? "never" : "on-request",
            sandbox: sandboxFor(profile),
            ephemeral: false,
          });
      }
      const threadId = threadResponse.thread.id;
      const collaborationMode = await this.#resolveCollaborationMode(
        task.collaborationMode,
        threadResponse.model || effectiveModel,
        effectiveEffort,
      );
      this.logger.info({
        taskId: task.id,
        projectId: project.id,
        model: threadResponse.model,
        modelSource: project.defaultModel ? "project" : "local",
        reasoningEffort: effectiveEffort,
        reasoningEffortSource: project.defaultEffort ? "project" : "local",
        serviceTier: threadResponse.serviceTier ?? effectiveServiceTier,
        serviceTierSource: project.serviceTier ? "project" : "local",
        collaborationMode: collaborationMode.mode,
      }, "Codex 任务运行配置已解析");
      this.gateway.progress(
        task,
        `运行配置：${threadResponse.model || effectiveModel || "未设置"} · ${effectiveEffort ?? "模型默认"} · ${threadResponse.serviceTier ?? effectiveServiceTier} · ${collaborationMode.mode === "plan" ? "Plan" : "Default"}`,
      );
      if (!existingThreadId || replacedArchivedThread) {
        this.store.saveThread(project.id, threadId, profile, replacedArchivedThread ? existingThreadId ?? undefined : undefined);
      }
      const input: UserInput[] = [{ type: "text", text: task.prompt, text_elements: [] }];
      const turnResponse = await this.appServer.startTurn({
        threadId,
        input,
        cwd: project.rootPath,
        runtimeWorkspaceRoots: [project.rootPath],
        model: project.defaultModel,
        serviceTier: project.serviceTier,
        effort: project.defaultEffort,
        summary: "concise",
        collaborationMode,
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
          agentMessages: new Map(),
          planDrafts: new Map(),
          latestAgentMessageId: null,
          latestPlanItemId: null,
          finalPlanText: "",
          finalPlanItemId: null,
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
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (this.store.getTask(task.id)?.status !== "cancelled") await this.#notifyFailure(task, normalized);
      throw normalized;
    }
  }

  public async cancel(task: TaskRecord): Promise<void> {
    const active = this.#current;
    if (!active || active.task.id !== task.id) return;
    this.gateway.cancelTask(task.id, "任务已取消");
    await this.appServer.interruptTurn({ threadId: active.threadId, turnId: active.turnId });
  }

  async #resolveCollaborationMode(
    mode: TaskRecord["collaborationMode"],
    effectiveModel: string | null,
    effectiveEffort: string | null,
  ): Promise<CollaborationMode> {
    this.#collaborationModes ??= this.appServer.request<CollaborationModeListResponse>("collaborationMode/list", {});
    const response = await this.#collaborationModes;
    const preset = response.data.find((candidate) => candidate.mode === mode);
    if (!preset) throw new BridgeError(`Codex App Server 不支持 ${mode} 协作模式`, "COLLABORATION_MODE_UNAVAILABLE");
    const model = preset.model ?? effectiveModel;
    if (!model) throw new BridgeError("Codex 协作模式缺少可用模型", "COLLABORATION_MODE_MODEL_MISSING");
    return {
      mode,
      settings: {
        model,
        reasoning_effort: preset.reasoning_effort ?? effectiveEffort,
        developer_instructions: null,
      },
    };
  }

  async #handleNotification(notification: ServerNotification): Promise<void> {
    if (!isPublicAppServerNotification(notification)) return;
    const params = objectValue(notification.params);
    if (!params) return;
    const threadId = stringValue(params.threadId);
    const turn = objectValue(params.turn);
    const turnId = stringValue(params.turnId) ?? stringValue(turn?.id);
    if (!turnId) return;
    const active = threadId
      ? this.#activeTurns.get(`${threadId}:${turnId}`)
      : [...this.#activeTurns.values()].find((candidate) => candidate.turnId === turnId);
    if (!active) {
      if (!threadId) return;
      const key = `${threadId}:${turnId}`;
      const buffered = this.#earlyNotifications.get(key) ?? [];
      if (buffered.length < 100) buffered.push(notification);
      this.#earlyNotifications.set(key, buffered);
      return;
    }
    active.sequence += 1;
    const notificationItem = objectValue(params.item);
    this.store.appendTaskEvent(active.task.id, active.sequence, notification.method, {
      method: notification.method,
      itemId: stringValue(notificationItem?.id) ?? stringValue(params.itemId),
      itemType: stringValue(notificationItem?.type),
      phase: stringValue(notificationItem?.phase),
      status: stringValue(objectValue(params.turn)?.status) ?? stringValue(params.status),
    });
    switch (notification.method) {
      case "item/agentMessage/delta": {
        const delta = stringValue(params.delta);
        if (!delta) break;
        const itemId = stringValue(params.itemId) ?? active.latestAgentMessageId;
        if (!itemId) {
          this.logger.warn({ taskId: active.task.id, threadId, turnId }, "Agent 消息增量缺少 itemId，等待权威完成事件");
          break;
        }
        let message = active.agentMessages.get(itemId);
        if (!message) {
          message = { phase: null, text: "" };
          active.agentMessages.set(itemId, message);
          this.logger.warn({ taskId: active.task.id, threadId, turnId, itemId }, "Agent 消息增量早于开始事件");
        }
        message.text += delta;
        this.gateway.progress(active.task, message.text);
        break;
      }
      case "item/plan/delta": {
        const delta = stringValue(params.delta);
        if (!delta) break;
        const itemId = stringValue(params.itemId) ?? active.latestPlanItemId;
        if (!itemId) {
          this.logger.warn({ taskId: active.task.id, threadId, turnId }, "Plan 增量缺少 itemId，等待权威完成事件");
          break;
        }
        const text = (active.planDrafts.get(itemId) ?? "") + delta;
        active.planDrafts.set(itemId, text);
        await this.gateway.plan(active.task, text);
        break;
      }
      case "turn/plan/updated": {
        await this.gateway.plan(active.task, renderPlanUpdate(params));
        break;
      }
      case "item/started":
      case "item/completed": {
        const item = objectValue(params.item);
        const itemType = item ? stringValue(item.type) : null;
        if (itemType === "agentMessage") {
          const itemId = item ? stringValue(item.id) : null;
          const authoritativeText = item ? stringValue(item.text) : null;
          const phase = item ? stringValue(item.phase) : null;
          if (!itemId) {
            this.logger.warn({ taskId: active.task.id, threadId, turnId, phase }, "Agent 消息生命周期事件缺少 itemId");
          } else if (notification.method === "item/started") {
            active.agentMessages.set(itemId, { phase, text: authoritativeText ?? "" });
            active.latestAgentMessageId = itemId;
          } else {
            const message = active.agentMessages.get(itemId) ?? { phase, text: "" };
            message.phase = phase ?? message.phase;
            if (authoritativeText !== null) message.text = authoritativeText;
            active.agentMessages.set(itemId, message);
            if (message.phase === "commentary") {
              if (message.text) this.gateway.progress(active.task, message.text);
            } else if (message.text) {
              active.finalText = message.text;
            }
            if (active.latestAgentMessageId === itemId) active.latestAgentMessageId = null;
          }
        }
        if (itemType === "plan") {
          const itemId = item ? stringValue(item.id) : null;
          const authoritativeText = item ? stringValue(item.text) : null;
          if (!itemId) {
            this.logger.warn({ taskId: active.task.id, threadId, turnId }, "Plan 生命周期事件缺少 itemId");
          } else if (notification.method === "item/started") {
            active.planDrafts.set(itemId, authoritativeText ?? "");
            active.latestPlanItemId = itemId;
          } else {
            const text = authoritativeText ?? active.planDrafts.get(itemId) ?? "";
            active.planDrafts.set(itemId, text);
            active.finalPlanItemId = itemId;
            active.finalPlanText = text;
            if (active.latestPlanItemId === itemId) active.latestPlanItemId = null;
          }
        }
        if (itemType === "imageGeneration") {
          const savedPath = item ? stringValue(item.savedPath) : null;
          if (savedPath) await this.gateway.artifact(active.task, savedPath, active.project.rootPath);
        }
        if (itemType && itemType !== "agentMessage" && itemType !== "reasoning" && itemType !== "plan") {
          const itemId = item ? stringValue(item.id) : null;
          if (itemId) {
            await this.gateway.tool(active.task, {
              itemId,
              itemType,
              status: notification.method === "item/started" ? "started" : "completed",
            });
          }
        }
        break;
      }
      case "turn/completed": {
        const completedTurn = objectValue(params.turn);
        const status = stringValue(completedTurn?.status);
        if (status === "completed") {
          try {
            if (active.task.collaborationMode === "plan") {
              if (!active.finalPlanText || !active.finalPlanItemId) {
                this.#failActive(active, new BridgeError("Plan 模式已结束，但 Codex 未返回权威 plan item", "PLAN_ITEM_MISSING"));
                break;
              }
              await this.gateway.planReady(active.task, active.finalPlanText, {
                threadId: active.threadId,
                turnId,
                itemId: active.finalPlanItemId,
              });
              this.store.disarmPlanMode(active.task.projectId);
            } else {
              await this.gateway.final(active.task, active.finalText || "任务已完成，但没有可公开的文本结果。");
            }
            this.#finishActive(active);
          } catch (error) {
            this.#failActive(active, error instanceof Error ? error : new Error(String(error)));
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
      const rawDecisions = request.params.availableDecisions ?? ["accept", "acceptForSession", "decline", "cancel"];
      const availableDecisions = rawDecisions.flatMap((decision): ApprovalChoice[] => {
        if (decision === "acceptForSession") return ["accept_for_session"];
        if (decision === "accept" || decision === "decline" || decision === "cancel") return [decision];
        this.logger.warn({ taskId: active.task.id, decisionType: typeof decision }, "App Server 提供了 Telegram 尚不支持的审批决定");
        return [];
      });
      if (availableDecisions.length === 0) {
        throw new BridgeError("App Server 未提供可执行的审批决定", "APPROVAL_DECISIONS_EMPTY");
      }
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
        availableDecisions,
        expiresAt: Date.now() + 10 * 60_000,
      });
      const decision = choice === "accept_for_session" ? "acceptForSession" : choice;
      if (!availableDecisions.includes(choice)) {
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
        availableDecisions: ["accept", "accept_for_session", "decline", "cancel"],
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

  async #notifyFailure(task: TaskRecord, error: Error): Promise<void> {
    try {
      await this.gateway.failure(task, renderTaskFailure(error));
    } catch (notificationError) {
      const normalized = notificationError instanceof Error ? notificationError : new Error(String(notificationError));
      this.logger.error({ taskId: task.id, error: normalized.message, originalError: error.message }, "发送 Telegram 任务失败提示失败");
    }
  }

  #resumeWaitingTask(taskId: string, expected: TaskStatus): void {
    const current = this.store.getTask(taskId);
    if (current?.status === expected) this.store.transitionTask(taskId, "running");
  }
}
