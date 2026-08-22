# #0005 历史问题：Telegram 无法进入 Codex 官方 Plan 模式

- 2026-08-14T10:47:58Z `issue`: 历史问题：Telegram 无法进入 Codex 官方 Plan 模式 [BUG_LOG.md]
- 2026-08-14T10:47:58Z `attempt`: 历史根因：任务模型没有持久化协作模式，执行器的 `turn/start` 也没有传入 App Server 的 `collaborationMode`；Telegram 因此既不能让一段任务保持在 Plan 模式，也无法识别权威计划并在同一 Codex 会话中继续执行。 [BUG_LOG.md] (worked)
- 2026-08-14T10:47:58Z `fix`: 历史修复：新增项目级 `/plan` 开关和任务级协作模式快照，运行时从 `collaborationMode/list` 读取官方 Plan/Default 预设并传给 `turn/start`；流式显示计划更新，但只以 `item/completed` 的 `plan` item 定稿。计划生成后关闭项目 Plan 开关，并提供共用一次性签名动作的“执行计划/跳过”按钮；执行固定恢复生成计划的原 thread、切回 Default 模式并提交 `Implement the plan.`，跳过只保留计划。长计划把按钮放在最后一段，Telegram 卡片更新失败也不会阻止已落账执行任务唤醒调度器。；验证：迁移测试覆盖旧库默认 Default 和显式 Plan；执行器测试覆盖官方预设解析、无 threadId 的计划更新、计划增量和权威 plan item；Gateway/控制器测试覆盖互斥按钮、原 thread 恢复、Default 执行与跳过。真实 App Server 合约检查要求返回 Plan/Default 预设，并在本机一次临时 Plan turn 中观察到完成的 plan item。 [BUG_LOG.md]
- 2026-08-14T10:52:38Z `fix`: 历史修复与验证详情已完整归档 [Projectmem 历史问题]
