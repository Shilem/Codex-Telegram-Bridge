# #0023 历史问题：发布包、原子切换和独立更新任务不可靠

- 2026-08-14T10:48:07Z `issue`: 历史问题：发布包、原子切换和独立更新任务不可靠 [BUG_LOG.md]
- 2026-08-14T10:48:07Z `attempt`: 历史根因：npm 默认不打包 lockfile，Unix symlink 替换在 GNU/BSD 行为不同，服务内 updater 可能随服务一起被杀，迁移回滚又未严格保存唯一 offset。 [BUG_LOG.md] (worked)
- 2026-08-14T10:48:07Z `fix`: 历史修复：签名 tarball 显式注入 shrinkwrap；版本目录通过原子 current 指针切换；更新交给 systemd/launchd/Task Scheduler 独立任务；迁移精确备份和回写 offset，失败闭合；CI action 固定完整 SHA。；验证：Unix 安装、1.0→1.1、回滚和 shell 语法测试通过；三平台真实服务验收保留为发布门禁。 [BUG_LOG.md]
- 2026-08-14T10:52:40Z `fix`: 历史修复与验证详情已完整归档 [Projectmem 历史问题]
