import { describe, expect, it, vi } from "vitest";

import { CodexModelStateProvider } from "../../src/app-server/model-state.js";

describe("CodexModelStateProvider", () => {
  it("从 App Server 读取本机有效配置和动态服务档位", async () => {
    let diagnostic: ((text: string) => void) | null = null;
    const request = vi.fn((method: string) => {
      if (method === "config/read") {
        return Promise.resolve({ config: { model: "gpt-local", model_reasoning_effort: "low", service_tier: "default" } });
      }
      return Promise.resolve({
        data: [
          { model: "hidden", hidden: true },
          { model: "gpt-local", hidden: false, serviceTiers: [{ id: "priority", name: "Fast", description: "更快" }] },
        ],
        nextCursor: null,
      });
    });
    const provider = new CodexModelStateProvider({
      request,
      onDiagnostic(listener: (text: string) => void) {
        diagnostic = listener;
        return () => { diagnostic = null; };
      },
    } as never, { warn: vi.fn() } as never);

    expect(await provider.localState("/workspace")).toEqual({
      model: "gpt-local",
      reasoningEffort: "low",
      serviceTier: "default",
    });
    expect((await provider.list()).map((model) => model.model)).toEqual(["gpt-local"]);
    expect(provider.health().lastSuccessfulReadAt).not.toBeNull();

    (diagnostic as unknown as (text: string) => void)("failed to refresh available models: timeout");
    expect(provider.health().lastRefreshWarning).toContain("刷新超时");
    provider.dispose();
    expect(diagnostic).toBeNull();
  });
});
