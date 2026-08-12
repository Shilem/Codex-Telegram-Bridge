# Bug 日志

此文档记录已定位根因、修复和验证方式；返工或纠正时先阅读并更新对应条目。

## 已解决

### Telegram `/ping` 延迟约 60 秒

- 根因：`getUpdates` 使用了通用 60 秒 HTTP 超时和重试，即使 Telegram 长轮询配置为 2 秒，主循环仍会被阻塞。
- 修复：轮询请求使用 `poll_timeout + 3` 秒硬超时、单次尝试；失败后记录 `POLL` 日志并在 2 秒后重试。
- 验证：日志应显示较低的 `PING telegram_age_ms`；`sendMessage elapsed_ms` 单独衡量出站耗时。

### `/exit` 关闭 Codex tmux 会话

- 根因：桥接原样转发 `/exit`，Codex 退出后 tmux server 消失。
- 修复：拦截 `/exit` 和 `/quit`；`CRB_AUTO_RECOVER_TMUX=1` 时自动新建目标 tmux/Codex 会话。
- 验证：Telegram `/exit` 返回拦截提示；会话异常消失后日志包含 `tmux recovery session ready`。

### `/new` 错报“20 秒内未确认”

- 根因：Codex 在新会话收到第一条真实任务时才懒创建 JSONL，不能以 `/new` 后立即变更 JSONL 作为成功条件。
- 修复：检测 `/new` 是否被 TUI 拒绝；未拒绝则立即确认已切换到新对话。
- 验证：`/new` 约 1 秒内收到成功中文提示。

## 平台兼容性

### macOS 不能使用 Linux 安装脚本

- 根因：早期安装脚本固定写入 systemd 用户服务，而 macOS 用 launchd。
- 修复：安装脚本根据平台写入 Linux systemd unit 或 macOS LaunchAgent，并用对应服务管理器重启。
- 验证：macOS 执行 `launchctl print gui/$(id -u)/com.codex-telegram-bridge.codex`。
