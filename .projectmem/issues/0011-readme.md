# #0011 历史问题：README 的首次安装路径无法闭环

- 2026-08-14T10:48:01Z `issue`: 历史问题：README 的首次安装路径无法闭环 [BUG_LOG.md]
- 2026-08-14T10:48:01Z `attempt`: 历史根因：旧 README 先建议全局安装 npm 包，随后直接执行仓库内的 `./scripts/install.sh`，却没有说明如何获取仓库；Bot 创建、Token 写入、服务启动和 CLI 路径也分散在不同章节。 [BUG_LOG.md] (worked)
- 2026-08-14T10:48:01Z `fix`: 历史修复：README 改为从 GitHub 标签运行三平台安装器的单一路径，补充 BotFather、Token 文件、服务启动、Unix PATH 和 Windows CLI 脚本说明；高级状态机和架构术语移到日常操作之后。；验证：逐项核对 CLI 与安装器实现，检查本地文档链接、完整测试和三平台发布测试。 [BUG_LOG.md]
- 2026-08-14T10:52:38Z `fix`: 历史修复与验证详情已完整归档 [Projectmem 历史问题]
