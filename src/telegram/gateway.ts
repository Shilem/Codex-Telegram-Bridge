import { EventEmitter } from "node:events";

import type { Logger } from "pino";

import type { RequestUserInputParams, ServerRequest } from "../app-server/types.js";
import type { TaskRecord } from "../core/types.js";
import type { MediaManager } from "../media/manager.js";
import type { ApprovalCard, ApprovalChoice, InteractiveGateway, ToolActivity } from "../orchestrator/app-task-executor.js";
import { type ApprovalBinding } from "../security/index.js";
import type { ApprovalDecision , ApprovalManager} from "../security/index.js";
import type { TelegramApi } from "./api.js";
import { escapeHtml, splitTelegramText } from "./format.js";
import { TelegramProgressMessage } from "./progress.js";

interface PendingApproval {
  taskId: string;
  binding: ApprovalBinding;
  resolve: (choice: ApprovalChoice) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingInput {
  taskId: string;
  messageIds: Map<number, string>;
  request: ServerRequest<RequestUserInputParams>;
  answers: Record<string, string[]>;
  inputTokens: Map<string, string>;
  resolve: (answers: Record<string, string[]>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ToolCard {
  messageId: number | null;
  active: Map<string, string>;
  operation: Promise<void>;
}

export class TelegramInteractiveGateway extends EventEmitter implements InteractiveGateway {
  readonly #progress = new Map<string, TelegramProgressMessage>();
  readonly #approvals = new Map<string, PendingApproval>();
  readonly #inputs = new Map<string, PendingInput>();
  readonly #toolCards = new Map<string, ToolCard>();

  public constructor(
    private readonly api: TelegramApi,
    private chatId: number,
    private readonly approvalManager: ApprovalManager,
    private readonly media: MediaManager,
    private readonly outboundFileLimitBytes: number,
    private readonly logger: Logger,
  ) {
    super();
  }

  public setChatId(chatId: number): void {
    this.chatId = chatId;
  }

  public attachProgress(taskId: string, messageId: number): void {
    this.#progress.set(taskId, new TelegramProgressMessage(this.api, this.chatId, messageId, this.logger));
  }

  public progress(task: TaskRecord, text: string): void {
    const progress = this.#progress.get(task.id);
    progress?.update(`<b>任务 ${escapeHtml(task.id.slice(0, 8))}</b>\n\n${escapeHtml(text.slice(0, 3900))}`);
  }

  public async plan(task: TaskRecord, summary: string): Promise<void> {
    await this.api.sendMessage(this.chatId, `<b>计划更新 · ${escapeHtml(task.id.slice(0, 8))}</b>\n${escapeHtml(summary)}`);
  }

  public async tool(task: TaskRecord, activity: ToolActivity): Promise<void> {
    const card = this.#toolCards.get(task.id) ?? {
      messageId: null,
      active: new Map<string, string>(),
      operation: Promise.resolve(),
    };
    this.#toolCards.set(task.id, card);
    card.operation = card.operation.then(async () => {
      if (activity.status === "started") card.active.set(activity.itemId, activity.itemType);
      else card.active.delete(activity.itemId);

      if (card.active.size === 0) {
        if (card.messageId !== null) await this.#deleteToolCardMessage(task.id, card.messageId);
        this.#toolCards.delete(task.id);
        return;
      }

      const details = [...card.active.values()].map((itemType) => `• ${escapeHtml(itemType)}`).join("\n");
      const text = `<b>正在调用工具 · ${escapeHtml(task.id.slice(0, 8))}</b>\n${details}`;
      if (card.messageId === null) {
        const sent = await this.api.sendMessage(this.chatId, text);
        card.messageId = sent.message_id;
      } else {
        await this.api.editMessage(this.chatId, card.messageId, text);
      }
    });
    await card.operation;
  }

  public async final(task: TaskRecord, text: string): Promise<void> {
    await this.#removeToolCard(task.id);
    const progress = this.#progress.get(task.id);
    this.#progress.delete(task.id);
    const chunks = splitTelegramText(text, 3800);
    const firstChunk = chunks[0] ?? "任务已完成，但没有可公开的文本结果。";
    const renderChunk = (chunk: string, index: number): string =>
      `<b>最终结果${chunks.length > 1 ? ` ${index + 1}/${chunks.length}` : ""}</b>\n\n${escapeHtml(chunk)}`;
    if (progress) {
      await progress.finalize(renderChunk(firstChunk, 0));
    } else {
      await this.api.sendMessage(this.chatId, renderChunk(firstChunk, 0));
    }
    for (const [index, chunk] of chunks.slice(1).entries()) {
      await this.api.sendMessage(
        this.chatId,
        renderChunk(chunk, index + 1),
      );
    }
  }

  public async artifact(task: TaskRecord, filePath: string, projectRoot: string): Promise<void> {
    const canonical = await this.media.isolateOutboundFile(
      filePath,
      [projectRoot],
      this.outboundFileLimitBytes,
    );
    await this.api.sendDocument(
      this.chatId,
      canonical,
      this.outboundFileLimitBytes,
      `任务 ${task.id.slice(0, 8)} 生成的产物`,
    );
  }

  public async requestApproval(task: TaskRecord, card: ApprovalCard): Promise<ApprovalChoice> {
    const binding = {
      requestId: card.requestId,
      threadId: card.threadId,
      turnId: card.turnId,
      itemId: card.itemId,
    };
    const token = this.approvalManager.create(binding, card.expiresAt);
    const details = [
      `<b>需要审批 · ${escapeHtml(task.id.slice(0, 8))}</b>`,
      `项目：${escapeHtml(card.project.name)}`,
      `目录：<code>${escapeHtml(card.cwd ?? card.project.rootPath)}</code>`,
      card.command ? `命令：<code>${escapeHtml(card.command.slice(0, 1800))}</code>` : "操作：修改文件",
      card.reason ? `原因：${escapeHtml(card.reason.slice(0, 500))}` : "",
      card.grantRoot ? `授权范围：<code>${escapeHtml(card.grantRoot.slice(0, 500))}</code>` : "授权范围：仅本次操作",
      `有效期：${new Date(card.expiresAt).toLocaleString("zh-CN")}`,
    ].filter(Boolean).join("\n");
    await this.api.sendMessage(this.chatId, details, {
      inline_keyboard: [
        [
          { text: "允许一次", callback_data: `approval:${token}:a` },
          { text: "本会话允许", callback_data: `approval:${token}:s` },
        ],
        [
          { text: "拒绝", callback_data: `approval:${token}:d` },
          { text: "取消任务", callback_data: `approval:${token}:c` },
        ],
      ],
    });
    return new Promise<ApprovalChoice>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#approvals.delete(token);
        reject(new Error("审批已过期"));
      }, Math.max(1, card.expiresAt - Date.now()));
      this.#approvals.set(token, { taskId: task.id, binding, resolve, reject, timer });
    });
  }

  public consumeApproval(token: string, decision: ApprovalDecision): void {
    const pending = this.#approvals.get(token);
    if (!pending) throw new Error("审批动作不存在或已过期");
    const consumed = this.approvalManager.consume(token, pending.binding, decision);
    clearTimeout(pending.timer);
    this.#approvals.delete(token);
    pending.resolve(consumed);
  }

  public async requestInput(
    task: TaskRecord,
    request: ServerRequest<RequestUserInputParams>,
  ): Promise<Record<string, string[]>> {
    if (request.params.questions.length === 0) throw new Error("App Server 提问缺少问题内容");
    if (request.params.questions.some((question) => question.isSecret)) {
      throw new Error("敏感输入禁止通过非端到端加密的 Telegram 收集，请回到主机 Codex 完成");
    }
    const messageIds = new Map<number, string>();
    const inputTokens = new Map<string, string>();
    for (const question of request.params.questions) {
      const inputToken = question.options
        ? this.approvalManager.create({
            requestId: `input:${String(request.id)}:${question.id}`,
            threadId: request.params.threadId,
            turnId: request.params.turnId,
            itemId: question.id,
          }, Date.now() + (request.params.autoResolutionMs ?? 30 * 60_000))
        : null;
      if (inputToken) inputTokens.set(inputToken, question.id);
      const sent = await this.api.sendMessage(
        this.chatId,
        `<b>${escapeHtml(question.header)}</b>\n${escapeHtml(question.question)}\n\n${question.options ? "请选择：" : "请直接回复此消息。"}`,
        question.options ? {
          inline_keyboard: question.options.map((option, index) => [{
            text: option.label,
            callback_data: `input:${inputToken}:${index}`,
          }]),
        } : undefined,
      );
      messageIds.set(sent.message_id, question.id);
    }
    return new Promise<Record<string, string[]>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#inputs.delete(String(request.id));
        reject(new Error("等待用户输入超时"));
      }, request.params.autoResolutionMs ?? 30 * 60_000);
      this.#inputs.set(String(request.id), {
        taskId: task.id,
        messageIds,
        request,
        answers: {},
        inputTokens,
        resolve,
        reject,
        timer,
      });
    });
  }

  public answerTextInput(replyToMessageId: number, text: string): boolean {
    const match = [...this.#inputs.entries()].find(([, input]) => input.messageIds.has(replyToMessageId));
    if (!match) return false;
    const [requestId, input] = match;
    const questionId = input.messageIds.get(replyToMessageId);
    const question = input.request.params.questions.find((candidate) => candidate.id === questionId);
    if (!question) return false;
    input.answers[question.id] = [text];
    this.#resolveInputIfComplete(requestId, input);
    return true;
  }

  public answerChoiceInput(token: string, optionIndex: number): void {
    const match = [...this.#inputs.entries()].find(([, pending]) => pending.inputTokens.has(token));
    if (!match) throw new Error("选择题按钮不存在或已过期");
    const [requestId, input] = match;
    const questionId = input.inputTokens.get(token);
    const question = input.request.params.questions.find((candidate) => candidate.id === questionId);
    const option = question?.options?.[optionIndex];
    if (!question || !option) throw new Error("选择题按钮不存在或已过期");
    this.approvalManager.consume(token, {
      requestId: `input:${String(input.request.id)}:${question.id}`,
      threadId: input.request.params.threadId,
      turnId: input.request.params.turnId,
      itemId: question.id,
    }, "accept");
    input.answers[question.id] = [option.label];
    this.#resolveInputIfComplete(requestId, input);
  }

  #resolveInputIfComplete(requestId: string, input: PendingInput): void {
    if (Object.keys(input.answers).length < input.request.params.questions.length) return;
    clearTimeout(input.timer);
    this.#inputs.delete(requestId);
    input.resolve(input.answers);
  }

  public cancelTask(taskId: string, reason: string): void {
    for (const [token, pending] of this.#approvals) {
      if (pending.taskId === taskId) {
        clearTimeout(pending.timer);
        this.#approvals.delete(token);
        pending.reject(new Error(reason));
      }
    }
    for (const [requestId, pending] of this.#inputs) {
      if (pending.taskId === taskId) {
        clearTimeout(pending.timer);
        this.#inputs.delete(requestId);
        pending.reject(new Error(reason));
      }
    }
    this.#progress.delete(taskId);
    void this.#removeToolCard(taskId).catch((error: unknown) => {
      this.logger.error({ taskId, error: error instanceof Error ? error.message : String(error) }, "删除 Telegram 工具卡片失败");
    });
  }

  async #removeToolCard(taskId: string): Promise<void> {
    const card = this.#toolCards.get(taskId);
    if (!card) return;
    await card.operation;
    this.#toolCards.delete(taskId);
    if (card.messageId !== null) await this.#deleteToolCardMessage(taskId, card.messageId);
  }

  async #deleteToolCardMessage(taskId: string, messageId: number): Promise<void> {
    try {
      await this.api.deleteMessage(this.chatId, messageId);
    } catch (error) {
      this.logger.warn({
        taskId,
        messageId,
        error: error instanceof Error ? error.message : String(error),
      }, "删除 Telegram 工具卡片失败");
    }
  }
}
