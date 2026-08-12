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

## 快速开始

完成安装、项目注册和配对后，可以按下面的顺序确认服务可用：

```text
/ping
/health
/projects
/status
```

- `/ping` 返回 Telegram 消息进入 Bridge 的延迟，只代表消息链路正常。
- `/health` 检查 App Server、Codex 登录、SQLite、项目数量和状态盘空间；首次使用时应确认结果为“正常”。
- `/projects` 显示主机已注册的项目及其项目 ID，实心圆表示当前项目。
- `/status` 显示当前项目、模型、权限、运行任务和排队数量。

确认无误后，直接像聊天一样发送开发任务。例如：

```text
只读检查当前项目的 Git 状态，并告诉我有哪些未提交修改，不要修改文件。
```

```text
定位登录页提交失败的根因，先说明诊断结果，不要直接修改代码。
```

```text
修复现有测试失败，完成后运行相关测试，并说明修改了哪些文件。
```

Bridge 会先回复任务 ID 和队列状态，然后持续编辑进度消息。计划、工具操作、审批、提问和最终结果会分开展示。一个实例全局同时只运行一个任务；其他任务按进入顺序排队。

## 日常使用流程

### 1. 选择项目

项目只能在主机注册，Telegram 不能添加任意目录：

```bash
ctb project add /absolute/path/to/project --name my-project
ctb project list
```

项目对外显示 UUID 的前八位短 ID；数据库内部仍保留完整 UUID。短 ID 唯一时，CLI 和 Telegram 都可以直接使用。在 Telegram 中执行 `/project`，Bot 会显示所有已启用项目的交互按钮，点击即可切换。也可以直接发送：

```text
/project <project-id>
```

项目切换只影响后续任务，不会把正在执行的任务迁移到另一个目录。`/projects` 作为旧版兼容别名仍可调用，但不会显示在 Telegram `/` 菜单中。禁用项目只能在主机执行 `ctb project disable <project-id>`。默认列表和 Telegram `/project` 会隐藏已禁用项目；`ctb project list --all` 可查看全部记录。没有历史任务或会话引用时，可执行 `ctb project remove <project-id>` 永久移除注册记录；该命令不会删除项目目录中的文件。

### 2. 选择权限

默认权限是 `workspace-write + on-request`，允许在当前项目内工作，并在需要越过常规边界时请求审批。发送 `/permissions` 会显示权限按钮，当前项以 `●` 标记：

```text
/permissions
/permissions read-only
/permissions workspace-write
```

`read-only` 适合代码审查、状态检查和方案分析。`workspace-write` 是日常开发的推荐档位。

完全访问需要先在主机配置中显式设置 `allowDangerFullAccess: true`，再在 Telegram 发送：

```text
/permissions danger-full-access
```

随后必须点击一次性确认按钮。授权只对当前项目生效十五分钟，到期后恢复默认权限。不要为了省去正常审批而长期启用完全访问。

### 3. 提交、查看和取消任务

- 直接发送文本、图片或文件即可创建任务；图片和文件最好在 caption 中写明期望操作。
- `/tasks` 显示当前项目最近十个任务按钮；点击任务进入详情，再按状态选择“取消任务”或“安全重试”。
- `/cancel` 和 `/retry` 仍兼容直接输入，但不显示在 `/` 菜单。
- 服务崩溃时，未确认完成的任务会变成 `unknown`，不会自动重放；确认安全后在任务详情点击“安全重试”。
- 普通 `failed` 任务不能使用 `/retry`，应根据错误原因重新发送任务，避免重复执行有副作用的操作。

任务状态含义：

| 状态 | 含义 | 建议操作 |
| --- | --- | --- |
| `queued` | 等待全局执行槽 | 等待或 `/cancel <task-id>` |
| `running` | Codex 正在处理 | 查看进度，必要时取消 |
| `waiting_input` | Agent 等待补充信息 | 回复对应的 Telegram 消息或点击选项 |
| `waiting_approval` | 等待一次性审批 | 核对项目、目录和操作范围后点击按钮 |
| `completed` | 已完成 | 查看最终结果和产物 |
| `failed` | 已明确失败 | 根据原因修正后重新提交 |
| `cancelled` | 已取消 | 按需重新提交 |
| `unknown` | 崩溃前结果无法确认 | 先核实项目状态，再决定是否 `/retry` |

### 4. 审批和 Agent 提问

- 审批只能通过对应卡片上的一次性按钮完成；回复 `yes`、`1` 或“同意”不会批准操作。
- 审批卡会绑定当前 task、thread、turn 和 item，过期、重复点击或来自旧会话的按钮会被拒绝。
- Agent 的自由文本问题必须回复对应的 Telegram 消息；选择题直接点击按钮。
- App Server 标记为秘密的问题不会在 Telegram 中收集答案，应回到主机 Codex 处理。Telegram 私聊并非端到端加密渠道。

### 5. 会话、模型、推理强度和 Fast 模式

```text
/new
/sessions
/resume <session-id>
/handback
/model
/model <model-name>
/effort
/effort <level>
/fast
/fast <service-tier>
```

- `/new` 关闭当前项目的活跃线程，下一条任务创建新会话。
- `/sessions` 显示当前项目最近的会话按钮；点击进入详情后可恢复会话、交回本机 Codex 或返回列表。
- `/resume` 和 `/handback` 仍兼容直接输入，但不显示在 `/` 菜单。
- `/model` 从 App Server 实时读取本机配置和可用模型；项目没有覆盖时，以本机 Codex 的当前模型为准。
- `/effort` 优先显示本机 Codex 的当前推理强度，并且只展示当前模型真正支持的档位。
- `/fast` 从当前模型的 `serviceTiers` 读取 Fast 能力；可跟随本机设置、显式使用 Standard，或选择本机返回的 Fast 档位。当前本机把 Fast 标识为 `priority`。
- 切换模型会清空项目级推理强度和 Fast 覆盖，重新跟随本机状态，避免形成不兼容组合。
- 每个任务启动时，队列进度消息会显示最终解析出的模型、推理强度和服务档位；日志同时记录设置来源，但不记录任务正文。
- `/health` 显示模型目录最后成功读取时间，并明确标记 App Server 模型刷新超时，而不是把缓存目录误报为实时刷新成功。

### 6. 附件与生成产物

- 入站单文件默认上限为 20 MB，同一用户十分钟最多上传十个附件。
- 出站产物默认上限为 50 MB，只允许回传已注册项目目录或专用产物目录中的文件。
- 附件采用流式下载、实际字节限额和内容类型检查；附件及产物默认保留二十四小时。
- 使用 `/cleanup` 会先展示本地保留范围，点击一次性“确认清理”按钮后才执行。

不要通过 Bot 发送 Token、密码、私钥、生产数据库导出或其他敏感资料。

## Telegram 命令

Bot 启动时会把以下命令同步到 Telegram 私聊的 `/` 菜单。Telegram 菜单本身不支持分隔标题，因此菜单描述使用 `Codex｜` 和 `Bridge｜` 前缀区分两组；发送 `/help` 时会按分组完整展示。

### Codex 工作流

| 命令 | 用途 |
| --- | --- |
| `/new` | 为下一条任务创建新会话 |
| `/sessions` | 使用按钮查看会话详情、恢复会话或 handback |
| `/tasks` | 使用按钮查看任务详情、取消或安全重试 |
| `/model` | 从 App Server 可用模型中选择当前项目默认模型 |
| `/effort` | 从当前模型支持的推理强度中选择 |
| `/fast` | 查看或切换当前模型的 Fast 服务档位 |
| `/permissions` | 使用按钮切换 `read-only`、`workspace-write`、`danger-full-access` |

### Bridge 管理

| 命令 | 用途 |
| --- | --- |
| `/start`、`/help` | 查看身份、安全边界和命令帮助；未配对时 `/start` 生成十分钟配对码 |
| `/project`、`/project <id>` | 使用按钮选择项目，或通过短 ID 直接切换；`/projects` 仅作为兼容别名保留 |
| `/status` | 查看当前项目、模型、权限、运行任务和队列 |
| `/ping` | 只检查 Telegram 收发延迟 |
| `/health` | 检查服务、App Server、Codex 登录、数据库、项目和磁盘 |
| `/cleanup` | 立即执行本地数据保留策略 |
| `/update` | 查看当前版本和签名更新，并通过一次性按钮确认安装 |

菜单中隐藏但继续兼容的命令：`/start`、`/projects`、`/resume <id>`、`/handback`、`/cancel [id]`、`/retry <id>`、`/version`。它们用于首次配对、旧客户端、脚本或排障；日常操作优先使用上面的交互菜单。

`/ping` 只衡量 Telegram 收发路径；`/health` 才检查 App Server、Codex 登录、SQLite、项目和磁盘。

## 主机 CLI

```text
ctb project add <path> --name <name>
ctb project list
ctb project list --all
ctb project disable <id>
ctb project remove <id>
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

常用维护命令：

```bash
# 通用健康检查
ctb doctor

# macOS 查看服务状态和日志
launchctl print gui/$(id -u)/com.shilem.codex-telegram-bridge
tail -f ~/Library/Logs/codex-telegram-bridge/bridge.log
tail -f ~/Library/Logs/codex-telegram-bridge/bridge.error.log

# Linux 查看服务状态和日志
systemctl --user status codex-telegram-bridge.service
journalctl --user -u codex-telegram-bridge.service -f
```

Windows 可在“任务计划程序”中查看 `CodexTelegramBridge`，或执行：

```powershell
schtasks.exe /Query /TN CodexTelegramBridge /V /FO LIST
```

出现问题时先运行 `ctb doctor` 和 Telegram `/health`，再查看对应平台日志。不要同时启动旧版和新版服务，也不要让其他机器使用同一个 Bot Token 运行 `getUpdates`。

详细设计见 [架构](docs/ARCHITECTURE.md)、[安全模型](docs/SECURITY.md)、[隐私](docs/PRIVACY.md)、[迁移](docs/MIGRATION.md)、[排障](docs/TROUBLESHOOTING.md) 和 [发布流程](docs/RELEASE.md)。App Server 协议背景见 [OpenAI App Server 文档](https://learn.chatgpt.com/docs/app-server)。
