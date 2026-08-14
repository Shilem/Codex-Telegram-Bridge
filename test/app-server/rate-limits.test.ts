import { describe, expect, it, vi } from "vitest";

import type { AppServerClient } from "../../src/app-server/client.js";
import { CodexRateLimitProvider } from "../../src/app-server/rate-limits.js";

describe("Codex 剩余额度", () => {
  it("读取官方 rateLimits 接口并展示剩余比例和重置时间", async () => {
    const request = vi.fn((method: string) => Promise.resolve(method === "account/read"
      ? { account: { type: "chatgpt", email: "user@example.com", planType: "pro" }, requiresOpenaiAuth: true }
      : {
          rateLimits: {
            limitId: "codex",
            limitName: "Codex",
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
            secondary: { usedPercent: 40.5, windowDurationMins: 10_080, resetsAt: 1_800_086_400 },
            rateLimitReachedType: null,
          },
          rateLimitsByLimitId: null,
          rateLimitResetCredits: { availableCount: 2 },
        }));
    const provider = new CodexRateLimitProvider({ request } as unknown as AppServerClient);

    const rendered = await provider.render();

    expect(request).toHaveBeenCalledWith("account/read", { refreshToken: false });
    expect(request).toHaveBeenCalledWith("account/rateLimits/read", {});
    expect(rendered).toContain("账户：ChatGPT Pro");
    expect(rendered).toContain("5 小时窗口：剩余 75%（已用 25%）");
    expect(rendered).toContain("1 周窗口：剩余 59.5%（已用 40.5%）");
    expect(rendered).toContain("可用额度重置券：2");
  });

  it("API Key 账户不调用只适用于 ChatGPT 的额度接口", async () => {
    const request = vi.fn((method: string) => Promise.resolve(method === "account/read"
      ? { account: { type: "apiKey" }, requiresOpenaiAuth: true }
      : { rateLimits: null }));
    const appServer = {
      request,
    } as unknown as AppServerClient;
    const rendered = await new CodexRateLimitProvider(appServer).render();
    expect(rendered).toContain("账户：OpenAI API Key");
    expect(rendered).toContain("请到 OpenAI Platform 查看");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("ChatGPT 账户没有额度桶时明确说明上游未返回数据", async () => {
    const appServer = {
      request: vi.fn((method: string) => Promise.resolve(method === "account/read"
        ? { account: { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: true }
        : { rateLimits: null })),
    } as unknown as AppServerClient;

    await expect(new CodexRateLimitProvider(appServer).render()).resolves.toContain("未返回可用的额度信息");
  });

  it("兼容协议允许缺少窗口时长和重置时间的额度数据", async () => {
    const appServer = {
      request: vi.fn((method: string) => Promise.resolve(method === "account/read"
        ? { account: { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: true }
        : {
            rateLimits: {
              limitId: null,
              primary: { usedPercent: 10, windowDurationMins: null, resetsAt: null },
            },
          })),
    } as unknown as AppServerClient;

    await expect(new CodexRateLimitProvider(appServer).render()).resolves.toContain(
      "额度窗口：剩余 90%（已用 10%），重置时间未提供",
    );
  });

  it("识别 Enterprise 账户并展示 monthly individualLimit", async () => {
    const appServer = {
      request: vi.fn((method: string) => Promise.resolve(method === "account/read"
        ? { account: { type: "chatgpt", email: "employee@example.com", planType: "business" }, requiresOpenaiAuth: true }
        : {
            rateLimits: null,
            rateLimitsByLimitId: {
              codex: {
                limitId: "codex",
                limitName: null,
                primary: null,
                secondary: null,
                planType: "business",
                credits: { hasCredits: true, unlimited: false, balance: null },
                individualLimit: {
                  limit: "35000",
                  used: "25065.49",
                  remainingPercent: 28,
                  resetsAt: 1_788_220_801,
                },
                spendControlReached: false,
              },
            },
            rateLimitResetCredits: { availableCount: 0 },
          })),
    } as unknown as AppServerClient;

    const rendered = await new CodexRateLimitProvider(appServer).render();

    expect(rendered).toContain("账户：Enterprise");
    expect(rendered).toContain("工作区点数：可用");
    expect(rendered).toContain("月度额度：剩余 28%");
    expect(rendered).toContain("额度用量：已用 25,065 / 35,000 点");
    expect(rendered).not.toContain("employee@example.com");
  });
});
