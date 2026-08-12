# 从旧 tmux 版本迁移

1. 先安装 1.0，但不要启动第二个使用同一 Bot 的 long-poll 消费者。
2. 运行：

```bash
./scripts/migrate-v1.sh /path/to/telegram-agent-bridge.env
```

Windows 使用 `scripts/migrate-v1.ps1`。

迁移脚本会：

- 备份旧配置、状态和服务资料。
- 停止旧服务并确认它不再消费 `getUpdates`。
- 把 Token 写入新 0600 文件。
- 生成不含 Token 的只读 `migration-report.json`。
- 通过 `ctb migrate legacy --report ...` 注册旧 `TAB_WORKDIR` 并导入最新 offset。
- 强制要求重新执行本机 owner 配对。

旧 session 只有在线程 ID 与工作目录能够唯一验证时才应导入；当前迁移器默认建立新 App Server thread，并保留只读报告，不猜测 JSONL。

## 验收

配对后依次执行：

1. `ctb doctor`
2. Telegram `/ping`
3. Telegram `/health`
4. 一个真实只读 Codex 任务
5. workspace-write 审批接受和拒绝各一次
6. 服务重启后确认旧 update 没有重放

## 失败回滚旧服务

```bash
./scripts/rollback-migration.sh <backup-directory> <latest-confirmed-offset>
```

必须传入新服务已经确认的最新 Telegram offset，脚本会回写旧格式后恢复旧服务，避免消息重放。
