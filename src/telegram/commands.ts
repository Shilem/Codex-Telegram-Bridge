export interface TelegramBotCommand {
  readonly command: string;
  readonly description: string;
}

export const CODEX_COMMANDS: readonly TelegramBotCommand[] = [
  { command: "new", description: "Codex｜为下一条任务创建新会话" },
  { command: "sessions", description: "Codex｜查看当前项目的会话" },
  { command: "tasks", description: "Codex｜查看最近任务及状态" },
  { command: "quota", description: "Codex｜查看剩余额度与重置时间" },
  { command: "plan", description: "Codex｜让后续任务先生成执行计划" },
  { command: "cancel", description: "Codex｜取消当前或指定任务" },
  { command: "stop", description: "Codex｜立即停止当前任务" },
  { command: "model", description: "Codex｜查看或设置模型" },
  { command: "effort", description: "Codex｜查看或设置推理强度" },
  { command: "fast", description: "Codex｜查看或设置 Fast 模式" },
  { command: "permissions", description: "Codex｜查看或切换任务权限" },
];

export const BRIDGE_COMMANDS: readonly TelegramBotCommand[] = [
  { command: "help", description: "Bridge｜查看分组命令帮助" },
  { command: "project", description: "Bridge｜选择并切换项目" },
  { command: "status", description: "Bridge｜查看项目、任务和队列" },
  { command: "ping", description: "Bridge｜检查 Telegram 消息延迟" },
  { command: "health", description: "Bridge｜执行完整健康检查" },
  { command: "cleanup", description: "Bridge｜清理过期本地数据" },
  { command: "update", description: "Bridge｜检查签名版本更新" },
  { command: "restart", description: "Bridge｜安全重启当前 Bridge 服务" },
];

export const TELEGRAM_COMMANDS: readonly TelegramBotCommand[] = [
  ...CODEX_COMMANDS,
  ...BRIDGE_COMMANDS,
];

export function renderCommandHelp(): string {
  const render = (commands: readonly TelegramBotCommand[]): string => commands
    .map(({ command, description }) => `<code>/${command}</code> — ${description.split("｜")[1]}`)
    .join("\n");
  return [
    "<b>Codex 工作流</b>",
    render(CODEX_COMMANDS),
    "<b>Bridge 管理</b>",
    render(BRIDGE_COMMANDS),
    "<b>兼容命令（菜单中隐藏）</b>",
    "<code>/start</code> <code>/projects</code> <code>/resume</code> <code>/handback</code> <code>/retry</code> <code>/version</code>",
  ].join("\n\n");
}
