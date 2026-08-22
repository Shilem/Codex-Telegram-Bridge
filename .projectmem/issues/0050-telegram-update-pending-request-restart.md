# #0050 重启动作在 Telegram update 未提交时崩溃会遗留 pending；恢复流程跳过它但 request 仍将其视为活跃，导致后续 /restart 永久被拒绝。应终态化未落账动作并通知。

- 2026-08-22T03:32:31Z `issue`: 重启动作在 Telegram update 未提交时崩溃会遗留 pending；恢复流程跳过它但 request 仍将其视为活跃，导致后续 /restart 永久被拒绝。应终态化未落账动作并通知。 [src/telegram/controller.ts:138]
- 2026-08-22T03:34:01Z `attempt`: 为未落账重启动作新增终态化接口后，既有恢复测试 mock 未实现 RestartProvider.cancelUncommitted，TypeScript 类型检查失败；需补齐接口 mock。 [test/telegram/restart-notification.test.ts:38] (failed)
- 2026-08-22T03:34:24Z `attempt`: 未落账取消测试中的 expect.stringContaining 被严格 lint 视为 any；改为读取终态后直接断言失败原因。 [test/update/restart-manager.test.ts:137] (failed)
- 2026-08-22T03:38:58Z `attempt`: 修复 #0050：为 pending restart 绑定 sourceUpdateId；未落账动作取消为失败终态并可重新请求。 [实现验证] (worked)
- 2026-08-22T03:38:58Z `fix`: #0050 已修复：重启动作仅在 Telegram update 已提交后启动，恢复时取消未落账动作。 [完整测试与分发校验通过]
