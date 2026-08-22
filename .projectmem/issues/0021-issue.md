# #0021 历史问题：通知投递、子进程退出与取消竞态冻结任务队列

- 2026-08-14T10:48:06Z `issue`: 历史问题：通知投递、子进程退出与取消竞态冻结任务队列 [BUG_LOG.md]
- 2026-08-14T10:48:06Z `attempt`: 历史根因：初版通知异步异常无人接管，App Server 已退出的活跃 turn Promise 不会结束；取消又在 interrupt 之后落账，可能和 completed 竞争。 [BUG_LOG.md] (worked)
- 2026-08-14T10:48:06Z `fix`: 历史修复：通知按序串行并统一接管异常；App Server 暴露 fatal 事件并拒绝所有活跃任务；取消先持久化终态，关停任务标记 `unknown`，审批和提问 Promise 同步撤销；资源释放带超时且逐项记录失败。；验证：类型、调度器测试、App Server transport/合约测试通过。 [BUG_LOG.md]
- 2026-08-14T10:52:40Z `fix`: 历史修复与验证详情已完整归档 [Projectmem 历史问题]
