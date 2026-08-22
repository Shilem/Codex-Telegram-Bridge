# 从旧 tmux 版本迁移

1. 先安装当前版本，但不要启动第二个使用同一 Bot 的 long-poll 消费者。
2. 运行：

```bash
./scripts/migrate-v1.sh /path/to/telegram-agent-bridge.env
```

Windows 使用 `scripts/migrate-v1.ps1`。

迁移脚本会：

- 备份旧配置、状态和服务资料。
- 停止旧服务并确认它不再消费 `getUpdates`。
- 把 Token 写入新的专用 Token 文件；Unix 文件权限设为 0600。
- 生成不含 Token 的只读 `migration-report.json`。
- 通过 `ctb migrate legacy --report ...` 注册旧 `TAB_WORKDIR` 并导入最新 offset。
- 强制要求重新执行本机 owner 配对。

当前迁移器不导入旧 TUI session，也不猜测 Codex JSONL；它保留只读报告，首个新任务会建立 App Server thread。

## 验收

配对后依次执行：

1. `ctb doctor`
2. Telegram `/ping`
3. Telegram `/health`
4. 一个真实只读 Codex 任务
5. workspace-write 审批接受和拒绝各一次
6. 服务重启后确认旧 update 没有重放

## Unix 失败回滚旧服务

```bash
./scripts/rollback-migration.sh <backup-directory> <latest-confirmed-offset>
```

必须传入新服务已经确认的最新 Telegram offset，脚本会回写旧格式后恢复旧服务，避免消息重放。

Windows 使用迁移备份和已经确认的最新 offset 恢复旧配置、状态与计划任务：

```powershell
.\scripts\rollback-migration.ps1 -Backup <backup-directory> -LatestOffset <latest-confirmed-offset>
```

不得在 offset 不明时启动旧消费者。
