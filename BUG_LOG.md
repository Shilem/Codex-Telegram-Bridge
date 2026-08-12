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

### macOS LaunchAgent 找不到 Homebrew 安装的 tmux

- 根因：launchd 的默认 `PATH` 只有系统目录，不包含 Apple Silicon Homebrew 的 `/opt/homebrew/bin`；桥接进程启动后无法执行 `tmux`。
- 修复：安装脚本在安装时解析 Python、tmux 和 Codex CLI 的实际目录，并将其写入启动器的 `PATH`。
- 验证：重装后 `bridge.log` 不再出现 `No such file or directory: 'tmux'`，且 `tmux -L codex has-session -t codex` 成功。

### 新创建的 Codex TUI 会让桥接服务在启动时退出

- 根因：Codex 在首次实际提交任务后才创建 JSONL 会话文件，但桥接在主循环启动前强制要求该文件存在，导致 LaunchAgent 以退出码 2 重启。
- 修复：仅对“尚无 Codex TUI JSONL”这一预期的新会话状态记录等待日志并继续启动，后台每 30 秒报告一次等待状态；其他会话定位错误仍然抛出。JSONL 线程会在首个 TUI 回合创建后自动绑定。
- 验证：新 tmux/Codex 会话启动后日志包含 `startup waiting for Codex session JSONL`，服务保持运行；提交首条任务后出现 `watching ...rollout-*.jsonl`。

### macOS 不能使用 Linux 安装脚本

- 根因：早期安装脚本固定写入 systemd 用户服务，而 macOS 用 launchd。
- 修复：安装脚本根据平台写入 Linux systemd unit 或 macOS LaunchAgent，并用对应服务管理器重启。
- 验证：macOS 执行 `launchctl print gui/$(id -u)/com.codex-telegram-bridge.codex`。
