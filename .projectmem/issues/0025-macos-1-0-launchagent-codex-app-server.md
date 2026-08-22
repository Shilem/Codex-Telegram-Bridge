# #0025 历史问题：macOS 1.0 LaunchAgent 无法启动 Codex App Server

- 2026-08-14T10:48:08Z `issue`: 历史问题：macOS 1.0 LaunchAgent 无法启动 Codex App Server [BUG_LOG.md]
- 2026-08-14T10:48:08Z `attempt`: 历史根因：服务启动器只用绝对路径执行 Bridge 的 Node 24，却没有把该 Node 目录写入 `PATH`。Homebrew 的 `codex` 启动脚本使用 `/usr/bin/env node`，而 launchd 默认 `PATH` 只有系统目录，因此 App Server 以退出码 127 终止。 [BUG_LOG.md] (worked)
- 2026-08-14T10:48:08Z `fix`: 历史修复：Unix 服务启动器固定写入安装时验证过的 Node 与 Codex 可执行文件目录，再追加系统目录；不依赖交互式 shell 环境。；验证：发布测试断言生成的启动器包含确定性 `PATH`；本机 LaunchAgent 日志不再出现 `env: node: No such file or directory`，并需通过 `ctb doctor`。 [BUG_LOG.md]
- 2026-08-14T10:52:40Z `fix`: 历史修复与验证详情已完整归档 [Projectmem 历史问题]
