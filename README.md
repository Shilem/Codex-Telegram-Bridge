# Codex Telegram Bridge 1.0

Codex Telegram Bridge 是一个单用户、自托管的 Codex 远程开发客户端。它通过 Telegram Bot 私聊接收任务，并直接使用本机 `codex app-server --listen stdio://` 的结构化 JSON-RPC 协议；不开放公网端口，不依赖 tmux、终端截图或 JSONL 会话猜测。

> Telegram Bot 私聊不是端到端加密渠道。不要发送 API Key、密码、生产凭据或其他机密。

## 1.0 能力

- macOS、Linux、Windows；单实例、单 Bot、全局一次只运行一个 Codex 任务。
- 本机十分钟配对码锁定唯一 `Telegram user ID + private chat ID`；群聊和陌生用户失败闭合。
- 多个本机预注册项目；Telegram 只能切换项目，不能扩大目录边界。
- SQLite WAL 任务账本、update 幂等、一次性审批 nonce、崩溃后 `unknown` 恢复。
- `read-only`、`workspace-write + on-request`、`danger-full-access` 三档权限。
- 完全访问必须同时满足主机开关和 Telegram 二次确认，只对当前项目生效十五分钟。
- App Server 计划、工具事件、审批、提问、最终回答和生成产物分开展示；不转发隐藏推理。
- 入站附件默认 20 MB，出站产物 50 MB；流式下载、三重大小检查、0600 临时文件和路径隔离。
- 签名更新、原子 `current` 切换、健康检查与失败回滚。

语音、视频理解和定时任务不在 1.0 范围内，计划在 1.1 提供。

## 环境要求

- Node.js 24 LTS。
- 已安装并登录的 Codex CLI，且 `codex app-server --help` 可用。
- 一个只供本实例使用的 Telegram Bot Token。不要让第二个进程或另一台机器使用同一 Bot 执行 `getUpdates`。

## 安装

macOS 或 Linux：

```bash
./scripts/install.sh
```

Windows PowerShell：

```powershell
.\scripts\install.ps1
```

安装器把程序放入版本目录并原子切换 `current`，生成本地配置和空的 `bot-token` 文件。将 Token 写入安装器提示的文件后，在 Unix 上保持文件权限为 0600。示例配置见 `deploy/config.json.example`。

首次安装创建的是空 Token 文件，因此服务不会立即启动。写入 Token 后按平台执行安装器最后打印的启动命令：Linux 使用 `systemctl --user start codex-telegram-bridge.service`，macOS 使用提示中的 `launchctl bootstrap ...`，Windows 使用 `schtasks.exe /Run /TN CodexTelegramBridge`。

安装完成后先注册项目：

```bash
ctb project add /absolute/path/to/project --name my-project
ctb project list
ctb doctor
```

然后向 Bot 私聊发送 `/start`，把十分钟配对码带回主机：

```bash
ctb pair <code>
```

配对完成后，公开配对入口会关闭。

## Telegram 命令

- 身份与帮助：`/start`、`/help`
- 项目：`/projects`、`/project <id>`
- 会话：`/new`、`/sessions`、`/resume <id>`、`/handback`
- 任务：`/tasks`、`/cancel [id]`、`/retry <unknown-task-id>`
- 模型与权限：`/model [name]`、`/effort [level]`、`/permissions [profile]`
- 状态：`/status`、`/ping`、`/health`
- 维护：`/cleanup`、`/update`、`/version`

`/ping` 只衡量 Telegram 收发路径；`/health` 才检查 App Server、Codex 登录、SQLite、项目和磁盘。

## 主机 CLI

```text
ctb project add <path> --name <name>
ctb project list
ctb project disable <id>
ctb pair <code>
ctb doctor
ctb update --manifest <url> --signature <url> --archive <url> --public-key <pem>
ctb rollback [version]
ctb uninstall [--purge-data]
```

`ctb uninstall` 默认保留本地配置和数据；`--purge-data` 会不可恢复地删除它们。

## 服务

- macOS：LaunchAgent `com.shilem.codex-telegram-bridge`
- Linux：systemd user service `codex-telegram-bridge.service`
- Windows：当前用户 Task Scheduler 任务 `CodexTelegramBridge`

详细设计见 [架构](docs/ARCHITECTURE.md)、[安全模型](docs/SECURITY.md)、[隐私](docs/PRIVACY.md)、[迁移](docs/MIGRATION.md)、[排障](docs/TROUBLESHOOTING.md) 和 [发布流程](docs/RELEASE.md)。App Server 协议背景见 [OpenAI App Server 文档](https://learn.chatgpt.com/docs/app-server)。
