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

interface IndividualLimitSnapshot {
  limit: string;
  used: string;
  remainingPercent: number;
  resetsAt: number;
}

interface RateLimitSnapshot {
  limitId: string | null;
  limitName?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  planType?: string | null;
  credits?: CreditSnapshot | null;
  individualLimit?: IndividualLimitSnapshot | null;
  spendControlReached?: boolean | null;
  rateLimitReachedType?: string | null;
}

interface RateLimitsResponse {
  rateLimits: RateLimitSnapshot | null;
  rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null;
  rateLimitResetCredits?: { availableCount: number } | null;
}

type AccountSnapshot =
  | { type: "apiKey" }
  | { type: "chatgpt"; planType: string; email: string | null }
  | { type: "amazonBedrock" };

interface AccountResponse {
  account?: AccountSnapshot | null;
  requiresOpenaiAuth: boolean;
}

const planLabels: Readonly<Record<string, string>> = {
  free: "ChatGPT Free",
  go: "ChatGPT Go",
  plus: "ChatGPT Plus",
  pro: "ChatGPT Pro",
  prolite: "ChatGPT Pro Lite",
  team: "ChatGPT Team",
  self_serve_business_prolite: "Business Pro Lite",
  self_serve_business_usage_based: "Business（按量计费）",
  business: "Enterprise",
  ent26: "Enterprise",
  enterprise_cbp_automation: "Enterprise（Automation）",
  enterprise_cbp_usage_based: "Enterprise（按量计费）",
  enterprise: "Enterprise",
  edu: "ChatGPT Education",
  unknown: "ChatGPT（套餐未知）",
};

const enterprisePlans = new Set([
  "business",
  "ent26",
  "enterprise_cbp_automation",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
]);

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

function renderAccount(account: AccountSnapshot | null | undefined): { label: string; planType: string | null } {
  if (!account) return { label: "未返回账户信息", planType: null };
  if (account.type === "apiKey") return { label: "OpenAI API Key", planType: null };
  if (account.type === "amazonBedrock") return { label: "Amazon Bedrock", planType: null };
  return {
    label: planLabels[account.planType] ?? `ChatGPT（${account.planType}）`,
    planType: account.planType,
  };
}

function formatCreditValue(value: string, field: string): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new Error(`Codex App Server 返回的${field}格式无效`);
  }
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(Math.round(numeric));
}

function renderIndividualLimit(limit: IndividualLimitSnapshot, monthly: boolean): string[] {
  if (
    !Number.isFinite(limit.remainingPercent)
    || limit.remainingPercent < 0
    || limit.remainingPercent > 100
    || !Number.isFinite(limit.resetsAt)
    || limit.resetsAt <= 0
  ) {
    throw new Error("Codex App Server 返回的账户额度格式无效");
  }
  const label = monthly ? "月度额度" : "账户额度";
  const reset = new Date(limit.resetsAt * 1000).toLocaleString("zh-CN", { hour12: false });
  return [
    `${label}：剩余 ${formatPercent(limit.remainingPercent)}%，${reset} 重置`,
    `额度用量：已用 ${formatCreditValue(limit.used, "已用额度")} / ${formatCreditValue(limit.limit, "额度上限")} 点`,
  ];
}

export class CodexRateLimitProvider {
  public constructor(private readonly appServer: AppServerClient) {}

  public async render(): Promise<string> {
    const accountResponse = await this.appServer.request<AccountResponse>("account/read", { refreshToken: false });
    const account = renderAccount(accountResponse.account);
    const heading = `<b>Codex 剩余额度</b>\n账户：${escapeHtml(account.label)}`;
    if (!accountResponse.account) {
      return `${heading}\n当前没有可查询的 ChatGPT 账户。`;
    }
    if (accountResponse.account.type === "apiKey") {
      return `${heading}\nAPI Key 用量和限额不由 Codex 的 ChatGPT 额度接口提供，请到 OpenAI Platform 查看。`;
    }
    if (accountResponse.account.type === "amazonBedrock") {
      return `${heading}\nAmazon Bedrock 用量和限额不由 Codex 的 ChatGPT 额度接口提供，请到 AWS 查看。`;
    }

    const response = await this.appServer.request<RateLimitsResponse>("account/rateLimits/read", {});
    const buckets = response.rateLimitsByLimitId && Object.keys(response.rateLimitsByLimitId).length > 0
      ? Object.values(response.rateLimitsByLimitId)
      : response.rateLimits ? [response.rateLimits] : [];
    if (buckets.length === 0) return `${heading}\n当前账户未返回可用的额度信息。`;

    const sections = buckets.map((bucket) => {
      const title = bucket.limitName ?? (bucket.limitId === "codex" ? "Codex" : bucket.limitId) ?? "Codex";
      const lines = [`<b>${escapeHtml(title)}</b>`];
      if (bucket.primary) lines.push(renderWindow(bucket.primary));
      if (bucket.secondary) lines.push(renderWindow(bucket.secondary));
      if (bucket.credits) {
        const credits = renderCredits(bucket.credits);
        if (credits) lines.push(credits);
      }
      if (bucket.individualLimit) {
        const planType = account.planType ?? bucket.planType ?? null;
        lines.push(...renderIndividualLimit(bucket.individualLimit, planType !== null && enterprisePlans.has(planType)));
      }
      if (bucket.spendControlReached === true) lines.push("账户额度状态：已达到上限");
      if (bucket.rateLimitReachedType) lines.push(`限额状态：${escapeHtml(bucket.rateLimitReachedType)}`);
      return lines.join("\n");
    });
    const resetCredits = response.rateLimitResetCredits && response.rateLimitResetCredits.availableCount > 0
      ? `\n可用额度重置券：${response.rateLimitResetCredits.availableCount}`
      : "";
    return `${heading}\n\n${sections.join("\n\n")}${resetCredits}`;
  }
}
