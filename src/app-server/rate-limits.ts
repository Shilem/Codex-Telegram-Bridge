import type { AppServerClient } from "./client.js";

interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

interface CreditSnapshot {
  hasCredits?: boolean;
  unlimited?: boolean;
  balance?: string | null;
}

interface RateLimitSnapshot {
  limitId: string | null;
  limitName?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  planType?: string | null;
  credits?: CreditSnapshot | null;
  rateLimitReachedType?: string | null;
}

interface RateLimitsResponse {
  rateLimits: RateLimitSnapshot | null;
  rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null;
  rateLimitResetCredits?: { availableCount: number } | null;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatDuration(minutes: number): string {
  if (minutes % 10_080 === 0) return `${minutes / 10_080} 周`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

function renderWindow(window: RateLimitWindow): string {
  if (!Number.isFinite(window.usedPercent)) throw new Error("Codex App Server 返回的额度用量格式无效");
  if (window.windowDurationMins !== null && !Number.isFinite(window.windowDurationMins)) {
    throw new Error("Codex App Server 返回的额度窗口时长格式无效");
  }
  if (window.resetsAt !== null && !Number.isFinite(window.resetsAt)) {
    throw new Error("Codex App Server 返回的额度重置时间格式无效");
  }
  const remaining = Math.max(0, 100 - window.usedPercent);
  const duration = window.windowDurationMins === null ? "额度窗口" : `${formatDuration(window.windowDurationMins)}窗口`;
  const reset = window.resetsAt === null
    ? "重置时间未提供"
    : `${new Date(window.resetsAt * 1000).toLocaleString("zh-CN", { hour12: false })} 重置`;
  return `${duration}：剩余 ${formatPercent(remaining)}%（已用 ${formatPercent(window.usedPercent)}%），${reset}`;
}

function renderCredits(credits: CreditSnapshot): string | null {
  if (credits.unlimited) return "工作区点数：无限";
  if (credits.balance !== null && credits.balance !== undefined) return `工作区点数余额：${escapeHtml(credits.balance)}`;
  if (credits.hasCredits !== undefined) return `工作区点数：${credits.hasCredits ? "可用" : "已用尽"}`;
  return null;
}

export class CodexRateLimitProvider {
  public constructor(private readonly appServer: AppServerClient) {}

  public async render(): Promise<string> {
    const response = await this.appServer.request<RateLimitsResponse>("account/rateLimits/read", {});
    const buckets = response.rateLimitsByLimitId && Object.keys(response.rateLimitsByLimitId).length > 0
      ? Object.values(response.rateLimitsByLimitId)
      : response.rateLimits ? [response.rateLimits] : [];
    if (buckets.length === 0) return "<b>Codex 剩余额度</b>\n当前账户未返回可用的额度窗口。";

    const sections = buckets.map((bucket) => {
      const title = bucket.limitName ?? bucket.limitId ?? "Codex";
      const lines = [`<b>${escapeHtml(title)}</b>`];
      if (bucket.planType) lines.push(`套餐：${escapeHtml(bucket.planType)}`);
      if (bucket.primary) lines.push(renderWindow(bucket.primary));
      if (bucket.secondary) lines.push(renderWindow(bucket.secondary));
      if (bucket.credits) {
        const credits = renderCredits(bucket.credits);
        if (credits) lines.push(credits);
      }
      if (bucket.rateLimitReachedType) lines.push(`限额状态：${escapeHtml(bucket.rateLimitReachedType)}`);
      return lines.join("\n");
    });
    const resetCredits = response.rateLimitResetCredits
      ? `\n可用额度重置券：${response.rateLimitResetCredits.availableCount}`
      : "";
    return `<b>Codex 剩余额度</b>\n\n${sections.join("\n\n")}${resetCredits}`;
  }
}
