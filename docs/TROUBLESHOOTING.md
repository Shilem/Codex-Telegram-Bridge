# 排障手册

先运行：

```bash
ctb doctor
```

再在 Telegram 运行 `/health`。`/ping` 只说明 Bot 收发可用，不能证明 Codex、SQLite或项目正常。

## 服务日志

Linux：

```bash
journalctl --user -u codex-telegram-bridge.service -n 200 --no-pager
systemctl --user status codex-telegram-bridge.service
```

macOS：

```bash
launchctl print gui/$(id -u)/com.shilem.codex-telegram-bridge
tail -n 200 ~/Library/Logs/codex-telegram-bridge/bridge.log
```

Windows：查看 Task Scheduler 中 `CodexTelegramBridge` 的 Last Run Result 和本地日志目录。

## 常见问题

### Node 版本错误

1.0 固定 Node.js 24 LTS。`node --version` 不是 24 时，安装器和 doctor 会失败，不会静默使用未验证版本。

### App Server 不可用

运行 `codex app-server --help`。若命令不存在，先升级 Codex CLI。若登录检查失败，在主机完成 Codex 登录；不要通过 Telegram 发送凭据。

### Bot 没有响应

确认 Token 文件非空、权限为 0600，并确认没有第二个进程使用同一 Token 执行长轮询。检查日志中的 update ID 与 Telegram API 错误。

### 任务变为 unknown

这表示进程在提交或运行边界崩溃，系统故意不自动重放。使用 `/tasks` 查看；确认外部副作用后选择 `/retry <id>`、标记完成或取消。

### 附件被拒绝

检查声明大小、Content-Length、实际大小、MIME magic、十分钟上传速率和磁盘空间。服务不会放宽限制后继续执行。

### 更新失败

检查 HTTPS、签名公钥、manifest 产物名和 SHA-256。健康检查失败时 `current` 会恢复旧版本；使用 `ctb rollback` 可人工回滚已安装版本。
