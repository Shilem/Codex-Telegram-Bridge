# #0026 历史问题：Telegram 命令菜单因语言代码无效而启动失败

- 2026-08-14T10:48:09Z `issue`: 历史问题：Telegram 命令菜单因语言代码无效而启动失败 [BUG_LOG.md]
- 2026-08-14T10:48:09Z `attempt`: 历史根因：首次实现 `setMyCommands` 时使用了区域代码 `zh-hans`，但 Telegram Bot API 的 `language_code` 只接受两位 ISO 639-1 代码，返回 `Bad Request: invalid language code specified`。 [BUG_LOG.md] (worked)
- 2026-08-14T10:48:09Z `fix`: 历史修复：简体中文私聊命令菜单统一使用 Telegram 接受的 `zh`，命令描述通过 `Codex｜` 与 `Bridge｜` 前缀分组。；验证：本机启动日志包含“Telegram 私聊命令菜单已同步”，LaunchAgent 保持运行，并在 Telegram `/` 菜单人工确认两组命令。 [BUG_LOG.md]
- 2026-08-14T10:52:40Z `fix`: 历史修复与验证详情已完整归档 [Projectmem 历史问题]
