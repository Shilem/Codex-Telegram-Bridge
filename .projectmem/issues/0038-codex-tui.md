# #0038 历史问题：新创建的 Codex TUI 会让桥接服务在启动时退出

- 2026-08-14T10:48:16Z `issue`: 历史问题：新创建的 Codex TUI 会让桥接服务在启动时退出 [BUG_LOG.md]
- 2026-08-14T10:48:16Z `attempt`: 历史根因：Codex 在首次实际提交任务后才创建 JSONL 会话文件，但桥接在主循环启动前强制要求该文件存在，导致 LaunchAgent 以退出码 2 重启。 [BUG_LOG.md] (worked)
- 2026-08-14T10:48:16Z `fix`: 历史修复：仅对“尚无 Codex TUI JSONL”这一预期的新会话状态记录等待日志并继续启动，后台每 30 秒报告一次等待状态；其他会话定位错误仍然抛出。JSONL 线程会在首个 TUI 回合创建后自动绑定。；验证：新 tmux/Codex 会话启动后日志包含 `startup waiting for Codex session JSONL`，服务保持运行；提交首条任务后出现 `watching ...rollout-*.jsonl`。 [BUG_LOG.md]
- 2026-08-14T10:52:42Z `fix`: 历史修复与验证详情已完整归档 [Projectmem 历史问题]
