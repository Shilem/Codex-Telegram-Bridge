# Codex Telegram Bridge

在 Telegram 私聊里使用你电脑上的 Codex。它适合只有一个使用者、希望从手机查看进度或处理审批，同时又不想开放公网端口的场景。

Bridge 会在本机启动 `codex app-server`，Telegram 只负责收发消息。项目目录必须先在电脑上登记，Bot 不能自行访问其他位置。

> Telegram Bot 私聊不是端到端加密渠道。不要发送密码、Token、私钥、生产数据或其他机密。

## 主要功能

- 支持 macOS、Linux 和 Windows。
- 可登记多个项目，并在 Telegram 中用按钮切换。
- 支持任务队列、会话恢复、取消、安全重试和 Codex 审批。
- 模型、思考深度和 Fast 模式优先跟随本机 Codex 设置。
- 支持图片、普通文件和生成产物回传。
- 默认限制在项目目录内工作；完全访问需要主机开关和 Telegram 二次确认。
- 使用 SQLite 保存任务和 Telegram 去重状态。服务意外中断后，不会自动重复执行未确认的任务。
- 更新包带有签名和 SHA-256 校验，更新失败会自动回滚。

一个 Bridge 实例同时只运行一个 Codex 任务，其他任务会排队。1.0 暂不支持群聊、多人协作、语音、视频理解和定时任务。

## 安装前准备

需要：

- Node.js 24 LTS
- 已安装并登录的 [Codex CLI](https://developers.openai.com/codex/cli)
- Git
- 一个专供本服务使用的 Telegram Bot

先检查本机环境：

```bash
node --version
codex --version
codex app-server --help
```

Node.js 必须是 24.x。Codex CLI 需要已经完成登录，并且支持 `app-server`。

### 创建 Telegram Bot

1. 在 Telegram 中打开 [@BotFather](https://t.me/BotFather)。
2. 发送 `/newbot`，按提示设置名称和用户名。
3. 保存 BotFather 返回的 Bot Token。

不要让其他程序或另一台电脑同时使用这个 Token。Telegram 的 `getUpdates` 只能由当前 Bridge 实例消费。

## 安装服务

推荐从 GitHub 仓库运行安装器。npm 包用于正式版本分发，单独执行全局安装不会注册系统服务。

### macOS 或 Linux

```bash
git clone https://github.com/Shilem/Codex-Telegram-Bridge.git
cd Codex-Telegram-Bridge
git checkout v1.0.0
./scripts/install.sh
```

安装器会检查 Node.js 和 Codex，创建本地配置、数据目录和系统启动项。第一次安装不会直接启动服务，因为 Bot Token 文件还是空的。

打开 Token 文件，把 BotFather 给出的完整 Token 粘贴进去并保存：

```bash
nano ~/.config/codex-telegram-bridge/bot-token
chmod 600 ~/.config/codex-telegram-bridge/bot-token
```

然后启动服务。

Linux：

```bash
systemctl --user start codex-telegram-bridge.service
```

macOS：安装器结束时会打印对应的 `launchctl bootstrap` 命令，请直接执行那一行。

安装器把 `ctb` 放在 `~/.local/bin`。如果终端提示找不到命令，先执行：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### Windows

```powershell
git clone https://github.com/Shilem/Codex-Telegram-Bridge.git
Set-Location Codex-Telegram-Bridge
git checkout v1.0.0
powershell.exe -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

用记事本打开 Token 文件：

```powershell
notepad "$env:APPDATA\CodexTelegramBridge\bot-token"
```

保存后启动计划任务：

```powershell
schtasks.exe /Run /TN CodexTelegramBridge
```

Windows 的 CLI 脚本位于：

```powershell
$ctb = "$env:LOCALAPPDATA\CodexTelegramBridge\app\ctb.ps1"
& $ctb doctor
```

下文出现 `ctb ...` 时，Windows 用户可以改用 `& $ctb ...`。

## 登记第一个项目

项目只能在主机上登记。下面的路径换成你自己的项目目录：

```bash
ctb project add /absolute/path/to/project --name my-project
ctb project list
ctb doctor
```

Windows 示例：

```powershell
ctb project add "C:\Users\me\Projects\my-project" --name my-project
ctb project list
ctb doctor
```

`ctb doctor` 会检查服务配置、Codex App Server、数据库和项目。如果检查失败，先按输出中的原因处理，再继续配对。

## 配对 Telegram

1. 打开刚创建的 Bot，发送 `/start`。
2. Bot 会返回一个十分钟有效的配对码。
3. 回到主机执行：

```bash
ctb pair <配对码>
```

配对会锁定当前 Telegram 用户和私聊。完成后，陌生用户和群聊消息都会被拒绝。

## 发送第一条任务

在 Telegram 中发送：

```text
只读检查当前项目的 Git 状态，告诉我有哪些未提交修改，不要修改文件。
```

Bridge 会回复任务编号和队列状态，并在同一条进度消息中持续更新。需要你决定时，Bot 会单独发送提问或审批卡片。

再用这些命令确认当前状态：

```text
/health
/project
/status
```

- `/health` 检查服务、Codex 登录、数据库、项目和磁盘。
- `/project` 用按钮切换已经登记的项目。
- `/status` 显示当前项目、模型、权限、正在运行的任务和队列。

## 常用操作

### 项目

在 Telegram 中发送 `/project`，点击按钮即可切换。项目的登记、禁用和删除只能在主机完成：

```bash
ctb project add <path> --name <name>
ctb project list
ctb project list --all
ctb project disable <id>
ctb project remove <id>
```

禁用后的项目不会出现在 Telegram 列表中。永久移除前必须先禁用；如果项目仍有任务或会话记录，只能保持禁用。移除登记记录不会删除项目目录里的文件。

### 任务

- 直接发送文字、图片或文件即可创建任务。
- 发送 `/plan` 后，当前项目后续收到的任务会使用 Codex 官方 Plan 模式，直到成功生成一份权威计划。计划卡提供“执行计划”和“跳过”按钮；执行会在生成计划的同一 Codex 会话中切回 Default 模式继续，跳过则只保留计划。可用 `/plan off` 提前退出。
- `/tasks` 显示最近的任务。进入详情后可以取消任务，或安全重试状态为 `unknown` 的任务。
- 服务中断时，尚未确认结果的任务会变成 `unknown`，不会自动重复执行。
- 已明确失败的任务不能直接重试。检查错误原因后，重新发送任务更安全。

### 会话

- `/new`：结束当前活跃会话，下一条任务会新建会话。
- `/sessions`：查看最近会话。点进详情后可以恢复会话或交回本机 Codex。

`/resume` 和 `/handback` 仍可直接调用，但默认不显示在 Telegram 菜单中。

### 模型和思考深度

- `/model`：选择当前项目使用的模型。
- `/effort`：选择当前模型支持的思考深度。
- `/fast`：跟随本机设置，或切换 Standard/Fast 档位。

项目没有单独设置时，Bridge 会优先读取当前工作区的本机 Codex 配置。切换模型后，项目级思考深度和 Fast 覆盖会被清除，避免保留不兼容的组合。

### 权限

发送 `/permissions` 后用按钮选择：

- `read-only`：只读检查和分析。
- `workspace-write`：可修改当前项目；这是默认档位。
- `danger-full-access`：完全访问。

完全访问默认关闭。确有需要时，先在主机配置中设置 `allowDangerFullAccess: true`，再从 Telegram 二次确认。授权只对当前项目生效十五分钟。

审批只能通过对应卡片的一次性按钮完成。回复 `yes`、`1` 或“同意”不会批准操作。涉及秘密的问题也不会要求你在 Telegram 中输入答案。

### 附件和清理

- 入站单文件默认不超过 20 MB，每十分钟最多十个附件。
- 出站产物默认不超过 50 MB，只能来自已登记项目或专用产物目录。
- 附件和产物默认保留二十四小时。
- `/cleanup` 会先显示清理范围，确认后才执行。

## Telegram 命令

Telegram 的 `/` 菜单分为两类。

### Codex 操作

| 命令 | 用途 |
| --- | --- |
| `/new` | 下一条任务使用新会话 |
| `/sessions` | 查看、恢复或交回会话 |
| `/tasks` | 查看、取消或安全重试任务 |
| `/quota` | 查询 Codex 剩余额度、窗口和重置时间 |
| `/plan` | 让当前项目后续任务先生成计划；`/plan off` 退出 |
| `/cancel [任务ID]` | 取消当前任务，或按 ID/前缀取消指定任务 |
| `/stop` | 立即停止当前任务，等同于 `/cancel` |
| `/model` | 选择模型 |
| `/effort` | 选择思考深度 |
| `/fast` | 查看或切换 Fast 档位 |
| `/permissions` | 查看或切换权限 |

### Bridge 管理

| 命令 | 用途 |
| --- | --- |
| `/help` | 查看帮助和安全边界 |
| `/project` | 使用按钮切换项目 |
| `/status` | 查看当前项目和任务状态 |
| `/ping` | 检查 Telegram 消息延迟 |
| `/health` | 检查服务和本机依赖 |
| `/cleanup` | 清理超过保留期的数据 |
| `/update` | 检查并确认签名更新 |

这些兼容命令默认不占用菜单位置：`/start`、`/projects`、`/resume`、`/handback`、`/retry` 和 `/version`。

## 更新和卸载

在 Telegram 中发送 `/update` 可以检查签名版本，并通过一次性按钮确认安装。也可以在主机使用 `ctb update`；完整参数请运行：

```bash
ctb update --help
```

回滚：

```bash
ctb rollback
```

卸载服务但保留配置和数据：

```bash
ctb uninstall
```

同时删除本地配置和数据：

```bash
ctb uninstall --purge-data
```

`--purge-data` 不可恢复，执行前请确认不再需要任务、项目和会话记录。

## 服务和日志

macOS：

```bash
launchctl print gui/$(id -u)/com.shilem.codex-telegram-bridge
tail -f ~/Library/Logs/codex-telegram-bridge/bridge.log
tail -f ~/Library/Logs/codex-telegram-bridge/bridge.error.log
```

Linux：

```bash
systemctl --user status codex-telegram-bridge.service
journalctl --user -u codex-telegram-bridge.service -f
```

Windows：

```powershell
schtasks.exe /Query /TN CodexTelegramBridge /V /FO LIST
```

遇到问题时，先运行 `ctb doctor` 和 Telegram `/health`，再查看平台日志。

## npm 包

正式版本发布在 npm：

```bash
npm install --global @shilem/codex-telegram-bridge
```

全局安装会提供 `ctb` 和 `ctb-service` 命令，但不会自动创建配置或注册系统服务。首次安装仍建议使用仓库内的安装脚本。

## 更多文档

- [架构说明](docs/ARCHITECTURE.md)
- [安全模型](docs/SECURITY.md)
- [隐私说明](docs/PRIVACY.md)
- [旧版迁移](docs/MIGRATION.md)
- [排障手册](docs/TROUBLESHOOTING.md)
- [发布流程](docs/RELEASE.md)

Codex App Server 的协议背景见 [OpenAI App Server 文档](https://learn.chatgpt.com/docs/app-server)。
