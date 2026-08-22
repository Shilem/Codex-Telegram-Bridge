# #0039 历史问题：macOS 不能使用 Linux 安装脚本

- 2026-08-14T10:48:16Z `issue`: 历史问题：macOS 不能使用 Linux 安装脚本 [BUG_LOG.md]
- 2026-08-14T10:48:16Z `attempt`: 历史根因：早期安装脚本固定写入 systemd 用户服务，而 macOS 用 launchd。 [BUG_LOG.md] (worked)
- 2026-08-14T10:48:16Z `fix`: 历史修复：安装脚本根据平台写入 Linux systemd unit 或 macOS LaunchAgent，并用对应服务管理器重启。；验证：macOS 执行 `launchctl print gui/$(id -u)/com.codex-telegram-bridge.codex`。 [BUG_LOG.md]
- 2026-08-14T10:52:42Z `fix`: 历史修复与验证详情已完整归档 [Projectmem 历史问题]
