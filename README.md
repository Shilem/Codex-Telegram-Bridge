# Codex Telegram Bridge

在 Telegram 私聊里使用你电脑上的 Codex。适合一个人使用：出门时从手机发任务、看进度、处理审批，不需要给电脑开放公网端口。

Bridge 在本机启动 `codex app-server`，不读取终端画面，也不猜测 Codex 的会话文件。Telegram 只负责收发消息。默认权限只允许访问已经登记的项目；十五分钟完全访问是单独的高危选项，需要先在主机开启，再到 Telegram 确认。

> Telegram Bot 私聊不是端到端加密渠道。不要发送密码、Token、私钥、生产数据或其他机密。

## 主要功能

- 支持 macOS、Linux 和 Windows，可以登记多个项目并在 Telegram 中切换。
- 普通消息直接执行；`/plan` 会先生成计划，再由你决定执行还是跳过。
- 任务排队运行，过程更新会合并在同一张卡片；完成或失败后，原卡片会显示最终状态。支持取消、会话恢复、`unknown` 任务安全重试和 Codex 审批。
- 模型、思考深度和 Fast 档位默认跟随本机 Codex，也可以按项目覆盖。
- `/quota` 读取 Codex 返回的额度窗口和重置时间，不做本地估算。
- 可以发送图片和普通文件，也能把 Codex 生成的文件传回 Telegram。
- SQLite 记录任务和 Telegram 去重状态。服务中断后，结果不确定的任务不会自动重跑。
- 更新包经过签名和 SHA-256 校验；新版本启动失败时自动回滚。

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

在 Telegram 中发送 `/project`，可以切换项目，也可以把项目从列表中移除。这里的“移除”只会禁用登记记录，历史任务和源码都还在。

登记项目和彻底删除登记记录要在主机完成：

```bash
ctb project add <path> --name <name>
ctb project list
ctb project list --all
ctb project disable <id>
ctb project remove <id>
```

禁用后的项目不会出现在 Telegram 列表中。`ctb project remove` 只能删除没有任务或会话记录的禁用项目；它同样不会删除项目目录。

### 任务

- 直接发送文字、图片或文件即可创建任务。
- `/tasks` 显示最近的任务。进入详情后可以取消任务，或安全重试状态为 `unknown` 的任务。
- 服务中断时，尚未确认结果的任务会变成 `unknown`，不会自动重复执行。
- 已明确失败的任务不能直接重试。检查错误原因后，重新发送任务更安全。

### 先生成计划

发送 `/plan`，再发送任务。这个开关只影响当前项目，会一直保持到 Codex 成功返回计划。

计划出来后，卡片底部有两个按钮：

- “执行计划”会回到生成这份计划的 Codex 会话，切回 Default 模式继续执行。
- “跳过”会保留计划，不创建执行任务。

两个按钮共用一次性凭证，点过一个后另一个就失效。按钮二十四小时内有效。想提前退出可发送 `/plan off`；已经排队的 Plan 任务不会因此改变。

Plan 依赖 Codex App Server 提供 Plan/Default 协作模式。若当前 Codex CLI 不支持，任务会明确报错，请先升级 Codex CLI。

### 会话

- `/new`：结束当前活跃会话，下一条任务会新建会话。
- `/sessions`：查看最近会话。点进详情后可以恢复会话或交回本机 Codex。

`/resume` 和 `/handback` 仍可直接调用，但默认不显示在 Telegram 菜单中。

### 模型和思考深度

- `/model`：选择当前项目使用的模型。
- `/effort`：选择当前模型支持的思考深度。
- `/fast`：跟随本机设置，或切换 Standard/Fast 档位。

项目没有单独设置时，Bridge 会优先读取当前工作区的本机 Codex 配置。切换模型后，项目级思考深度和 Fast 覆盖会被清除，避免保留不兼容的组合。

`/quota` 会先判断当前登录是 ChatGPT、API Key 还是 Amazon Bedrock。ChatGPT 账户按套餐展示额度；Enterprise 会显示月度额度、已用点数和重置时间，其他套餐展示 App Server 返回的时间窗口。API Key 和 Bedrock 的用量不属于 ChatGPT 额度接口，Bot 会提示去对应平台查看。上游没有返回的数值不会由 Bridge 自行推算。

### 权限

发送 `/permissions` 后用按钮选择：

- `read-only`：只读检查和分析。
- `workspace-write + on-request`：可修改当前项目，敏感操作会请求批准；这是默认档位。
- `danger-full-access`：完全访问。

完全访问默认关闭。确有需要时，先在主机配置中设置 `allowDangerFullAccess: true`，再从 Telegram 二次确认。授权只对当前项目生效十五分钟。

审批只能通过对应卡片的一次性按钮完成。回复 `yes`、`1` 或“同意”不会批准操作。涉及秘密的问题不会通过 Telegram 收集。

停机期间积压超过十分钟的普通命令和任务会被拒绝，避免服务恢复后执行过时消息。`/start`、`/help` 和 `/ping` 不受这项限制。

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
| `/project` | 使用按钮切换项目或移出项目列表 |
| `/status` | 查看项目、Plan/Default 模式和任务状态 |
| `/ping` | 检查 Telegram 消息延迟 |
| `/health` | 检查服务和本机依赖 |
| `/cleanup` | 清理超过保留期的数据 |
| `/update` | 检查并确认签名更新 |

这些兼容命令默认不占用菜单位置：`/start`、`/projects`、`/resume`、`/handback`、`/retry` 和 `/version`。

## 更新和卸载

在 Telegram 中发送 `/update` 可以检查签名版本，并通过一次性按钮确认安装。更新由独立系统任务执行，固定使用安装时验证过的 Node.js 24、Codex 和数据目录；下载、验签、安装、健康检查或自动回滚完成后，Bridge 会在重启后恢复更新动作，并把成功、失败或已回滚结果写回原 Telegram 消息。原消息无法编辑时会发送新的终态消息。也可以在主机使用 `ctb update`；完整参数请运行：

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

正式版本发布在 npm，更新频率可能慢于仓库 `main`：

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
