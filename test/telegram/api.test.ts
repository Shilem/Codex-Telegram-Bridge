import { afterEach, describe, expect, it, vi } from "vitest";

import { TelegramApi } from "../../src/telegram/api.js";

afterEach(() => {
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
});
