import { openAsBlob } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import { BridgeError, errorMessage } from "../core/types.js";
import type {
  InlineKeyboardMarkup,
  SentMessage,
  TelegramUpdate,
} from "./types.js";

interface TelegramEnvelope<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

interface TelegramRemoteFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

interface RequestOptions {
  signal?: AbortSignal;
  attempts?: number;
}

export class TelegramApi {
  readonly #apiBase: string;
  readonly #fileBase: string;

  public constructor(
    token: string,
    private readonly logger: Logger,
    apiRoot = "https://api.telegram.org",
  ) {
    this.#apiBase = `${apiRoot}/bot${token}`;
    this.#fileBase = `${apiRoot}/file/bot${token}`;
  }

  async #request<T>(method: string, body: object | FormData, options: RequestOptions = {}): Promise<T> {
    const attempts = options.attempts ?? 3;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const startedAt = performance.now();
      try {
        const requestInit: RequestInit = {
          method: "POST",
          body: body instanceof FormData ? body : JSON.stringify(body),
          ...(body instanceof FormData ? {} : { headers: { "content-type": "application/json" } }),
          ...(options.signal ? { signal: options.signal } : {}),
        };
        const response = await fetch(`${this.#apiBase}/${method}`, requestInit);
        const envelope = (await response.json()) as TelegramEnvelope<T>;
        const elapsedMs = Math.round(performance.now() - startedAt);
        this.logger.debug({ method, elapsedMs, attempt, status: response.status }, "Telegram API 请求完成");
        if (response.status === 429 && envelope.parameters?.retry_after !== undefined) {
          if (attempt === attempts) break;
          const retryAfterSeconds = envelope.parameters.retry_after;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, retryAfterSeconds * 1000));
          continue;
        }
        if (!response.ok || !envelope.ok || envelope.result === undefined) {
          throw new BridgeError(
            `Telegram ${method} 失败：${envelope.description ?? response.statusText}`,
            "TELEGRAM_API_ERROR",
            { status: response.status, errorCode: envelope.error_code },
          );
        }
        return envelope.result;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        this.logger.warn({ method, attempt, error: errorMessage(error) }, "Telegram API 请求失败");
        if (attempt === attempts || error instanceof BridgeError) throw error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 500 * attempt));
      }
    }
    throw new BridgeError(`Telegram ${method} 达到重试上限`, "TELEGRAM_RETRY_EXHAUSTED");
  }

  public getUpdates(offset: number, timeoutSeconds: number, signal: AbortSignal): Promise<TelegramUpdate[]> {
    return this.#request<TelegramUpdate[]>(
      "getUpdates",
      {
        offset,
        timeout: timeoutSeconds,
        allowed_updates: ["message", "callback_query"],
      },
      { signal, attempts: 1 },
    );
  }

  public sendMessage(
    chatId: number,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
    replyToMessageId?: number,
  ): Promise<SentMessage> {
    return this.#request<SentMessage>("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}),
    });
  }

  public editMessage(
    chatId: number,
    messageId: number,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<SentMessage> {
    return this.#request<SentMessage>("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  public answerCallback(callbackQueryId: string, text?: string, showAlert = false): Promise<boolean> {
    return this.#request<boolean>("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
      show_alert: showAlert,
    });
  }

  public async downloadFile(
    fileId: string,
    declaredSize: number | undefined,
    destinationDirectory: string,
    fileName: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<string> {
    if (declaredSize !== undefined && declaredSize > maxBytes) {
      throw new BridgeError(`附件声明大小超过 ${maxBytes} 字节限制`, "ATTACHMENT_DECLARED_TOO_LARGE");
    }
    const remote = await this.#request<TelegramRemoteFile>(
      "getFile",
      { file_id: fileId },
      signal ? { signal } : {},
    );
    if (!remote.file_path) throw new BridgeError("Telegram 未返回附件路径", "ATTACHMENT_PATH_MISSING");
    if (remote.file_size !== undefined && remote.file_size > maxBytes) {
      throw new BridgeError(`附件大小超过 ${maxBytes} 字节限制`, "ATTACHMENT_REMOTE_TOO_LARGE");
    }
    const response = await fetch(
      `${this.#fileBase}/${remote.file_path}`,
      signal ? { signal } : {},
    );
    if (!response.ok || !response.body) {
      throw new BridgeError(`附件下载失败：HTTP ${response.status}`, "ATTACHMENT_DOWNLOAD_FAILED");
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await response.body.cancel();
      throw new BridgeError(`附件 Content-Length 超过 ${maxBytes} 字节限制`, "ATTACHMENT_CONTENT_LENGTH_TOO_LARGE");
    }
    await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
    const safeName = basename(fileName).replaceAll(/[^\p{L}\p{N}._-]/gu, "_") || "attachment.bin";
    const finalPath = resolve(destinationDirectory, `${Date.now()}-${randomUUID()}-${safeName}`);
    const temporaryPath = join(dirname(finalPath), `.${basename(finalPath)}.tmp`);
    const handle = await open(temporaryPath, "wx", 0o600);
    let bytes = 0;
    try {
      const reader = response.body.getReader();
      let chunk = await reader.read();
      while (!chunk.done) {
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel();
          throw new BridgeError(`附件实际大小超过 ${maxBytes} 字节限制`, "ATTACHMENT_ACTUAL_TOO_LARGE");
        }
        await handle.write(chunk.value);
        chunk = await reader.read();
      }
      await handle.sync();
      await handle.close();
      await rename(temporaryPath, finalPath);
      return finalPath;
    } catch (error) {
      await handle.close().catch((closeError: unknown) => {
        this.logger.error({ error: errorMessage(closeError), temporaryPath }, "附件失败清理时关闭文件句柄失败");
      });
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  public async sendDocument(chatId: number, filePath: string, maxBytes: number, caption?: string): Promise<SentMessage> {
    const metadata = await stat(filePath);
    if (!metadata.isFile() || metadata.size > maxBytes) {
      throw new BridgeError(`产物不存在或超过 ${maxBytes} 字节限制`, "OUTBOUND_FILE_REJECTED");
    }
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("document", await openAsBlob(filePath), basename(filePath));
    if (caption) form.set("caption", caption);
    return this.#request<SentMessage>("sendDocument", form);
  }
}
