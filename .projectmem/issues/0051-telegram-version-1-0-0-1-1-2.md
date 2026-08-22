# #0051 Telegram /version 仍硬编码输出 1.0.0，而发布元数据已为 1.1.2；发布后用户会看到错误版本。

- 2026-08-22T03:35:34Z `issue`: Telegram /version 仍硬编码输出 1.0.0，而发布元数据已为 1.1.2；发布后用户会看到错误版本。 [src/telegram/controller.ts:414]
- 2026-08-22T03:38:58Z `attempt`: 修复 #0051：将 service、CLI、Telegram /version 统一为 src/core/version.ts，并更新发布校验。 [回归测试先失败后通过] (worked)
- 2026-08-22T03:38:58Z `fix`: #0051 已修复：/version 和所有运行入口引用共享版本常量，避免发布版本漂移。 [完整测试与分发校验通过]
