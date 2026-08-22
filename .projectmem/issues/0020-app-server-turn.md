# #0020 历史问题：App Server turn 失败被误报为成功

- 2026-08-14T10:48:06Z `issue`: 历史问题：App Server turn 失败被误报为成功 [BUG_LOG.md]
- 2026-08-14T10:48:06Z `attempt`: 历史根因：初版编排器收到 `turn/completed` 时未检查 `turn.status`，且把 `willRetry=true` 的错误提前终止。 [BUG_LOG.md] (worked)
- 2026-08-14T10:48:06Z `fix`: 历史修复：只有 `status=completed` 才发送最终成功；failed/interrupted 映射明确失败；可重试错误只显示重试进度。缺少 thread/turn 的全局通知不归入当前任务。；验证：App Server 合约测试与严格事件类型检查通过。 [BUG_LOG.md]
- 2026-08-14T10:52:40Z `fix`: 历史修复与验证详情已完整归档 [Projectmem 历史问题]
