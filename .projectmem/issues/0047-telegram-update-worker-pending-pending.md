# #0047 重启动作在 Telegram update 已提交、独立 worker 尚未启动时若服务退出，会永久保持 pending；启动恢复仅处理非 pending 动作，导致重启及终态通知丢失。

- 2026-08-22T03:26:20Z `issue`: 重启动作在 Telegram update 已提交、独立 worker 尚未启动时若服务退出，会永久保持 pending；启动恢复仅处理非 pending 动作，导致重启及终态通知丢失。 [src/telegram/controller.ts:138]
- 2026-08-22T03:30:59Z `attempt`: 重启恢复回归测试的 launching mock 被 TypeScript 推断为 string，未满足 RestartProvider 返回类型；需保留字面量联合类型。 [test/telegram/restart-notification.test.ts:40] (failed)
- 2026-08-22T03:38:57Z `attempt`: 修复 #0047：启动恢复会扫描已落账的 pending 重启动作并继续启动 worker，未落账动作显式终态化；回归测试与完整校验通过。 [实现验证] (worked)
- 2026-08-22T03:38:57Z `fix`: #0047 已修复：重启动作按 Telegram update 落账状态恢复，避免崩溃窗口永久 pending。 [完整测试与分发校验通过]
