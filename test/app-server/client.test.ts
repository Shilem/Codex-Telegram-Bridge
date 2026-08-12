import { describe, expect, it, vi } from "vitest";

import {
  AppServerClient,
  AppServerExitedError,
  AppServerProtocolError,
  AppServerRequestTimeoutError,
  isPublicAppServerNotification,
  type AppServerLogger,
  type AppServerTransport,
  type ServerNotification,
  type Unsubscribe,
} from "../../src/app-server/index.js";

class FakeTransport implements AppServerTransport {
  readonly lines: string[] = [];
  started = false;
  stopped = false;
  readonly #lineListeners = new Set<(line: string) => void>();
  readonly #stderrListeners = new Set<(text: string) => void>();
  readonly #exitListeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();

  start(): Promise<void> {
    this.started = true;
    return Promise.resolve();
  }

  writeLine(line: string): Promise<void> {
    this.lines.push(line);
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.stopped = true;
    return Promise.resolve();
  }

  onLine(listener: (line: string) => void): Unsubscribe {
    this.#lineListeners.add(listener);
    return () => this.#lineListeners.delete(listener);
  }

  onStderr(listener: (text: string) => void): Unsubscribe {
    this.#stderrListeners.add(listener);
    return () => this.#stderrListeners.delete(listener);
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): Unsubscribe {
    this.#exitListeners.add(listener);
    return () => this.#exitListeners.delete(listener);
  }

  emitLine(message: unknown): void {
    const line = typeof message === "string" ? message : JSON.stringify(message);
    for (const listener of this.#lineListeners) listener(line);
  }

  emitStderr(text: string): void {
    for (const listener of this.#stderrListeners) listener(text);
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    for (const listener of this.#exitListeners) listener(code, signal);
  }
}

function createLogger(): AppServerLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function createReadyClient(options: { timeoutMs?: number } = {}): Promise<{
  client: AppServerClient;
  transport: FakeTransport;
  logger: AppServerLogger;
}> {
  const transport = new FakeTransport();
  const logger = createLogger();
  const client = new AppServerClient({
    logger,
    transport,
    ...(options.timeoutMs === undefined ? {} : { requestTimeoutMs: options.timeoutMs }),
  });
  const started = client.start();
  await flush();
  const request = JSON.parse(transport.lines[0] ?? "null") as { id: number; method: string; params: unknown };
  transport.emitLine({
    id: request.id,
    result: {
      userAgent: "codex-cli/test",
      codexHome: "/tmp/codex-home",
      platformFamily: "unix",
      platformOs: "macos",
    },
  });
  await started;
  return { client, transport, logger };
}

describe("AppServerClient 合约", () => {
  it("以 initialize 为首个请求并发送 initialized 通知", async () => {
    const { client, transport } = await createReadyClient();
    const initialize = JSON.parse(transport.lines[0] ?? "null") as Record<string, unknown>;
    expect(initialize).toMatchObject({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "codex-telegram-bridge", title: "Codex Telegram Bridge", version: "1.0.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
    });
    expect(JSON.parse(transport.lines[1] ?? "null")).toEqual({ method: "initialized" });
    expect(client.state).toBe("ready");
    expect(client.serverInfo?.platformOs).toBe("macos");
    await client.close();
  });

  it("发送 thread/start、thread/resume、turn/start 和 turn/interrupt", async () => {
    const { client, transport } = await createReadyClient();
    const operations = [
      client.startThread({ cwd: "/workspace", sandbox: "workspace-write", approvalPolicy: "on-request" }),
      client.resumeThread({ threadId: "thread-1", cwd: "/workspace" }),
      client.startTurn({
        threadId: "thread-1",
        input: [{ type: "text", text: "检查状态", text_elements: [] }],
        effort: "high",
      }),
      client.interruptTurn({ threadId: "thread-1", turnId: "turn-1" }),
    ];
    await flush();
    const sent = transport.lines.slice(2).map((line) => JSON.parse(line) as { id: number; method: string });
    expect(sent.map((message) => message.method)).toEqual([
      "thread/start",
      "thread/resume",
      "turn/start",
      "turn/interrupt",
    ]);
    for (const message of sent) transport.emitLine({ id: message.id, result: {} });
    await Promise.all(operations);
    await client.close();
  });

  it("按事件顺序分发通知并转发 stderr 诊断", async () => {
    const { client, transport, logger } = await createReadyClient();
    const notifications: ServerNotification[] = [];
    const diagnostics: string[] = [];
    client.onNotification((notification) => notifications.push(notification));
    client.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));

    transport.emitLine({ method: "turn/started", params: { threadId: "t", turn: { id: "1" } }, emittedAtMs: 1 });
    transport.emitLine({ method: "item/agentMessage/delta", params: { delta: "完成" }, emittedAtMs: 2 });
    transport.emitStderr("protocol diagnostic\n");

    expect(notifications.map((event) => event.method)).toEqual(["turn/started", "item/agentMessage/delta"]);
    expect(notifications[0]?.emittedAtMs).toBe(1);
    expect(diagnostics).toEqual(["protocol diagnostic\n"]);
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
    await client.close();
  });

  it("处理命令审批、文件审批和 requestUserInput 服务端请求", async () => {
    const { client, transport } = await createReadyClient();
    client.setServerRequestHandler("item/commandExecution/requestApproval", () => ({ decision: "accept" }));
    client.setServerRequestHandler("item/fileChange/requestApproval", () => ({ decision: "decline" }));
    client.setServerRequestHandler("item/tool/requestUserInput", () => ({
      answers: { scope: { answers: ["当前项目"] } },
    }));

    transport.emitLine({ id: "approval-1", method: "item/commandExecution/requestApproval", params: {} });
    transport.emitLine({ id: "approval-2", method: "item/fileChange/requestApproval", params: {} });
    transport.emitLine({ id: "input-1", method: "item/tool/requestUserInput", params: {} });
    await flush();

    const responses = transport.lines.slice(2).map((line) => JSON.parse(line) as { id: string; result: unknown });
    expect(responses).toEqual([
      { id: "approval-1", result: { decision: "accept" } },
      { id: "approval-2", result: { decision: "decline" } },
      { id: "input-1", result: { answers: { scope: { answers: ["当前项目"] } } } },
    ]);
    await client.close();
  });

  it("拒绝未注册的服务端请求并返回 method not found", async () => {
    const { client, transport } = await createReadyClient();
    transport.emitLine({ id: "unknown-1", method: "item/permissions/requestApproval", params: {} });
    await flush();
    expect(JSON.parse(transport.lines[2] ?? "null")).toEqual({
      id: "unknown-1",
      error: { code: -32601, message: "未注册服务端请求处理器：item/permissions/requestApproval" },
    });
    await client.close();
  });

  it("将 RPC 错误映射为带 code 的异常", async () => {
    const { client, transport } = await createReadyClient();
    const request = client.startTurn({ threadId: "missing", input: [] });
    await flush();
    const sent = JSON.parse(transport.lines[2] ?? "null") as { id: number };
    transport.emitLine({ id: sent.id, error: { code: -32001, message: "thread not found" } });
    await expect(request).rejects.toMatchObject({ code: -32001 });
    await client.close();
  });

  it("请求超时后清理 pending，迟到响应只记录告警", async () => {
    const { client, transport, logger } = await createReadyClient({ timeoutMs: 50 });
    vi.useFakeTimers();
    try {
      const request = client.startTurn({ threadId: "thread-1", input: [] });
      const rejection = expect(request).rejects.toBeInstanceOf(AppServerRequestTimeoutError);
      await vi.advanceTimersByTimeAsync(51);
      await rejection;
      transport.emitLine({ id: 2, result: {} });
      expect(vi.mocked(logger.warn)).toHaveBeenCalled();
      await client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("意外退出会拒绝所有 pending 请求并进入 failed", async () => {
    const { client, transport } = await createReadyClient();
    const pending = client.startTurn({ threadId: "thread-1", input: [] });
    transport.emitExit(7, null);
    await expect(pending).rejects.toBeInstanceOf(AppServerExitedError);
    expect(client.state).toBe("failed");
    await client.close();
  });

  it("无效 JSON 是致命协议错误，不会被静默吞掉", async () => {
    const { client, transport } = await createReadyClient();
    const pending = client.startTurn({ threadId: "thread-1", input: [] });
    transport.emitLine("not-json");
    await expect(pending).rejects.toBeInstanceOf(AppServerProtocolError);
    expect(client.state).toBe("failed");
    expect(transport.stopped).toBe(true);
    await client.close();
  });
});

describe("App Server 通知公开策略", () => {
  it("阻止原始推理和 raw response，仅允许公开摘要与工具事件", () => {
    expect(isPublicAppServerNotification({ method: "item/reasoning/textDelta", params: {} })).toBe(false);
    expect(isPublicAppServerNotification({ method: "rawResponse/completed", params: {} })).toBe(false);
    expect(isPublicAppServerNotification({ method: "item/reasoning/summaryTextDelta", params: {} })).toBe(true);
    expect(isPublicAppServerNotification({ method: "item/commandExecution/outputDelta", params: {} })).toBe(true);
  });
});
