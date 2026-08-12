import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type { BridgeConfig } from "../core/config.js";
import { BridgeError, errorMessage } from "../core/types.js";
import type { MediaManager } from "../media/manager.js";
import type { TaskScheduler } from "../scheduler/task-scheduler.js";
import type {
  ApprovalManager,
  AuditLog,
  PairingService,
  PermissionLeaseManager,
  ProjectRegistry,
} from "../security/index.js";
import type { BridgeDatabase, TaskLedger } from "../storage/index.js";
import { cleanupDatabase } from "../runtime/maintenance.js";
import { RuntimeSettings } from "../runtime/settings.js";
import type { TelegramApi } from "./api.js";
import { commandName, escapeHtml } from "./format.js";
import type { TelegramInteractiveGateway } from "./gateway.js";
import type { TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from "./types.js";

export interface HealthProvider {
  render(): Promise<string>;
}

export interface UpdateProvider {
  check(): Promise<{ version: string }>;
  install(expectedVersion: string): Promise<void>;
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
      case "projects": {
        const rows = this.database.connection.prepare("SELECT id, name, normalized_root, enabled FROM projects ORDER BY name").all() as Array<{ id: string; name: string; normalized_root: string; enabled: number }>;
        const active = this.#settings.get("active_project_id");
        await this.api.sendMessage(message.chat.id, rows.length
          ? rows.map((row) => `${row.id === active ? "●" : "○"} <code>${row.id}</code> ${escapeHtml(row.name)}\n  ${escapeHtml(row.normalized_root)}${row.enabled ? "" : "（已禁用）"}`).join("\n")
          : "尚未注册项目。请在主机执行 <code>ctb project add &lt;path&gt; --name &lt;name&gt;</code>。");
        return "projects";
      }
      case "project": {
        const project = this.projects.require(args[0] ?? "");
        if (!project.enabled) throw new BridgeError("该项目已禁用", "PROJECT_DISABLED");
        this.#settings.set("active_project_id", project.id);
        await this.api.sendMessage(message.chat.id, `当前项目已切换为：${escapeHtml(project.name)}`);
        return "project_selected";
      }
      case "tasks": {
        const rows = this.tasks.listTasks([], 20);
        await this.api.sendMessage(message.chat.id, rows.length
          ? rows.map((task) => `<code>${task.id}</code> · ${task.state}`).join("\n")
          : "暂无任务。");
        return "tasks";
      }
      case "cancel": {
        const taskId = args[0] ?? this.scheduler.currentTask?.id;
        if (!taskId) throw new BridgeError("没有可取消的任务", "TASK_NOT_FOUND");
        await this.scheduler.cancel(taskId);
        await this.api.sendMessage(message.chat.id, `任务 <code>${taskId}</code> 已取消。`);
        return "task_cancelled";
      }
      case "retry": {
        const source = this.tasks.requireTask(args[0] ?? "");
        if (source.state !== "unknown") throw new BridgeError("仅 unknown 任务可安全重试；失败任务请重新发送正文", "RETRY_NOT_SAFE");
        const retried = this.tasks.transition(source.id, "queued");
        this.scheduler.wake();
        await this.api.sendMessage(message.chat.id, `任务 <code>${retried.id}</code> 已重新排队。`);
        return "task_retried";
      }
      case "new": {
        const projectId = this.#activeProjectId();
        this.database.connection.prepare("UPDATE threads SET closed_at = ?, updated_at = ? WHERE project_id = ? AND closed_at IS NULL").run(Date.now(), Date.now(), projectId);
        await this.api.sendMessage(message.chat.id, "当前项目将在下一条任务创建新会话。");
        return "new_session";
      }
      case "sessions":
      case "resume": {
        const projectId = this.#activeProjectId();
        const rows = this.database.connection.prepare("SELECT id, codex_thread_id, permission_profile, closed_at FROM threads WHERE project_id = ? ORDER BY updated_at DESC LIMIT 20").all(projectId) as Array<{ id: string; codex_thread_id: string; permission_profile: string; closed_at: number | null }>;
        if (command === "resume" && args[0]) {
          this.database.connection.prepare("UPDATE threads SET closed_at = NULL, updated_at = ? WHERE id = ? AND project_id = ?").run(Date.now(), args[0], projectId);
          await this.api.sendMessage(message.chat.id, `已恢复会话 <code>${escapeHtml(args[0])}</code>。`);
          return "session_resumed";
        }
        await this.api.sendMessage(message.chat.id, rows.length ? rows.map((row) => `<code>${row.id}</code> · ${row.permission_profile}${row.closed_at ? " · 已关闭" : " · 活跃"}\n${escapeHtml(row.codex_thread_id)}`).join("\n") : "暂无会话。");
        return "sessions";
      }
      case "handback":
        await this.api.sendMessage(message.chat.id, "会话已保留在 Codex 本地历史中。请在主机 Codex 中按 thread ID 继续；Telegram 不会导出或转发隐藏推理。 ");
        return "handback";
      case "model":
      case "effort": {
        const projectId = this.#activeProjectId();
        const column = command === "model" ? "default_model" : "reasoning_effort";
        if (args[0]) this.database.connection.prepare(`UPDATE projects SET ${column} = ?, updated_at = ? WHERE id = ?`).run(args[0], Date.now(), projectId);
        const project = this.projects.require(projectId);
        await this.api.sendMessage(message.chat.id, `${command === "model" ? "模型" : "推理强度"}：<code>${escapeHtml(command === "model" ? project.defaultModel ?? "默认" : project.reasoningEffort ?? "默认")}</code>`);
        return `${command}_updated`;
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
        }
        await this.api.sendMessage(message.chat.id, `当前权限：<code>${escapeHtml(this.projects.require(projectId).permissionProfile)}</code>`);
        return "permissions";
      }
      case "status": {
        const project = this.projects.require(this.#activeProjectId());
        const active = this.scheduler.currentTask;
        await this.api.sendMessage(message.chat.id, `<b>服务状态</b>\n项目：${escapeHtml(project.name)}\n模型：${escapeHtml(project.defaultModel ?? "默认")}\n权限：${escapeHtml(project.permissionProfile)}\n运行任务：${active ? `<code>${active.id}</code>` : "无"}\n队列：${this.tasks.listQueued().length}`);
        return "status";
      }
      case "health":
        await this.api.sendMessage(message.chat.id, await this.health.render());
        return "health";
      case "cleanup": {
        const media = await this.media.cleanup();
        const database = cleanupDatabase(this.database, this.config.taskRetentionDays * 86_400_000, this.config.auditRetentionDays * 86_400_000);
        await this.api.sendMessage(message.chat.id, `清理完成：附件 ${media.attachments}、产物 ${media.artifacts}、任务正文 ${database.taskBodies}、任务事件 ${database.taskEvents}、审计 ${database.auditEvents}。`);
        return "cleanup";
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
    } else if (action === "input") {
      this.gateway.answerChoiceInput(parts[0] ?? "", Number(parts[1]));
      await this.api.answerCallback(callback.id, "选择已提交");
    } else if (action === "taskcancel") {
      const consumed = this.approvals.consumeAction(parts.join(":"), "accept");
      if (!consumed.requestId.startsWith("cancel:")) throw new BridgeError("取消按钮绑定错误", "CALLBACK_BINDING_MISMATCH");
      await this.scheduler.cancel(consumed.requestId.slice("cancel:".length));
      await this.api.answerCallback(callback.id, "任务已取消");
    } else if (action === "danger") {
      const token = parts.join(":");
      const projectId = this.#activeProjectId();
      this.approvals.consume(token, { requestId: `danger:${projectId}:${owner.id}`, threadId: projectId, turnId: "permission", itemId: String(owner.id) }, "accept");
      this.leases.grantDangerLease({ projectId, ownerId: owner.id, hostAllowsDangerFullAccess: this.config.allowDangerFullAccess, telegramConfirmed: true });
      this.database.connection.prepare("UPDATE projects SET permission_profile = 'danger-full-access', updated_at = ? WHERE id = ?").run(Date.now(), projectId);
      await this.api.answerCallback(callback.id, "完全访问已授权 15 分钟", true);
      this.audit.record({ eventType: "danger_lease", outcome: "granted", projectId, actorId: String(owner.id) });
    } else if (action === "noop") {
      this.approvals.consumeAction(parts.join(":"), "cancel");
      await this.api.answerCallback(callback.id, "操作已取消");
    } else if (action === "update") {
      if (!this.updates) throw new BridgeError("签名更新源未配置", "UPDATE_NOT_CONFIGURED");
      const consumed = this.approvals.consumeAction(parts.join(":"), "accept");
      if (!consumed.requestId.startsWith("update:")) throw new BridgeError("更新按钮绑定错误", "CALLBACK_BINDING_MISMATCH");
      const version = consumed.requestId.slice("update:".length);
      await this.updates.install(version);
      await this.api.answerCallback(callback.id, `正在安装 ${version}`, true);
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

  #helpText(): string {
    return `<b>Codex Telegram Bridge</b>\n\n单用户、仅私聊；所有项目必须在主机预注册。Telegram Bot 私聊不是端到端加密渠道，请勿发送密钥或生产机密。\n\n/start /help /projects /project /new /sessions /resume /handback /tasks /cancel /retry /model /effort /permissions /status /ping /health /cleanup /update /version`;
  }
}
