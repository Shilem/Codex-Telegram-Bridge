import { describe, expect, it, vi } from "vitest";

import type { AppServerClient } from "../../src/app-server/client.js";
import { CodexRateLimitProvider } from "../../src/app-server/rate-limits.js";

describe("Codex 剩余额度", () => {
  it("读取官方 rateLimits 接口并展示剩余比例和重置时间", async () => {
    const request = vi.fn(() => Promise.resolve({
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

    expect(request).toHaveBeenCalledWith("account/rateLimits/read", {});
    expect(rendered).toContain("5 小时窗口：剩余 75%（已用 25%）");
    expect(rendered).toContain("1 周窗口：剩余 59.5%（已用 40.5%）");
    expect(rendered).toContain("可用额度重置券：2");
  });

  it("没有额度窗口时明确说明未返回数据", async () => {
    const appServer = { request: vi.fn(() => Promise.resolve({ rateLimits: null })) } as unknown as AppServerClient;
    await expect(new CodexRateLimitProvider(appServer).render()).resolves.toContain("未返回可用的额度窗口");
  });

  it("兼容协议允许缺少窗口时长和重置时间的额度数据", async () => {
    const appServer = {
      request: vi.fn(() => Promise.resolve({
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
});
