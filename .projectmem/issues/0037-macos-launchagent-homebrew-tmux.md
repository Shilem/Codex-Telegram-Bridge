# #0037 历史问题：macOS LaunchAgent 找不到 Homebrew 安装的 tmux

- 2026-08-14T10:48:15Z `issue`: 历史问题：macOS LaunchAgent 找不到 Homebrew 安装的 tmux [BUG_LOG.md]
- 2026-08-14T10:48:15Z `attempt`: 历史根因：launchd 的默认 `PATH` 只有系统目录，不包含 Apple Silicon Homebrew 的 `/opt/homebrew/bin`；桥接进程启动后无法执行 `tmux`。 [BUG_LOG.md] (worked)
- 2026-08-14T10:48:15Z `fix`: 历史修复：安装脚本在安装时解析 Python、tmux 和 Codex CLI 的实际目录，并将其写入启动器的 `PATH`。；验证：重装后 `bridge.log` 不再出现 `No such file or directory: 'tmux'`，且 `tmux -L codex has-session -t codex` 成功。 [BUG_LOG.md]
- 2026-08-14T10:52:42Z `fix`: 历史修复与验证详情已完整归档 [Projectmem 历史问题]
