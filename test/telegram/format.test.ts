import { describe, expect, it } from "vitest";

import { commandName, escapeHtml, splitTelegramText } from "../../src/telegram/format.js";

describe("Telegram 文本格式", () => {
  it("转义 HTML 并解析带 bot 名的命令", () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
    expect(commandName(" /HEALTH@my_bot now ")).toBe("health");
  });

  it("按 Telegram 上限拆分长消息", () => {
    const chunks = splitTelegramText(`${"甲".repeat(2500)}\n${"乙".repeat(2500)}`);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.length <= 4096)).toBe(true);
    expect(chunks.join("")).toBe(`${"甲".repeat(2500)}${"乙".repeat(2500)}`);
  });
});
