import { afterEach, describe, expect, it, vi } from "vitest";

import { TelegramApi } from "../../src/telegram/api.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Telegram API", () => {
  it("通过 Bot API 删除临时卡片", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      expect(url).toContain("/deleteMessage");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve(new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = new TelegramApi("test-token", { debug: vi.fn(), warn: vi.fn() } as never);

    await expect(api.deleteMessage(10, 42)).resolves.toBe(true);
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    if (typeof body !== "string") throw new Error("删除消息请求体不是 JSON 字符串");
    expect(JSON.parse(body)).toEqual({ chat_id: 10, message_id: 42 });
  });

  it("同步默认与中文私聊菜单，并为普通请求设置硬超时", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve(new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = new TelegramApi("test-token", { debug: vi.fn(), warn: vi.fn() } as never);

    await api.setCommands([{ command: "project", description: "Bridge｜选择项目" }]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = fetchMock.mock.calls[0]?.[1]?.body;
    const secondBody = fetchMock.mock.calls[1]?.[1]?.body;
    if (typeof firstBody !== "string" || typeof secondBody !== "string") throw new Error("命令菜单请求体不是 JSON 字符串");
    const first = JSON.parse(firstBody) as Record<string, unknown>;
    const second = JSON.parse(secondBody) as Record<string, unknown>;
    expect(first).toMatchObject({ scope: { type: "all_private_chats" } });
    expect(first).not.toHaveProperty("language_code");
    expect(second).toMatchObject({ scope: { type: "all_private_chats" }, language_code: "zh" });
  });

  it("同一聊天的消息变更严格串行并保持一秒间隔", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T00:00:00Z"));
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      ok: true,
      result: { message_id: 7 },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    vi.stubGlobal("fetch", fetchMock);
    const api = new TelegramApi("test-token", { debug: vi.fn(), warn: vi.fn() } as never);

    const sent = api.sendMessage(10, "开始");
    const edited = api.editMessage(10, 7, "进度");
    await sent;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await edited;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("按 retry_after 等待，并在持续限流时保留可诊断错误", async () => {
    vi.useFakeTimers();
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      ok: false,
      error_code: 429,
      description: "Too Many Requests",
      parameters: { retry_after: 2 },
    }), { status: 429, headers: { "content-type": "application/json" } })));
    vi.stubGlobal("fetch", fetchMock);
    const api = new TelegramApi("test-token", logger as never);

    const edited = api.editMessage(10, 7, "进度");
    const assertion = expect(edited).rejects.toThrow("触发限流，2 秒后可重试");
    await vi.advanceTimersByTimeAsync(4_000);
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ method: "editMessageText", retryAfterSeconds: 2 }),
      "Telegram API 触发限流",
    );
  });
});
