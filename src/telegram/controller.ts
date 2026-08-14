import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type { BridgeConfig } from "../core/config.js";
import { BridgeError, errorMessage } from "../core/types.js";
import type { AvailableModel } from "../app-server/types.js";
import type { MediaManager } from "../media/manager.js";
import type { TaskScheduler } from "../scheduler/task-scheduler.js";
import type {
  ApprovalManager,
  AuditLog,
  PairingService,
  PermissionLeaseManager,
  ProjectRegistry,
} from "../security/index.js";
import { shortProjectId } from "../security/projects.js";
import type { BridgeDatabase, TaskLedger } from "../storage/index.js";
import { cleanupDatabase } from "../runtime/maintenance.js";
import { RuntimeSettings } from "../runtime/settings.js";
import type { TelegramApi } from "./api.js";
import { commandName, escapeHtml } from "./format.js";
import { renderCommandHelp } from "./commands.js";
import type { TelegramInteractiveGateway } from "./gateway.js";
import type { InlineKeyboardMarkup, TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from "./types.js";

export interface HealthProvider {
  render(): Promise<string>;
}

export interface QuotaProvider {
  render(): Promise<string>;
}

export interface UpdateProvider {
  check(): Promise<{ version: string }>;
  install(expectedVersion: string): Promise<void>;
}

export interface ModelProvider {
  list(): Promise<AvailableModel[]>;
  localState(cwd: string): Promise<{
    model: string | null;
    reasoningEffort: string | null;
    serviceTier: string | null;
  }>;
}

export class TelegramController {
  readonly #settings: RuntimeSettings;
  readonly #attachmentWindows = new Map<number, number[]>();

  public constructor(
    private readonly api: TelegramApi,
    private readonly database: BridgeDatabase,
    private readonly tasks: TaskLedger,
    private readonly pairing: PairingService,
    private readonly projects: ProjectRegistry,
    private readonly leases: PermissionLeaseManager,
    private readonly approvals: ApprovalManager,
    private readonly audit: AuditLog,
    private readonly scheduler: TaskScheduler,
    private readonly media: MediaManager,
    private readonly gateway: TelegramInteractiveGateway,
    private readonly health: HealthProvider,
    private readonly quota: QuotaProvider,
    private readonly models: ModelProvider,
    private readonly updates: UpdateProvider | null,
    private readonly config: BridgeConfig,
    private readonly logger: Logger,
  ) {
    this.#settings = new RuntimeSettings(database);
  }

  public async handle(update: TelegramUpdate): Promise<string> {
    const duplicate = this.database.connection
      .prepare("SELECT 1 FROM telegram_updates WHERE update_id = ?")
      .get(update.update_id);
    if (duplicate) return "duplicate";
    try {
      if (update.callback_query) return await this.#handleCallback(update.update_id, update.callback_query);
      if (update.message) return await this.#handleMessage(update.update_id, update.message);
      this.tasks.recordNonTaskUpdate(update.update_id, "committed", "unsupported_update");
      return "unsupported_update";
    } catch (error) {
      this.tasks.recordNonTaskUpdate(
        update.update_id,
        "committed",
        error instanceof BridgeError ? error.code : "UNEXPECTED_ERROR",
      );
      const message = update.message ?? update.callback_query?.message;
      const actor = update.message?.from ?? update.callback_query?.from;
      if (actor) {
        this.audit.record({
          eventType: "update_rejected",
          outcome: "failed",
          actorId: String(actor.id),
          metadata: { errorCode: error instanceof BridgeError ? error.code : "UNEXPECTED" },
        });
      }
      if (message?.chat.type === "private") {
        const safeReason = error instanceof Error ? error.message : "未知错误";
        await this.api.sendMessage(
          message.chat.id,
          `<b>操作失败</b>\n原因：${escapeHtml(safeReason)}\n影响：本次操作未执行。\n下一步：检查参数后重试，或运行 <code>/health</code>。`,
        ).catch((sendError: unknown) => {
          this.logger.error({ updateId: update.update_id, error: errorMessage(sendError) }, "发送错误提示失败");
        });
      }
      throw error;
    }
  }

  async #handleMessage(updateId: number, message: TelegramMessage): Promise<string> {
    const sender = message.from;
    if (!sender) throw new BridgeError("Telegram 消息缺少发送者", "SENDER_MISSING");
    const command = commandName(message.text ?? "");
    if (command === "start" && this.pairing.activeOwner() === null) {
      const code = this.pairing.requestCode(String(sender.id), String(message.chat.id), message.chat.type);
      await this.api.sendMessage(
        message.chat.id,
        `<b>等待本机确认配对</b>\n\n配对码：<code>${code}</code>\n十分钟内在主机执行：<code>ctb pair ${code}</code>\n\nTelegram Bot 私聊不是端到端加密渠道，请勿发送密钥或生产机密。`,
      );
      this.tasks.recordNonTaskUpdate(updateId, "committed", "pairing_code_issued");
      return "pairing_code_issued";
    }
    let owner;
    try {
      owner = this.pairing.authenticate(String(sender.id), String(message.chat.id), message.chat.type);
    } catch (error) {
      this.audit.record({
        eventType: "auth_rejected",
        outcome: "denied",
        actorId: String(sender.id),
        metadata: { chatType: message.chat.type },
      });
      throw error;
    }
    this.gateway.setChatId(message.chat.id);
    const ageMs = Date.now() - message.date * 1000;
    if (!["start", "help", "ping"].includes(command ?? "") && ageMs > this.config.maxUpdateAgeMinutes * 60_000) {
      throw new BridgeError("消息已超过允许处理时间，为避免停机期间的旧命令重放已拒绝执行", "UPDATE_TOO_OLD");
    }
    if (message.reply_to_message && message.text && this.gateway.answerTextInput(message.reply_to_message.message_id, message.text)) {
      this.tasks.recordNonTaskUpdate(updateId, "committed", "input_answered");
      return "input_answered";
    }
    if (command) {
      const result = await this.#handleCommand(command, message, owner.id);
      this.tasks.recordNonTaskUpdate(updateId, "committed", result);
      return result;
    }
    const projectId = this.#activeProjectId();
    const promptParts = [message.text ?? message.caption ?? "请分析这个附件。"];
    const attachment = message.document ?? message.photo?.at(-1);
    const taskId = randomUUID();
    if (attachment) {
      const recent = (this.#attachmentWindows.get(sender.id) ?? []).filter((time) => time > Date.now() - 10 * 60_000);
      if (recent.length >= 10) throw new BridgeError("附件上传过于频繁，请十分钟后重试", "ATTACHMENT_RATE_LIMITED");
      recent.push(Date.now());
      this.#attachmentWindows.set(sender.id, recent);
      const path = await this.api.downloadFile(
        attachment.file_id,
        attachment.file_size,
        this.media.attachmentDirectoryFor(taskId),
        attachment.file_name ?? "image.bin",
        this.config.inboundFileLimitBytes,
      );
      const detectedMime = await this.media.sniffMime(path);
      if (message.photo && !detectedMime.startsWith("image/")) {
        throw new BridgeError("图片内容与声明类型不一致", "ATTACHMENT_MIME_MISMATCH");
      }
      promptParts.push(`本机附件路径：${path}`);
    }
    const ingested = this.tasks.ingestTelegramTask({
      updateId,
      messageId: message.message_id,
      projectId,
      body: promptParts.join("\n\n"),
      taskId,
    });
    try {
      const progress = await this.api.sendMessage(
        message.chat.id,
        `<b>任务已进入队列</b>\nID：<code>${taskId}</code>`,
        { inline_keyboard: [[{ text: "取消", callback_data: `taskcancel:${this.approvals.create({ requestId: `cancel:${taskId}`, threadId: taskId, turnId: "task", itemId: taskId }, Date.now() + 24 * 60 * 60_000)}` }]] },
      );
      this.gateway.attachProgress(taskId, progress.message_id);
    } finally {
      this.scheduler.wake();
    }
    return ingested.duplicate ? "duplicate_task" : "task_queued";
  }

  async #handleCommand(command: string, message: TelegramMessage, ownerId: number): Promise<string> {
    const args = (message.text ?? "").trim().split(/\s+/).slice(1);
    switch (command) {
      case "start":
      case "help":
        await this.api.sendMessage(message.chat.id, this.#helpText());
        return "help";
      case "ping": {
        const ageMs = Date.now() - message.date * 1000;
        await this.api.sendMessage(message.chat.id, `pong · Telegram 入站延迟 ${ageMs} ms`);
        return "ping";
      }
      case "projects":
      case "project": {
        if (command === "project" && args[0]) {
          const project = this.projects.require(args[0]);
          if (!project.enabled) throw new BridgeError("该项目已禁用", "PROJECT_DISABLED");
          this.#settings.set("active_project_id", project.id);
          await this.api.sendMessage(message.chat.id, `当前项目已切换为：${escapeHtml(project.name)}`);
          return "project_selected";
        }
        const menu = this.#projectMenu();
        await this.api.sendMessage(message.chat.id, menu.text, menu.keyboard);
        return "project_menu";
      }
      case "tasks": {
        const menu = this.#taskMenu();
        await this.api.sendMessage(message.chat.id, menu.text, menu.keyboard);
        return "task_menu";
      }
      case "cancel":
      case "stop": {
        const taskId = args[0] ? this.#resolveTaskId(args[0]) : this.scheduler.currentTask?.id;
        if (!taskId) throw new BridgeError("没有可取消的任务", "TASK_NOT_FOUND");
        await this.scheduler.cancel(taskId);
        await this.api.sendMessage(message.chat.id, `任务 <code>${taskId}</code> 已取消。`);
        return "task_cancelled";
      }
      case "retry": {
        const source = this.tasks.requireTask(this.#resolveTaskId(args[0] ?? ""));
        if (source.state !== "unknown") throw new BridgeError("仅 unknown 任务可安全重试；失败任务请重新发送正文", "RETRY_NOT_SAFE");
        const retried = this.tasks.transition(source.id, "queued");
        this.scheduler.wake();
        await this.api.sendMessage(message.chat.id, `任务 <code>${retried.id}</code> 已重新排队。`);
        return "task_retried";
      }
      case "new": {
        const projectId = this.#activeProjectId();
        const project = this.projects.require(projectId);
        const local = await this.models.localState(project.normalizedRoot);
        const effectiveModel = project.defaultModel ?? local.model ?? "未设置";
        const effectiveEffort = project.reasoningEffort ?? local.reasoningEffort ?? "模型默认";
        const effectiveTier = project.serviceTier ?? local.serviceTier ?? "default";
        this.database.connection.prepare("UPDATE threads SET closed_at = ?, updated_at = ? WHERE project_id = ? AND closed_at IS NULL").run(Date.now(), Date.now(), projectId);
        await this.api.sendMessage(
          message.chat.id,
          `<b>新对话配置</b>\n项目：${escapeHtml(project.name)}\n模型：<code>${escapeHtml(effectiveModel)}</code>\n思考深度：<code>${escapeHtml(effectiveEffort)}</code>\nFast：${effectiveTier === "default" ? "关闭" : `开启（<code>${escapeHtml(effectiveTier)}</code>）`}\n\n下一条消息将创建新对话。`,
        );
        return "new_session";
      }
      case "sessions":
      case "resume": {
        const projectId = this.#activeProjectId();
        if (command === "resume" && args[0]) {
          const threadId = this.#resolveThreadId(args[0], projectId);
          this.#resumeThread(threadId, projectId);
          await this.api.sendMessage(message.chat.id, `已恢复会话 <code>${escapeHtml(threadId.slice(0, 8))}</code>。`);
          return "session_resumed";
        }
        const menu = this.#sessionMenu();
        await this.api.sendMessage(message.chat.id, menu.text, menu.keyboard);
        return "session_menu";
      }
      case "handback":
        await this.api.sendMessage(message.chat.id, "会话已保留在 Codex 本地历史中。请在主机 Codex 中按 thread ID 继续；Telegram 不会导出或转发隐藏推理。 ");
        return "handback";
      case "model":
      case "effort":
      case "fast": {
        const projectId = this.#activeProjectId();
        const column = command === "model" ? "default_model" : command === "effort" ? "reasoning_effort" : "service_tier";
        if (args[0]) {
          if (command === "model") {
            const available = await this.models.list();
            if (!available.some((model) => model.model === args[0])) throw new BridgeError("该模型当前不可用", "MODEL_UNAVAILABLE");
          } else if (command === "effort") {
            const supported = await this.#supportedEfforts();
            if (!supported.some((effort) => effort.reasoningEffort === args[0])) throw new BridgeError("当前模型不支持该推理强度", "EFFORT_UNSUPPORTED");
          } else {
            const tiers = await this.#supportedServiceTiers();
            if (args[0] !== "default" && !tiers.some((tier) => tier.id === args[0])) throw new BridgeError("当前模型不支持该服务档位", "SERVICE_TIER_UNSUPPORTED");
          }
          if (command === "model") {
            this.database.connection.prepare("UPDATE projects SET default_model = ?, reasoning_effort = NULL, service_tier = NULL, updated_at = ? WHERE id = ?").run(args[0], Date.now(), projectId);
          } else {
            this.database.connection.prepare(`UPDATE projects SET ${column} = ?, updated_at = ? WHERE id = ?`).run(args[0], Date.now(), projectId);
          }
          const label = command === "model" ? "模型" : command === "effort" ? "推理强度" : "服务档位";
          await this.api.sendMessage(message.chat.id, `${label}已设置为：<code>${escapeHtml(args[0])}</code>`);
          return `${command}_updated`;
        }
        const menu = command === "model" ? await this.#modelMenu() : command === "effort" ? await this.#effortMenu() : await this.#fastMenu();
        await this.api.sendMessage(message.chat.id, menu.text, menu.keyboard);
        return `${command}_menu`;
      }
      case "permissions": {
        const projectId = this.#activeProjectId();
        if (args[0] === "danger-full-access") {
          if (!this.config.allowDangerFullAccess) throw new BridgeError("主机配置未允许完全访问", "HOST_DANGER_DISABLED");
          const token = this.approvals.create({ requestId: `danger:${projectId}:${ownerId}`, threadId: projectId, turnId: "permission", itemId: String(ownerId) }, Date.now() + 10 * 60_000);
          await this.api.sendMessage(message.chat.id, "<b>高危权限二次确认</b>\n将允许当前项目完全访问 15 分钟。仅在受控环境使用。", { inline_keyboard: [[{ text: "确认 15 分钟完全访问", callback_data: `danger:${token}` }], [{ text: "取消", callback_data: `noop:${token}` }]] });
          return "danger_confirmation_requested";
        }
        if (args[0] === "read-only" || args[0] === "workspace-write") {
          const value = args[0] === "workspace-write" ? "workspace-write + on-request" : args[0];
          this.database.connection.prepare("UPDATE projects SET permission_profile = ?, updated_at = ? WHERE id = ?").run(value, Date.now(), projectId);
          await this.api.sendMessage(message.chat.id, `当前权限：<code>${escapeHtml(value)}</code>`);
          return "permissions_updated";
        }
        const menu = this.#permissionMenu(ownerId);
        await this.api.sendMessage(message.chat.id, menu.text, menu.keyboard);
        return "permissions_menu";
      }
      case "status": {
        const project = this.projects.require(this.#activeProjectId());
        const local = await this.models.localState(project.normalizedRoot);
        const active = this.scheduler.currentTask;
        await this.api.sendMessage(message.chat.id, `<b>服务状态</b>\n项目：${escapeHtml(project.name)}\n模型：${escapeHtml(project.defaultModel ?? local.model ?? "未设置")}\n推理强度：${escapeHtml(project.reasoningEffort ?? local.reasoningEffort ?? "模型默认")}\nFast：${escapeHtml(project.serviceTier ?? local.serviceTier ?? "default")}\n权限：${escapeHtml(project.permissionProfile)}\n运行任务：${active ? `<code>${active.id}</code>` : "无"}\n队列：${this.tasks.listQueued().length}`);
        return "status";
      }
      case "health":
        await this.api.sendMessage(message.chat.id, await this.health.render());
        return "health";
      case "quota":
        await this.api.sendMessage(message.chat.id, await this.quota.render());
        return "quota";
      case "cleanup": {
        const token = this.approvals.create({ requestId: "cleanup", threadId: "maintenance", turnId: "cleanup", itemId: String(ownerId) }, Date.now() + 10 * 60_000);
        await this.api.sendMessage(message.chat.id, `<b>确认本地清理</b>\n附件与产物：超过 ${this.config.attachmentRetentionHours} 小时\n任务正文：超过 ${this.config.taskRetentionDays} 天\n脱敏审计：超过 ${this.config.auditRetentionDays} 天\n\n不会删除项目源码。`, { inline_keyboard: [[{ text: "确认清理", callback_data: `cl:${token}` }], [{ text: "取消", callback_data: `noop:${token}` }]] });
        return "cleanup_confirmation_requested";
      }
      case "version":
        await this.api.sendMessage(message.chat.id, "Codex Telegram Bridge 1.0.0");
        return "version";
      case "update":
        if (!this.updates) {
          await this.api.sendMessage(message.chat.id, "尚未在主机配置签名更新源；请使用 <code>ctb update</code> 或补齐更新配置。");
          return "update_not_configured";
        }
        {
          const candidate = await this.updates.check();
          const token = this.approvals.create({ requestId: `update:${candidate.version}`, threadId: "update", turnId: candidate.version, itemId: candidate.version }, Date.now() + 10 * 60_000);
          await this.api.sendMessage(message.chat.id, `<b>发现签名更新 ${escapeHtml(candidate.version)}</b>\n确认后将再次验证远端签名与版本，健康检查失败会自动回滚。`, { inline_keyboard: [[{ text: "确认更新", callback_data: `update:${token}` }], [{ text: "取消", callback_data: `noop:${token}` }]] });
          return "update_confirmation_requested";
        }
      default:
        await this.api.sendMessage(message.chat.id, "未知命令。发送 /help 查看说明。");
        return "unknown_command";
    }
  }

  async #handleCallback(updateId: number, callback: TelegramCallbackQuery): Promise<string> {
    const message = callback.message;
    if (!message || !callback.data) throw new BridgeError("callback 缺少消息或数据", "CALLBACK_INVALID");
    const owner = this.pairing.authenticate(String(callback.from.id), String(message.chat.id), message.chat.type);
    this.gateway.setChatId(message.chat.id);
    const [action, ...parts] = callback.data.split(":");
    if (action === "approval") {
      const decisionCode = parts.at(-1);
      const token = parts.slice(0, -1).join(":");
      const decisions = { a: "accept", s: "accept_for_session", d: "decline", c: "cancel" } as const;
      if (!decisionCode || !(decisionCode in decisions)) throw new BridgeError("审批决定无效", "APPROVAL_INVALID");
      this.gateway.consumeApproval(token, decisions[decisionCode as keyof typeof decisions]);
      await this.api.answerCallback(callback.id, "审批决定已提交");
      const labels = { a: "允许一次", s: "本会话允许", d: "已拒绝", c: "已取消任务" } as const;
      await this.api.editMessage(message.chat.id, message.message_id, `<b>审批已处理</b>\n结果：${labels[decisionCode as keyof typeof labels]}`, { inline_keyboard: [] });
    } else if (action === "input") {
      this.gateway.answerChoiceInput(parts[0] ?? "", Number(parts[1]));
      await this.api.answerCallback(callback.id, "选择已提交");
      await this.api.editMessage(message.chat.id, message.message_id, "<b>选择已提交</b>\nCodex 已收到你的选择。", { inline_keyboard: [] });
    } else if (action === "taskcancel") {
      const consumed = this.approvals.consumeAction(parts.join(":"), "accept");
      if (!consumed.requestId.startsWith("cancel:")) throw new BridgeError("取消按钮绑定错误", "CALLBACK_BINDING_MISMATCH");
      await this.scheduler.cancel(consumed.requestId.slice("cancel:".length));
      await this.api.answerCallback(callback.id, "任务已取消");
      await this.api.editMessage(message.chat.id, message.message_id, "<b>任务已取消</b>", { inline_keyboard: [] });
    } else if (action === "p") {
      const consumed = this.approvals.consumeAction(parts.join(":"), "accept");
      if (!consumed.requestId.startsWith("project:")) throw new BridgeError("项目按钮绑定错误", "CALLBACK_BINDING_MISMATCH");
      const project = this.projects.require(consumed.requestId.slice("project:".length));
      if (!project.enabled) throw new BridgeError("该项目已禁用", "PROJECT_DISABLED");
      this.#settings.set("active_project_id", project.id);
      await this.api.answerCallback(callback.id, `已切换到 ${project.name}`);
      await this.api.editMessage(message.chat.id, message.message_id, `<b>项目已切换</b>\n当前项目：${escapeHtml(project.name)}\n目录：<code>${escapeHtml(project.normalizedRoot)}</code>`, { inline_keyboard: [] });
      this.audit.record({ eventType: "project_selected", outcome: "accepted", projectId: project.id, actorId: String(owner.id) });
    } else if (action === "prm") {
      const consumed = this.approvals.consumeAction(parts.join(":"), "accept");
      if (consumed.requestId !== "project-remove-menu") throw new BridgeError("移除项目按钮绑定错误", "CALLBACK_BINDING_MISMATCH");
      const menu = this.#projectRemoveMenu();
      await this.api.answerCallback(callback.id);
      await this.api.editMessage(message.chat.id, message.message_id, menu.text, menu.keyboard);
    } else if (action === "pr") {
      const consumed = this.approvals.consumeAction(parts.join(":"), "accept");
      if (!consumed.requestId.startsWith("project-remove:")) throw new BridgeError("移除项目按钮绑定错误", "CALLBACK_BINDING_MISMATCH");
      const project = this.projects.require(consumed.requestId.slice("project-remove:".length));
      if (!project.enabled) throw new BridgeError("该项目已被移除", "PROJECT_DISABLED");
      this.database.connection.transaction(() => {
        this.projects.disable(project.id);
        if (this.#settings.get("active_project_id") === project.id) {
          const next = this.database.connection
            .prepare("SELECT id FROM projects WHERE enabled = 1 ORDER BY name LIMIT 1")
            .get() as { id: string } | undefined;
          if (next) this.#settings.set("active_project_id", next.id);
          else this.database.connection.prepare("DELETE FROM runtime_settings WHERE key = 'active_project_id'").run();
        }
      })();
      await this.api.answerCallback(callback.id, `已移除 ${project.name}`);
      await this.api.editMessage(message.chat.id, message.message_id, `<b>项目已移除</b>\n${escapeHtml(project.name)}`, { inline_keyboard: [] });
      this.audit.record({ eventType: "project_removed", outcome: "accepted", projectId: project.id, actorId: String(owner.id) });
    } else if (action === "pb") {
      const consumed = this.approvals.consumeAction(parts.join(":"), "accept");
      if (consumed.requestId !== "project-list") throw new BridgeError("返回项目列表按钮绑定错误", "CALLBACK_BINDING_MISMATCH");
      const menu = this.#projectMenu();
      await this.api.answerCallback(callback.id);
      await this.api.editMessage(message.chat.id, message.message_id, menu.text, menu.keyboard);
    } else if (action === "td") {
      const consumed = this.approvals.consumeAction(parts.join(":"), "accept");
      if (!consumed.requestId.startsWith("task-detail:")) throw new BridgeError("任务按钮绑定错误", "CALLBACK_BINDING_MISMATCH");
      const detail = this.#taskDetail(consumed.requestId.slice("task-detail:".length));
      await this.api.answerCallback(callback.id);
      await this.api.editMessage(message.chat.id, message.message_id, detail.text, detail.keyboard);
    } else if (action === "tb") {
      const consumed = this.approvals.consumeAction(parts.join(":"), "accept");
      if (consumed.requestId !== "task-list") throw new BridgeError("任务列表按钮绑定错误", "CALLBACK_BINDING_MISMATCH");
      const menu = this.#taskMenu();
      await this.api.answerCallback(callback.id);
      await this.api.editMessage(message.chat.id, message.message_id, menu.text, menu.keyboard);
    } else if (action === "tc") {
      const consumed = this.approvals.consumeAction(parts.join(":"), "accept");
      if (!consumed.requestId.startsWith("task-cancel:")) throw new BridgeError("取消任务按钮绑定错误", "CALLBACK_BINDING_MISMATCH");
      await this.scheduler.cancel(consumed.requestId.slice("task-cancel:".length));
      await this.api.answerCallback(callback.id, "任务已取消");
      await this.api.editMessage(message.chat.id, message.message_id, "<b>任务已取消</b>", { inline_keyboard: [] });
    } else if (action === "tr") {
      const consumed = this.approvals.consumeAction(parts.join(":"), "accept");
      if (!consumed.requestId.startsWith("task-retry:")) throw new BridgeError("重试任务按钮绑定错误", "CALLBACK_BINDING_MISMATCH");
      const taskId = consumed.requestId.slice("task-retry:".length);
      const source = this.tasks.requireTask(taskId);
      if (source.state !== "unknown") throw new BridgeError("仅 unknown 任务可安全重试", "RETRY_NOT_SAFE");
      this.tasks.transition(taskId, "queued");
      this.scheduler.wake();
      await this.api.answerCallback(callback.id, "任务已重新排队");
      await this.api.editMessage(message.chat.id, message.message_id, `<b>任务已重新排队</b>\nID：<code>${escapeHtml(taskId)}</code>`, { inline_keyboard: [] });
    } else if (action === "sd") {
      const consumed = this.approvals.consumeAction(parts.join(":"), "accept");
      if (!consumed.requestId.startsWith("session-detail:")) throw new BridgeError("会话按钮绑定错误", "CALLBACK_BINDING_MISMATCH");
      const detail = this.#sessionDetail(consumed.requestId.slice("session-detail:".length));
      await this.api.answerCallback(callback.id);
      await this.api.editMessage(message.chat.id, message.message_id, detail.text, detail.keyboard);
    } else if (action === "sb") {
      const consumed = this.approvals.consumeAction(parts.join(":"), "accept");
      if (consumed.requestId !== "session-list") throw new BridgeError("会话列表按钮绑定错误", "CALLBACK_BINDING_MISMATCH");
      const menu = this.#sessionMenu();
      await this.api.answerCallback(callback.id);
      await this.api.editMessage(message.chat.id, message.message_id, menu.text, menu.keyboard);
    } else if (action === "sr") {
      const consumed = this.approvals.consumeAction(parts.join(":"), "accept");
      if (!consumed.requestId.startsWith("session-resume:")) throw new BridgeError("恢复会话按钮绑定错误", "CALLBACK_BINDING_MISMATCH");
      const threadId = consumed.requestId.slice("session-resume:".length);
      this.#resumeThread(threadId, this.#activeProjectId());
      await this.api.answerCallback(callback.id, "会话已恢复");
      await this.api.editMessage(message.chat.id, message.message_id, `<b>会话已恢复</b>\n会话：<code>${escapeHtml(threadId.slice(0, 8))}</code>`, { inline_keyboard: [] });
    } else if (action === "sh") {
      const consumed = this.approvals.consumeAction(parts.join(":"), "accept");
      if (!consumed.requestId.startsWith("session-handback:")) throw new BridgeError("交回会话按钮绑定错误", "CALLBACK_BINDING_MISMATCH");
      const threadId = consumed.requestId.slice("session-handback:".length);
      const row = this.#threadRow(threadId, this.#activeProjectId());
      await this.api.answerCallback(callback.id, "会话信息已显示");
      await this.api.editMessage(message.chat.id, message.message_id, `<b>交回本机 Codex</b>\nThread ID：<code>${escapeHtml(row.codex_thread_id)}</code>\n\n请在主机 Codex 中继续此会话；Telegram 不会导出隐藏推理。`, { inline_keyboard: [] });
    } else if (action === "m") {
      const consumed = this.approvals.consumeAction(parts.join(":"), "accept");
      if (!consumed.requestId.startsWith("model:")) throw new BridgeError("模型按钮绑定错误", "CALLBACK_BINDING_MISMATCH");
      const model = consumed.requestId.slice("model:".length);
      const available = await this.models.list();
      if (model && !available.some((item) => item.model === model)) throw new BridgeError("该模型当前不可用", "MODEL_UNAVAILABLE");
      this.database.connection.prepare("UPDATE projects SET default_model = ?, reasoning_effort = NULL, service_tier = NULL, updated_at = ? WHERE id = ?").run(model || null, Date.now(), this.#activeProjectId());
      await this.api.answerCallback(callback.id, model ? `已切换到 ${model}` : "已跟随 Codex 默认模型");
      const project = this.projects.require(this.#activeProjectId());
      const local = await this.models.localState(project.normalizedRoot);
      await this.api.editMessage(
        message.chat.id,
        message.message_id,
        `<b>模型已更新</b>\n当前模型：<code>${escapeHtml(project.defaultModel ?? local.model ?? "未设置")}</code>\n来源：${project.defaultModel ? "项目设置" : "本机 Codex"}`,
        { inline_keyboard: [] },
      );
    } else if (action === "e") {
      const consumed = this.approvals.consumeAction(parts.join(":"), "accept");
      if (!consumed.requestId.startsWith("effort:")) throw new BridgeError("推理强度按钮绑定错误", "CALLBACK_BINDING_MISMATCH");
      const effort = consumed.requestId.slice("effort:".length);
      const supported = await this.#supportedEfforts();
      if (effort && !supported.some((item) => item.reasoningEffort === effort)) throw new BridgeError("当前模型不支持该推理强度", "EFFORT_UNSUPPORTED");
      this.database.connection.prepare("UPDATE projects SET reasoning_effort = ?, updated_at = ? WHERE id = ?").run(effort || null, Date.now(), this.#activeProjectId());
      await this.api.answerCallback(callback.id, effort ? `推理强度已设为 ${effort}` : "已跟随模型默认强度");
      const project = this.projects.require(this.#activeProjectId());
      const local = await this.models.localState(project.normalizedRoot);
      await this.api.editMessage(
        message.chat.id,
        message.message_id,
        `<b>思考深度已更新</b>\n当前深度：<code>${escapeHtml(project.reasoningEffort ?? local.reasoningEffort ?? "模型默认")}</code>\n来源：${project.reasoningEffort ? "项目设置" : "本机 Codex"}`,
        { inline_keyboard: [] },
      );
    } else if (action === "f") {
      const consumed = this.approvals.consumeAction(parts.join(":"), "accept");
      if (!consumed.requestId.startsWith("fast:")) throw new BridgeError("Fast 按钮绑定错误", "CALLBACK_BINDING_MISMATCH");
      const tier = consumed.requestId.slice("fast:".length);
      const supported = await this.#supportedServiceTiers();
      if (tier && tier !== "default" && !supported.some((item) => item.id === tier)) throw new BridgeError("当前模型不支持该服务档位", "SERVICE_TIER_UNSUPPORTED");
      this.database.connection.prepare("UPDATE projects SET service_tier = ?, updated_at = ? WHERE id = ?").run(tier || null, Date.now(), this.#activeProjectId());
      await this.api.answerCallback(callback.id, tier ? `服务档位已设为 ${tier}` : "已跟随本机 Codex 设置");
      const project = this.projects.require(this.#activeProjectId());
      const local = await this.models.localState(project.normalizedRoot);
      const effectiveTier = project.serviceTier ?? local.serviceTier ?? "default";
      await this.api.editMessage(
        message.chat.id,
        message.message_id,
        `<b>Fast 已更新</b>\n当前状态：${effectiveTier === "default" ? "关闭" : `开启（<code>${escapeHtml(effectiveTier)}</code>）`}\n来源：${project.serviceTier ? "项目设置" : "本机 Codex"}`,
        { inline_keyboard: [] },
      );
    } else if (action === "perm") {
      const consumed = this.approvals.consumeAction(parts.join(":"), "accept");
      if (!consumed.requestId.startsWith("permission:")) throw new BridgeError("权限按钮绑定错误", "CALLBACK_BINDING_MISMATCH");
      const profile = consumed.requestId.slice("permission:".length);
      if (profile !== "read-only" && profile !== "workspace-write + on-request") throw new BridgeError("权限档无效", "PERMISSION_INVALID");
      this.database.connection.prepare("UPDATE projects SET permission_profile = ?, updated_at = ? WHERE id = ?").run(profile, Date.now(), this.#activeProjectId());
      await this.api.answerCallback(callback.id, "权限已更新");
      await this.api.editMessage(message.chat.id, message.message_id, `<b>权限已更新</b>\n当前权限：<code>${escapeHtml(profile)}</code>`, { inline_keyboard: [] });
    } else if (action === "cl") {
      const consumed = this.approvals.consumeAction(parts.join(":"), "accept");
      if (consumed.requestId !== "cleanup") throw new BridgeError("清理按钮绑定错误", "CALLBACK_BINDING_MISMATCH");
      const media = await this.media.cleanup();
      const database = cleanupDatabase(this.database, this.config.taskRetentionDays * 86_400_000, this.config.auditRetentionDays * 86_400_000);
      await this.api.answerCallback(callback.id, "清理完成");
      await this.api.editMessage(message.chat.id, message.message_id, `<b>清理完成</b>\n附件：${media.attachments}\n产物：${media.artifacts}\n任务正文：${database.taskBodies}\n任务事件：${database.taskEvents}\n审计：${database.auditEvents}`, { inline_keyboard: [] });
    } else if (action === "danger") {
      const token = parts.join(":");
      const projectId = this.#activeProjectId();
      this.approvals.consume(token, { requestId: `danger:${projectId}:${owner.id}`, threadId: projectId, turnId: "permission", itemId: String(owner.id) }, "accept");
      this.leases.grantDangerLease({ projectId, ownerId: owner.id, hostAllowsDangerFullAccess: this.config.allowDangerFullAccess, telegramConfirmed: true });
      this.database.connection.prepare("UPDATE projects SET permission_profile = 'danger-full-access', updated_at = ? WHERE id = ?").run(Date.now(), projectId);
      await this.api.answerCallback(callback.id, "完全访问已授权 15 分钟", true);
      await this.api.editMessage(message.chat.id, message.message_id, "<b>完全访问已授权</b>\n当前项目将在十五分钟内使用完全访问权限。", { inline_keyboard: [] });
      this.audit.record({ eventType: "danger_lease", outcome: "granted", projectId, actorId: String(owner.id) });
    } else if (action === "noop") {
      this.approvals.consumeAction(parts.join(":"), "cancel");
      await this.api.answerCallback(callback.id, "操作已取消");
      await this.api.editMessage(message.chat.id, message.message_id, "<b>操作已取消</b>\n未执行任何更改。", { inline_keyboard: [] });
    } else if (action === "update") {
      if (!this.updates) throw new BridgeError("签名更新源未配置", "UPDATE_NOT_CONFIGURED");
      const consumed = this.approvals.consumeAction(parts.join(":"), "accept");
      if (!consumed.requestId.startsWith("update:")) throw new BridgeError("更新按钮绑定错误", "CALLBACK_BINDING_MISMATCH");
      const version = consumed.requestId.slice("update:".length);
      await this.updates.install(version);
      await this.api.answerCallback(callback.id, `正在安装 ${version}`, true);
      await this.api.editMessage(message.chat.id, message.message_id, `<b>更新已确认</b>\n正在安装：<code>${escapeHtml(version)}</code>`, { inline_keyboard: [] });
    } else {
      await this.api.answerCallback(callback.id, "操作已取消");
    }
    this.tasks.recordNonTaskUpdate(updateId, "committed", `callback_${action}`);
    return `callback_${action}`;
  }

  #activeProjectId(): string {
    const configured = this.#settings.get("active_project_id");
    if (configured) return configured;
    const row = this.database.connection.prepare("SELECT id FROM projects WHERE enabled = 1 ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
    if (!row) throw new BridgeError("尚未注册可用项目，请先在主机执行 ctb project add", "NO_PROJECT");
    this.#settings.set("active_project_id", row.id);
    return row.id;
  }

  #resolveTaskId(taskId: string): string {
    const exact = this.database.connection.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId) as { id: string } | undefined;
    if (exact) return exact.id;
    const matches = this.database.connection.prepare("SELECT id FROM tasks WHERE id LIKE ? ORDER BY id LIMIT 2").all(`${taskId}%`) as Array<{ id: string }>;
    const match = matches[0];
    if (matches.length !== 1 || !match) throw new BridgeError(matches.length ? "任务短 ID 不唯一，请输入更多字符" : "任务不存在", "TASK_NOT_FOUND");
    return match.id;
  }

  #resolveThreadId(threadId: string, projectId: string): string {
    const matches = this.database.connection
      .prepare("SELECT id FROM threads WHERE project_id = ? AND (id = ? OR id LIKE ?) ORDER BY id LIMIT 2")
      .all(projectId, threadId, `${threadId}%`) as Array<{ id: string }>;
    const exact = matches.find((row) => row.id === threadId);
    if (exact) return exact.id;
    const match = matches[0];
    if (matches.length !== 1 || !match) throw new BridgeError(matches.length ? "会话短 ID 不唯一，请输入更多字符" : "会话不存在", "SESSION_NOT_FOUND");
    return match.id;
  }

  #threadRow(threadId: string, projectId: string): { id: string; codex_thread_id: string; permission_profile: string; closed_at: number | null; created_at: number; updated_at: number } {
    const row = this.database.connection
      .prepare("SELECT id, codex_thread_id, permission_profile, closed_at, created_at, updated_at FROM threads WHERE id = ? AND project_id = ?")
      .get(threadId, projectId) as { id: string; codex_thread_id: string; permission_profile: string; closed_at: number | null; created_at: number; updated_at: number } | undefined;
    if (!row) throw new BridgeError("会话不存在或不属于当前项目", "SESSION_NOT_FOUND");
    return row;
  }

  #resumeThread(threadId: string, projectId: string): void {
    const row = this.#threadRow(threadId, projectId);
    const project = this.projects.require(projectId);
    if (row.permission_profile !== project.permissionProfile) {
      throw new BridgeError(`会话权限为 ${row.permission_profile}，请先用 /permissions 切换到相同权限`, "SESSION_PERMISSION_MISMATCH");
    }
    const now = Date.now();
    this.database.connection.transaction(() => {
      this.database.connection
        .prepare("UPDATE threads SET closed_at = ?, updated_at = ? WHERE project_id = ? AND permission_profile = ? AND id <> ? AND closed_at IS NULL")
        .run(now, now, projectId, row.permission_profile, threadId);
      const changes = this.database.connection
        .prepare("UPDATE threads SET closed_at = NULL, updated_at = ? WHERE id = ? AND project_id = ?")
        .run(now, threadId, projectId).changes;
      if (changes !== 1) throw new BridgeError("恢复会话失败", "SESSION_RESUME_FAILED");
    })();
  }

  #taskMenu(): { text: string; keyboard: InlineKeyboardMarkup } {
    const projectId = this.#activeProjectId();
    const rows = this.tasks.listTasks([], 50).filter((task) => task.projectId === projectId).slice(0, 10);
    if (!rows.length) return { text: "当前项目暂无任务。", keyboard: { inline_keyboard: [] } };
    const expiresAt = Date.now() + 10 * 60_000;
    return {
      text: "<b>任务管理</b>\n点击任务查看详情；按钮十分钟内有效。",
      keyboard: {
        inline_keyboard: rows.map((task) => [{
          text: `${this.#taskStateLabel(task.state)} · ${task.id.slice(0, 8)} · ${this.#formatTime(task.updatedAt)}`,
          callback_data: `td:${this.approvals.create({ requestId: `task-detail:${task.id}`, threadId: task.threadId ?? task.id, turnId: task.turnId ?? "task-menu", itemId: task.id }, expiresAt)}`,
        }]),
      },
    };
  }

  #taskDetail(taskId: string): { text: string; keyboard: InlineKeyboardMarkup } {
    const task = this.tasks.requireTask(taskId);
    if (task.projectId !== this.#activeProjectId()) throw new BridgeError("任务不属于当前项目", "TASK_PROJECT_MISMATCH");
    const expiresAt = Date.now() + 10 * 60_000;
    const buttons: InlineKeyboardMarkup["inline_keyboard"] = [];
    if (!["completed", "failed", "cancelled"].includes(task.state)) {
      buttons.push([{ text: "取消任务", callback_data: `tc:${this.approvals.create({ requestId: `task-cancel:${task.id}`, threadId: task.threadId ?? task.id, turnId: task.turnId ?? "task-menu", itemId: task.id }, expiresAt)}` }]);
    }
    if (task.state === "unknown") {
      buttons.push([{ text: "安全重试", callback_data: `tr:${this.approvals.create({ requestId: `task-retry:${task.id}`, threadId: task.threadId ?? task.id, turnId: task.turnId ?? "task-menu", itemId: task.id }, expiresAt)}` }]);
    }
    buttons.push([{ text: "返回任务列表", callback_data: `tb:${this.approvals.create({ requestId: "task-list", threadId: task.projectId, turnId: "task-menu", itemId: task.id }, expiresAt)}` }]);
    return {
      text: `<b>任务详情</b>\nID：<code>${task.id.slice(0, 8)}</code>\n状态：${this.#taskStateLabel(task.state)}\n创建：${this.#formatTime(task.createdAt)}\n更新：${this.#formatTime(task.updatedAt)}${task.error ? `\n错误：${escapeHtml(task.error)}` : ""}`,
      keyboard: { inline_keyboard: buttons },
    };
  }

  #sessionMenu(): { text: string; keyboard: InlineKeyboardMarkup } {
    const projectId = this.#activeProjectId();
    const rows = this.database.connection
      .prepare("SELECT id, permission_profile, closed_at, updated_at FROM threads WHERE project_id = ? ORDER BY updated_at DESC LIMIT 10")
      .all(projectId) as Array<{ id: string; permission_profile: string; closed_at: number | null; updated_at: number }>;
    if (!rows.length) return { text: "当前项目暂无会话。发送普通任务后会自动创建。", keyboard: { inline_keyboard: [] } };
    const expiresAt = Date.now() + 10 * 60_000;
    return {
      text: "<b>会话管理</b>\n点击会话查看详情；按钮十分钟内有效。",
      keyboard: {
        inline_keyboard: rows.map((row) => [{
          text: `${row.closed_at === null ? "●" : "○"} ${row.permission_profile} · ${row.id.slice(0, 8)} · ${this.#formatTime(row.updated_at)}`.slice(0, 60),
          callback_data: `sd:${this.approvals.create({ requestId: `session-detail:${row.id}`, threadId: row.id, turnId: "session-menu", itemId: row.id }, expiresAt)}`,
        }]),
      },
    };
  }

  #sessionDetail(threadId: string): { text: string; keyboard: InlineKeyboardMarkup } {
    const row = this.#threadRow(threadId, this.#activeProjectId());
    const expiresAt = Date.now() + 10 * 60_000;
    const keyboard: InlineKeyboardMarkup["inline_keyboard"] = [];
    if (row.closed_at !== null) {
      keyboard.push([{ text: "恢复此会话", callback_data: `sr:${this.approvals.create({ requestId: `session-resume:${row.id}`, threadId: row.id, turnId: "session-menu", itemId: row.id }, expiresAt)}` }]);
    }
    keyboard.push([{ text: "交回本机 Codex", callback_data: `sh:${this.approvals.create({ requestId: `session-handback:${row.id}`, threadId: row.id, turnId: "session-menu", itemId: row.id }, expiresAt)}` }]);
    keyboard.push([{ text: "返回会话列表", callback_data: `sb:${this.approvals.create({ requestId: "session-list", threadId: row.id, turnId: "session-menu", itemId: row.id }, expiresAt)}` }]);
    return {
      text: `<b>会话详情</b>\nID：<code>${row.id.slice(0, 8)}</code>\n状态：${row.closed_at === null ? "活跃" : "已关闭"}\n权限：${escapeHtml(row.permission_profile)}\n创建：${this.#formatTime(row.created_at)}\n最近活动：${this.#formatTime(row.updated_at)}`,
      keyboard: { inline_keyboard: keyboard },
    };
  }

  async #modelMenu(): Promise<{ text: string; keyboard: InlineKeyboardMarkup }> {
    const project = this.projects.require(this.#activeProjectId());
    const models = await this.models.list();
    const local = await this.models.localState(project.normalizedRoot);
    const effectiveModel = project.defaultModel ?? local.model ?? models.find((model) => model.isDefault)?.model ?? null;
    const expiresAt = Date.now() + 10 * 60_000;
    const rows = [{ model: "", displayName: "跟随本机 Codex 设置" }, ...models.map((model) => ({ model: model.model, displayName: model.displayName }))];
    return {
      text: `<b>选择模型</b>\n本机：${escapeHtml(local.model ?? "未设置")}\n当前生效：${escapeHtml(effectiveModel ?? "未设置")}（${project.defaultModel ? "项目覆盖" : "本机设置"}）\n切换模型会清空项目级推理强度和 Fast 档位。`,
      keyboard: {
        inline_keyboard: rows.map((row) => [{
          text: `${(project.defaultModel ?? "") === row.model ? "●" : "○"} ${row.displayName}`.slice(0, 60),
          callback_data: `m:${this.approvals.create({ requestId: `model:${row.model}`, threadId: project.id, turnId: "model-menu", itemId: row.model || "default" }, expiresAt)}`,
        }]),
      },
    };
  }

  async #supportedEfforts(): Promise<Array<{ reasoningEffort: string; description: string }>> {
    const project = this.projects.require(this.#activeProjectId());
    const models = await this.models.list();
    const local = await this.models.localState(project.normalizedRoot);
    const effectiveModel = project.defaultModel ?? local.model;
    const selected = effectiveModel ? models.find((model) => model.model === effectiveModel) : models.find((model) => model.isDefault);
    if (!selected) throw new BridgeError("无法确定当前模型支持的推理强度", "MODEL_NOT_FOUND");
    return selected.supportedReasoningEfforts;
  }

  async #effortMenu(): Promise<{ text: string; keyboard: InlineKeyboardMarkup }> {
    const project = this.projects.require(this.#activeProjectId());
    const local = await this.models.localState(project.normalizedRoot);
    const efforts = await this.#supportedEfforts();
    const effectiveEffort = project.reasoningEffort ?? local.reasoningEffort ?? "模型默认";
    const expiresAt = Date.now() + 10 * 60_000;
    const rows = [{ reasoningEffort: "", description: "跟随本机 Codex 设置" }, ...efforts];
    return {
      text: `<b>选择推理强度</b>\n本机：${escapeHtml(local.reasoningEffort ?? "模型默认")}\n当前生效：${escapeHtml(effectiveEffort)}（${project.reasoningEffort ? "项目覆盖" : "本机设置"}）`,
      keyboard: {
        inline_keyboard: rows.map((row) => [{
          text: `${(project.reasoningEffort ?? "") === row.reasoningEffort ? "●" : "○"} ${row.reasoningEffort || "默认"} · ${row.description}`.slice(0, 60),
          callback_data: `e:${this.approvals.create({ requestId: `effort:${row.reasoningEffort}`, threadId: project.id, turnId: "effort-menu", itemId: row.reasoningEffort || "default" }, expiresAt)}`,
        }]),
      },
    };
  }

  async #selectedModel(): Promise<{ project: ReturnType<ProjectRegistry["require"]>; model: AvailableModel; local: Awaited<ReturnType<ModelProvider["localState"]>> }> {
    const project = this.projects.require(this.#activeProjectId());
    const [models, local] = await Promise.all([
      this.models.list(),
      this.models.localState(project.normalizedRoot),
    ]);
    const effectiveModel = project.defaultModel ?? local.model;
    const model = effectiveModel ? models.find((item) => item.model === effectiveModel) : models.find((item) => item.isDefault);
    if (!model) throw new BridgeError("无法确定当前模型的本机服务档位", "MODEL_NOT_FOUND");
    return { project, model, local };
  }

  async #supportedServiceTiers(): Promise<Array<{ id: string; name: string; description: string }>> {
    return (await this.#selectedModel()).model.serviceTiers;
  }

  async #fastMenu(): Promise<{ text: string; keyboard: InlineKeyboardMarkup }> {
    const { project, model, local } = await this.#selectedModel();
    const effectiveTier = project.serviceTier ?? local.serviceTier ?? "default";
    const expiresAt = Date.now() + 10 * 60_000;
    const rows = [
      { id: "", name: "跟随本机 Codex 设置", description: local.serviceTier ?? "default" },
      { id: "default", name: "Standard", description: "标准速度与用量" },
      ...model.serviceTiers,
    ];
    return {
      text: `<b>选择 Fast 模式</b>\n模型：${escapeHtml(model.displayName)}\n本机：${escapeHtml(local.serviceTier ?? "default")}\n当前生效：${escapeHtml(effectiveTier)}（${project.serviceTier ? "项目覆盖" : "本机设置"}）`,
      keyboard: {
        inline_keyboard: rows.map((row) => [{
          text: `${(project.serviceTier ?? "") === row.id ? "●" : "○"} ${row.name} · ${row.description}`.slice(0, 60),
          callback_data: `f:${this.approvals.create({ requestId: `fast:${row.id}`, threadId: project.id, turnId: "fast-menu", itemId: row.id || "local" }, expiresAt)}`,
        }]),
      },
    };
  }

  #permissionMenu(ownerId: number): { text: string; keyboard: InlineKeyboardMarkup } {
    const project = this.projects.require(this.#activeProjectId());
    const expiresAt = Date.now() + 10 * 60_000;
    const regular = ["read-only", "workspace-write + on-request"] as const;
    const keyboard: InlineKeyboardMarkup["inline_keyboard"] = regular.map((profile) => [{
      text: `${project.permissionProfile === profile ? "●" : "○"} ${profile}`,
      callback_data: `perm:${this.approvals.create({ requestId: `permission:${profile}`, threadId: project.id, turnId: "permission-menu", itemId: String(ownerId) }, expiresAt)}`,
    }]);
    if (this.config.allowDangerFullAccess) {
      keyboard.push([{ text: `${project.permissionProfile === "danger-full-access" ? "●" : "○"} danger-full-access（15 分钟）`, callback_data: `danger:${this.approvals.create({ requestId: `danger:${project.id}:${ownerId}`, threadId: project.id, turnId: "permission", itemId: String(ownerId) }, expiresAt)}` }]);
    }
    return {
      text: `<b>选择权限</b>\n当前：<code>${escapeHtml(project.permissionProfile)}</code>${this.config.allowDangerFullAccess ? "\n完全访问需再次确认且只生效十五分钟。" : "\n主机未启用完全访问。"}`,
      keyboard: { inline_keyboard: keyboard },
    };
  }

  #taskStateLabel(state: string): string {
    return ({ queued: "排队中", running: "运行中", waiting_input: "等待输入", waiting_approval: "等待审批", completed: "已完成", failed: "失败", cancelled: "已取消", unknown: "待确认", received: "已接收" } as Record<string, string>)[state] ?? state;
  }

  #formatTime(value: number): string {
    return new Date(value).toLocaleString("zh-CN", { hour12: false });
  }

  #projectMenu(): { text: string; keyboard: InlineKeyboardMarkup } {
    const rows = this.database.connection
      .prepare("SELECT id, name, normalized_root FROM projects WHERE enabled = 1 ORDER BY name")
      .all() as Array<{ id: string; name: string; normalized_root: string }>;
    if (rows.length === 0) {
      return {
        text: "尚未注册项目。请在主机执行 <code>ctb project add &lt;path&gt; --name &lt;name&gt;</code>。",
        keyboard: { inline_keyboard: [] },
      };
    }
    const active = this.#settings.get("active_project_id");
    const expiresAt = Date.now() + 10 * 60_000;
    return {
      text: `<b>选择项目</b>\n当前：${escapeHtml(rows.find((row) => row.id === active)?.name ?? "未选择")}\n\n点击下方按钮切换；按钮十分钟内有效。`,
      keyboard: {
        inline_keyboard: [...rows.map((row) => [{
          text: `${row.id === active ? "●" : "○"} ${row.name.slice(0, 40)} · ${shortProjectId(row.id)}`,
          callback_data: `p:${this.approvals.create({ requestId: `project:${row.id}`, threadId: row.id, turnId: "project-menu", itemId: row.id }, expiresAt)}`,
        }]), [{
          text: "移除项目",
          callback_data: `prm:${this.approvals.create({ requestId: "project-remove-menu", threadId: "projects", turnId: "project-menu", itemId: "remove" }, expiresAt)}`,
        }]],
      },
    };
  }

  #projectRemoveMenu(): { text: string; keyboard: InlineKeyboardMarkup } {
    const rows = this.database.connection
      .prepare("SELECT id, name FROM projects WHERE enabled = 1 ORDER BY name")
      .all() as Array<{ id: string; name: string }>;
    const expiresAt = Date.now() + 10 * 60_000;
    return {
      text: rows.length === 0
        ? "<b>移除项目</b>\n当前没有可移除的项目。"
        : "<b>移除项目</b>\n点击项目即可从 Telegram 项目列表移除。项目历史会保留，源码文件不会被删除；按钮十分钟内有效。",
      keyboard: {
        inline_keyboard: [
          ...rows.map((row) => [{
            text: `移除 ${row.name.slice(0, 36)} · ${shortProjectId(row.id)}`,
            callback_data: `pr:${this.approvals.create({ requestId: `project-remove:${row.id}`, threadId: row.id, turnId: "project-remove-menu", itemId: row.id }, expiresAt)}`,
          }]),
          [{
            text: "返回项目列表",
            callback_data: `pb:${this.approvals.create({ requestId: "project-list", threadId: "projects", turnId: "project-remove-menu", itemId: "back" }, expiresAt)}`,
          }],
        ],
      },
    };
  }

  #helpText(): string {
    return `<b>Codex Telegram Bridge</b>\n\n单用户、仅私聊；所有项目必须在主机预注册。Telegram Bot 私聊不是端到端加密渠道，请勿发送密钥或生产机密。\n\n${renderCommandHelp()}`;
  }
}
