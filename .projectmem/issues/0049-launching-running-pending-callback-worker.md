# #0049 重启请求只拒绝 launching/running 动作，未拒绝 pending；两个已提交 callback 在 worker 启动前可创建重复重启动作。

- 2026-08-22T03:26:21Z `issue`: 重启请求只拒绝 launching/running 动作，未拒绝 pending；两个已提交 callback 在 worker 启动前可创建重复重启动作。 [src/update/restart-manager.ts:54]
- 2026-08-22T03:38:58Z `attempt`: 修复 #0049：restart request 拒绝 pending、launching、running 动作，避免重复确认并发启动。 [实现验证] (worked)
- 2026-08-22T03:38:58Z `fix`: #0049 已修复：重启动作创建阶段已按活动状态去重。 [完整测试与分发校验通过]
