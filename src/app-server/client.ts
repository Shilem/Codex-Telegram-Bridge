import type {
  CommandApprovalDecision,
  FileChangeApprovalDecision,
  InitializeParams,
  InitializeResponse,
  JsonRpcErrorObject,
  JsonValue,
  RequestId,
  ServerNotification,
  ServerRequest,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  TurnInterruptParams,
  TurnStartParams,
  TurnStartResponse,
} from "./types.js";
import { ProcessAppServerTransport, type AppServerTransport, type Unsubscribe } from "./transport.js";

export interface AppServerLogger {
  readonly debug: (fields: Record<string, unknown>, message: string) => void;
  readonly info: (fields: Record<string, unknown>, message: string) => void;
  readonly warn: (fields: Record<string, unknown>, message: string) => void;
  readonly error: (fields: Record<string, unknown>, message: string) => void;
}

export interface AppServerClientOptions {
  logger: AppServerLogger;
  transport?: AppServerTransport;
  requestTimeoutMs?: number;
  clientInfo?: InitializeParams["clientInfo"];
  capabilities?: InitializeParams["capabilities"];
}

type ClientState = "idle" | "starting" | "ready" | "closing" | "closed" | "failed";
type ServerRequestHandler = (request: ServerRequest) => unknown;

interface PendingRequest {
  method: string;
  startedAtMs: number;
  timer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

interface JsonRpcResponse {
  id: RequestId;
  result?: unknown;
  error?: JsonRpcErrorObject;
}

export class AppServerRpcError extends Error {
  readonly code: number;
  readonly data: JsonValue | undefined;

  constructor(error: JsonRpcErrorObject) {
    super(`Codex App Server RPC 错误 ${String(error.code)}: ${error.message}`);
    this.name = "AppServerRpcError";
    this.code = error.code;
    this.data = error.data;
  }
}

export class AppServerProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AppServerProtocolError";
  }
}

export class AppServerExitedError extends Error {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(code: number | null, signal: NodeJS.Signals | null) {
    super(`Codex App Server 意外退出（code=${String(code)}, signal=${String(signal)}）`);
    this.name = "AppServerExitedError";
    this.code = code;
    this.signal = signal;
  }
}

export class AppServerRequestTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`Codex App Server 请求超时：${method}（${String(timeoutMs)}ms）`);
    this.name = "AppServerRequestTimeoutError";
  }
}

export class AppServerClient {
  readonly #logger: AppServerLogger;
  readonly #transport: AppServerTransport;
  readonly #requestTimeoutMs: number;
  readonly #clientInfo: InitializeParams["clientInfo"];
  readonly #capabilities: InitializeParams["capabilities"];
  readonly #pending = new Map<RequestId, PendingRequest>();
  readonly #notificationListeners = new Set<(notification: ServerNotification) => void>();
  readonly #diagnosticListeners = new Set<(diagnostic: string) => void>();
  readonly #fatalListeners = new Set<(error: Error) => void>();
  readonly #serverRequestHandlers = new Map<string, ServerRequestHandler>();
  readonly #transportSubscriptions: Unsubscribe[] = [];
  #nextRequestId = 1;
  #state: ClientState = "idle";
  #expectedExit = false;
  #initializeResponse: InitializeResponse | undefined;

  constructor(options: AppServerClientOptions) {
    this.#logger = options.logger;
    this.#transport = options.transport ?? new ProcessAppServerTransport();
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#clientInfo = options.clientInfo ?? {
      name: "codex-telegram-bridge",
      title: "Codex Telegram Bridge",
      version: "1.0.0",
    };
    this.#capabilities = options.capabilities ?? {
      experimentalApi: true,
      requestAttestation: false,
    };
  }

  get state(): ClientState {
    return this.#state;
  }

  get serverInfo(): InitializeResponse | undefined {
    return this.#initializeResponse;
  }

  async start(): Promise<InitializeResponse> {
    if (this.#state !== "idle") throw new Error(`App Server 客户端状态不允许启动：${this.#state}`);
    this.#state = "starting";
    this.#expectedExit = false;
    this.#subscribeTransport();
    try {
      await this.#transport.start();
      const initialized = await this.request<InitializeResponse>("initialize", {
        clientInfo: this.#clientInfo,
        capabilities: this.#capabilities,
      });
      this.#assertInitializeResponse(initialized);
      await this.#transport.writeLine(JSON.stringify({ method: "initialized" }));
      this.#initializeResponse = initialized;
      this.#state = "ready";
      this.#logger.info(
        { userAgent: initialized.userAgent, platformOs: initialized.platformOs },
        "Codex App Server 初始化完成",
      );
      return initialized;
    } catch (error) {
      this.#state = "failed";
      this.#rejectPending(this.#asError(error));
      await this.#transport.stop().catch((stopError: unknown) => {
        this.#logger.error({ error: this.#asError(stopError).message }, "停止失败的 App Server 子进程时出错");
      });
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#state === "closed") return;
    this.#expectedExit = true;
    this.#state = "closing";
    this.#rejectPending(new Error("Codex App Server 客户端已关闭"));
    await this.#transport.stop();
    for (const unsubscribe of this.#transportSubscriptions.splice(0)) unsubscribe();
    this.#state = "closed";
    this.#logger.info({}, "Codex App Server 客户端已关闭");
  }

  onNotification(listener: (notification: ServerNotification) => void): Unsubscribe {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  onDiagnostic(listener: (diagnostic: string) => void): Unsubscribe {
    this.#diagnosticListeners.add(listener);
    return () => this.#diagnosticListeners.delete(listener);
  }

  onFatal(listener: (error: Error) => void): Unsubscribe {
    this.#fatalListeners.add(listener);
    return () => this.#fatalListeners.delete(listener);
  }

  setServerRequestHandler(method: string, handler: ServerRequestHandler): Unsubscribe {
    this.#serverRequestHandlers.set(method, handler);
    return () => {
      if (this.#serverRequestHandlers.get(method) === handler) this.#serverRequestHandlers.delete(method);
    };
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    if (this.#state !== "starting" && this.#state !== "ready") {
      throw new Error(`App Server 客户端当前不可请求：${this.#state}`);
    }
    const id = this.#nextRequestId++;
    const startedAtMs = Date.now();
    const result = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        const error = new AppServerRequestTimeoutError(method, this.#requestTimeoutMs);
        this.#logger.error({ method, requestId: id, elapsedMs: Date.now() - startedAtMs }, error.message);
        reject(error);
      }, this.#requestTimeoutMs);
      this.#pending.set(id, {
        method,
        startedAtMs,
        timer,
        resolve: (value) => {
          resolve(value as T);
        },
        reject,
      });
    });

    try {
      await this.#transport.writeLine(JSON.stringify({ id, method, params }));
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        pending.reject(this.#asError(error));
      }
    }
    return result;
  }

  startThread(params: ThreadStartParams): Promise<ThreadStartResponse> {
    return this.request("thread/start", params);
  }

  resumeThread(params: ThreadResumeParams): Promise<ThreadResumeResponse> {
    return this.request("thread/resume", params);
  }

  startTurn(params: TurnStartParams): Promise<TurnStartResponse> {
    return this.request("turn/start", params);
  }

  interruptTurn(params: TurnInterruptParams): Promise<Record<string, never>> {
    return this.request("turn/interrupt", params);
  }

  respondCommandApproval(requestId: RequestId, decision: CommandApprovalDecision): Promise<void> {
    return this.#sendResult(requestId, { decision });
  }

  respondFileChangeApproval(requestId: RequestId, decision: FileChangeApprovalDecision): Promise<void> {
    return this.#sendResult(requestId, { decision });
  }

  respondUserInput(requestId: RequestId, answers: Record<string, string[]>): Promise<void> {
    const mapped = Object.fromEntries(Object.entries(answers).map(([questionId, values]) => [questionId, { answers: values }]));
    return this.#sendResult(requestId, { answers: mapped });
  }

  #subscribeTransport(): void {
    this.#transportSubscriptions.push(
      this.#transport.onLine((line) => {
        this.#handleLine(line);
      }),
      this.#transport.onStderr((text) => {
        this.#logger.warn({ source: "codex-app-server-stderr", text }, "Codex App Server 标准错误输出");
        for (const listener of this.#diagnosticListeners) listener(text);
      }),
      this.#transport.onExit((code, signal) => {
        this.#handleExit(code, signal);
      }),
    );
  }

  #handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch (error) {
      this.#failProtocol(new AppServerProtocolError("Codex App Server 返回了无效 JSON 行", { cause: error }));
      return;
    }
    if (!this.#isObject(message)) {
      this.#failProtocol(new AppServerProtocolError("Codex App Server 返回的消息不是对象"));
      return;
    }

    if (typeof message.method === "string") {
      if (this.#isRequestId(message.id)) {
        void this.#handleServerRequest(message as unknown as ServerRequest).catch((error: unknown) => {
          this.#failProtocol(new AppServerProtocolError("处理 App Server 服务端请求时通信失败", {
            cause: error,
          }));
        });
      }
      else this.#handleNotification(message);
      return;
    }
    if (this.#isRequestId(message.id) && ("result" in message || "error" in message)) {
      this.#handleResponse(message as unknown as JsonRpcResponse);
      return;
    }
    this.#failProtocol(new AppServerProtocolError("Codex App Server 返回了无法识别的 JSON-RPC 消息"));
  }

  #handleResponse(response: JsonRpcResponse): void {
    const pending = this.#pending.get(response.id);
    if (pending === undefined) {
      this.#logger.warn({ requestId: response.id }, "收到未知或已超时的 App Server 响应");
      return;
    }
    clearTimeout(pending.timer);
    this.#pending.delete(response.id);
    const elapsedMs = Date.now() - pending.startedAtMs;
    if (response.error !== undefined) {
      const error = new AppServerRpcError(response.error);
      this.#logger.error({ method: pending.method, requestId: response.id, elapsedMs, code: error.code }, error.message);
      pending.reject(error);
      return;
    }
    this.#logger.debug({ method: pending.method, requestId: response.id, elapsedMs }, "App Server 请求完成");
    pending.resolve(response.result);
  }

  #handleNotification(message: Record<string, unknown>): void {
    if (!("params" in message)) {
      this.#failProtocol(new AppServerProtocolError(`App Server 通知缺少 params：${String(message.method)}`));
      return;
    }
    const notification: ServerNotification = {
      method: message.method as string,
      params: message.params,
      ...(typeof message.emittedAtMs === "number" ? { emittedAtMs: message.emittedAtMs } : {}),
    };
    this.#logger.debug({ method: notification.method, emittedAtMs: notification.emittedAtMs }, "收到 App Server 通知");
    for (const listener of this.#notificationListeners) listener(notification);
  }

  async #handleServerRequest(request: ServerRequest): Promise<void> {
    const handler = this.#serverRequestHandlers.get(request.method);
    if (handler === undefined) {
      this.#logger.error({ method: request.method, requestId: request.id }, "没有处理 App Server 服务端请求的处理器");
      await this.#sendError(request.id, -32601, `未注册服务端请求处理器：${request.method}`);
      return;
    }
    try {
      const result = await handler(request);
      await this.#sendResult(request.id, result);
    } catch (error) {
      const safeError = this.#asError(error);
      this.#logger.error({ method: request.method, requestId: request.id, error: safeError.message }, "处理 App Server 服务端请求失败");
      await this.#sendError(request.id, -32000, safeError.message);
    }
  }

  #sendResult(requestId: RequestId, result: unknown): Promise<void> {
    return this.#transport.writeLine(JSON.stringify({ id: requestId, result }));
  }

  #sendError(requestId: RequestId, code: number, message: string): Promise<void> {
    return this.#transport.writeLine(JSON.stringify({ id: requestId, error: { code, message } }));
  }

  #handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#expectedExit || this.#state === "closed") return;
    const error = new AppServerExitedError(code, signal);
    this.#state = "failed";
    this.#logger.error({ code, signal, pendingRequests: this.#pending.size }, error.message);
    this.#rejectPending(error);
    for (const listener of this.#fatalListeners) listener(error);
  }

  #failProtocol(error: AppServerProtocolError): void {
    if (this.#state === "failed" || this.#state === "closed") return;
    this.#state = "failed";
    this.#logger.error({ error: error.message, pendingRequests: this.#pending.size }, "App Server 协议失败");
    this.#rejectPending(error);
    for (const listener of this.#fatalListeners) listener(error);
    void this.#transport.stop().catch((stopError: unknown) => {
      this.#logger.error({ error: this.#asError(stopError).message }, "协议失败后停止 App Server 出错");
    });
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #assertInitializeResponse(value: InitializeResponse): asserts value is InitializeResponse {
    if (
      !this.#isObject(value) ||
      typeof value.userAgent !== "string" ||
      typeof value.codexHome !== "string" ||
      typeof value.platformFamily !== "string" ||
      typeof value.platformOs !== "string"
    ) {
      throw new AppServerProtocolError("Codex App Server initialize 响应字段不完整");
    }
  }

  #isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  #isRequestId(value: unknown): value is RequestId {
    return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
  }

  #asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }
}
