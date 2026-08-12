import type { Logger } from "pino";

import type { AppServerClient } from "./client.js";
import type { AvailableModel, ConfigReadResponse, ModelListResponse } from "./types.js";

export interface LocalCodexState {
  model: string | null;
  reasoningEffort: string | null;
  serviceTier: string | null;
}

export interface ModelCatalogHealth {
  lastSuccessfulReadAt: number | null;
  lastRefreshWarningAt: number | null;
  lastRefreshWarning: string | null;
}

export class CodexModelStateProvider {
  #lastSuccessfulReadAt: number | null = null;
  #lastRefreshWarningAt: number | null = null;
  #lastRefreshWarning: string | null = null;
  readonly #unsubscribeDiagnostic: () => void;

  public constructor(
    private readonly appServer: Pick<AppServerClient, "request" | "onDiagnostic">,
    private readonly logger: Logger,
  ) {
    this.#unsubscribeDiagnostic = appServer.onDiagnostic((diagnostic) => {
      if (!diagnostic.includes("failed to refresh available models")) return;
      this.#lastRefreshWarningAt = Date.now();
      this.#lastRefreshWarning = "Codex 模型目录刷新超时，当前继续使用 App Server 已有目录";
      this.logger.warn({ component: "model-catalog" }, this.#lastRefreshWarning);
    });
  }

  public dispose(): void {
    this.#unsubscribeDiagnostic();
  }

  public async list(): Promise<AvailableModel[]> {
    const response = await this.appServer.request<ModelListResponse>("model/list", {
      limit: 100,
      includeHidden: false,
    });
    this.#lastSuccessfulReadAt = Date.now();
    return response.data.filter((model) => !model.hidden);
  }

  public async localState(cwd: string): Promise<LocalCodexState> {
    const response = await this.appServer.request<ConfigReadResponse>("config/read", {
      includeLayers: false,
      cwd,
    });
    return {
      model: response.config.model,
      reasoningEffort: response.config.model_reasoning_effort,
      serviceTier: response.config.service_tier,
    };
  }

  public health(): ModelCatalogHealth {
    return {
      lastSuccessfulReadAt: this.#lastSuccessfulReadAt,
      lastRefreshWarningAt: this.#lastRefreshWarningAt,
      lastRefreshWarning: this.#lastRefreshWarning,
    };
  }
}
