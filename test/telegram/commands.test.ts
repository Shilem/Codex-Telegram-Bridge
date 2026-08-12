import { describe, expect, it } from "vitest";

import {
  BRIDGE_COMMANDS,
  CODEX_COMMANDS,
  TELEGRAM_COMMANDS,
  renderCommandHelp,
} from "../../src/telegram/commands.js";

describe("Telegram 命令菜单", () => {
  it("按 Codex 与 Bridge 分组并保持命令唯一", () => {
    expect(CODEX_COMMANDS.every(({ description }) => description.startsWith("Codex｜"))).toBe(true);
    expect(BRIDGE_COMMANDS.every(({ description }) => description.startsWith("Bridge｜"))).toBe(true);
    expect(new Set(TELEGRAM_COMMANDS.map(({ command }) => command)).size).toBe(TELEGRAM_COMMANDS.length);
    expect(TELEGRAM_COMMANDS).toHaveLength(14);
    expect(TELEGRAM_COMMANDS.map(({ command }) => command)).toEqual([
      "new", "sessions", "tasks", "model", "effort", "fast", "permissions",
      "help", "project", "status", "ping", "health", "cleanup", "update",
    ]);
  });

  it("帮助文本使用可见分组且覆盖菜单命令", () => {
    const help = renderCommandHelp();
    expect(help).toContain("<b>Codex 工作流</b>");
    expect(help).toContain("<b>Bridge 管理</b>");
    for (const { command } of TELEGRAM_COMMANDS) expect(help).toContain(`<code>/${command}</code>`);
  });
});
