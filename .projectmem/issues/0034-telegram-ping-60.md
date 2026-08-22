# #0034 历史问题：Telegram `/ping` 延迟约 60 秒

- 2026-08-14T10:48:13Z `issue`: 历史问题：Telegram `/ping` 延迟约 60 秒 [BUG_LOG.md]
- 2026-08-14T10:48:13Z `attempt`: 历史根因：`getUpdates` 使用了通用 60 秒 HTTP 超时和重试，即使 Telegram 长轮询配置为 2 秒，主循环仍会被阻塞。 [BUG_LOG.md] (worked)
- 2026-08-14T10:48:14Z `fix`: 历史修复：轮询请求使用 `poll_timeout + 3` 秒硬超时、单次尝试；失败后记录 `POLL` 日志并在 2 秒后重试。；验证：日志应显示较低的 `PING telegram_age_ms`；`sendMessage elapsed_ms` 单独衡量出站耗时。 [BUG_LOG.md]
- 2026-08-14T10:52:42Z `fix`: 历史修复与验证详情已完整归档 [Projectmem 历史问题]
