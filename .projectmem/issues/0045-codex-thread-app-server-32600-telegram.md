# #0045 任务恢复复用已归档 Codex thread，App Server 返回 -32600 并导致 Telegram 任务失败；需识别归档会话并建立安全恢复策略

- 2026-08-22T03:16:52Z `issue`: 任务恢复复用已归档 Codex thread，App Server 返回 -32600 并导致 Telegram 任务失败；需识别归档会话并建立安全恢复策略 [src/orchestrator/app-task-executor.ts:201]
- 2026-08-22T03:19:38Z `attempt`: 新增归档会话 -32600 回归测试后，任务执行器仅在明确归档响应时创建并保存替代会话；目标测试与全量验证均通过。 [src/orchestrator/app-task-executor.ts:116] (worked)
- 2026-08-22T03:19:38Z `fix`: 已识别归档会话的 AppServerRpcError(-32600)，自动创建并持久化替代会话后继续任务；其他 resume 错误保持失败可见。已覆盖回归测试并完成全量验证。 [src/orchestrator/app-task-executor.ts:205]
