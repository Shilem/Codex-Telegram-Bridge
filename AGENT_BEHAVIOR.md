# Agent 行为规范

- 所有用户可见提示使用简体中文；机密仅存在于主机本地配置。
- 不吞掉桥接、Telegram、tmux 或 Codex 错误：记录带耗时和上下文的日志并明确回报失败。
- `/ping` 是桥接健康检查，不应归因于模型速度；先检查 `telegram_age_ms`、`sendMessage elapsed_ms` 和 `POLL`。
- 不转发会终止远程控制面的 `/exit`、`/quit`。
- 安装或更新不得覆盖现有 `~/.config/telegram-agent-bridge.env`。
- Linux 使用 systemd user service，macOS 使用 `com.codex-telegram-bridge.codex` LaunchAgent；修改安装流程时两个平台都要验证。
- macOS LaunchAgent 不继承交互式 shell 的 Homebrew 路径；启动器必须显式包含安装时解析到的 Python、tmux 和 Codex CLI 目录。
- 新建 Codex TUI 在首次提交任务前可能没有 JSONL；服务应记录等待状态并保持运行，不能把该预期状态伪装成成功或因它退出。
- 每个实例必须使用独立 Telegram Bot；不得建议共享 Token 的多实例长轮询。
- 变更核心桥接逻辑前，先建立 Git 分支；更新本文件、`BUG_LOG.md` 与安装说明。
