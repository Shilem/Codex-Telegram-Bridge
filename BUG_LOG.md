# Bug 日志

此文档记录已定位根因、修复和验证方式；返工或纠正时先阅读并更新对应条目。

## 1.0 架构修复

### 群聊成员可操作任务与审批

- 根因：旧版只比较 `chat.id`，callback 未统一检查 `from.id` 和 `chat.type`。
- 修复：1.0 使用本机配对锁定唯一 owner；消息、附件和 callback 统一要求 private chat、owner user ID 和 owner private chat ID。所有拒绝进入脱敏审计。
- 验证：`test/security/security.test.ts` 覆盖群聊、陌生用户和 owner 私聊。

### 更新/重启 callback 在 offset 提交前重放

- 根因：旧 handler 内直接重启进程，Telegram offset 尚未持久化，重启后会再次收到同一 update；旧按钮还可能触发降级。
- 修复：update 与所有 callback 使用持久化一次性 action；点击后先事务消费，再重新验证远端签名和版本递增，安装器原子切换并在健康失败时回滚。
- 验证：安全 nonce、版本降级、签名、篡改拒绝和发布层更新测试。

### 图片 exec 绕过审批与沙箱

- 根因：旧图片模式使用危险的 bypass 参数，并可在用户 HOME 工作。
- 修复：旧 Python/tmux/exec 后端已移除。图片作为受限附件提交给预注册项目的 App Server turn，使用项目权限档和正常审批。
- 验证：仓库不再包含 bypass/exec 图片路径；项目边界和 MIME 测试通过。

### 入站媒体无真实大小上限且永久留存

- 根因：旧下载逻辑先把响应累积到内存，只限制出站附件，媒体长期保存在状态目录。
- 修复：声明大小、Telegram 大小、Content-Length、实际字节四层检查；流式写 0600 临时文件后原子改名；附件限速、magic 验证、二十四小时清理。
- 验证：媒体路径、符号链接逃逸、超限和清理逻辑由 Vitest 覆盖。

### App Server turn 失败被误报为成功

- 根因：初版编排器收到 `turn/completed` 时未检查 `turn.status`，且把 `willRetry=true` 的错误提前终止。
- 修复：只有 `status=completed` 才发送最终成功；failed/interrupted 映射明确失败；可重试错误只显示重试进度。缺少 thread/turn 的全局通知不归入当前任务。
- 验证：App Server 合约测试与严格事件类型检查通过。

### 通知投递、子进程退出与取消竞态冻结任务队列

- 根因：初版通知异步异常无人接管，App Server 已退出的活跃 turn Promise 不会结束；取消又在 interrupt 之后落账，可能和 completed 竞争。
- 修复：通知按序串行并统一接管异常；App Server 暴露 fatal 事件并拒绝所有活跃任务；取消先持久化终态，关停任务标记 `unknown`，审批和提问 Promise 同步撤销；资源释放带超时且逐项记录失败。
- 验证：类型、调度器测试、App Server transport/合约测试通过。

### 审批 requestId 重用导致后续操作永久失败

- 根因：协议 requestId 被误用作 approvals 主键；重启后 JSON-RPC 数字 ID、同项目危险权限或同版本更新均可能重用。
- 修复：数据库迁移为独立随机 `action_id` 主键，requestId 仅作绑定字段；nonce 仍为一次性、限时和上下文绑定。
- 验证：安全测试覆盖同一 binding 再次创建和消费。

### 发布包、原子切换和独立更新任务不可靠

- 根因：npm 默认不打包 lockfile，Unix symlink 替换在 GNU/BSD 行为不同，服务内 updater 可能随服务一起被杀，迁移回滚又未严格保存唯一 offset。
- 修复：签名 tarball 显式注入 shrinkwrap；版本目录通过原子 current 指针切换；更新交给 systemd/launchd/Task Scheduler 独立任务；迁移精确备份和回写 offset，失败闭合；CI action 固定完整 SHA。
- 验证：Unix 安装、1.0→1.1、回滚和 shell 语法测试通过；三平台真实服务验收保留为发布门禁。

## 0.9 旧版历史（已由 1.0 后端移除）

### 已解决

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

### 平台兼容性

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
