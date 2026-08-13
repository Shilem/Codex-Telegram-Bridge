# Bug 日志

此文档记录已定位根因、修复和验证方式；返工或纠正时先阅读并更新对应条目。

## 1.0 架构修复

### npm 包名与既有第三方包冲突

- 根因：无作用域包名 `codex-telegram-bridge` 已由其他 npm 账号持有，当前发布账号无法发布 1.0.0；若继续沿用还会让用户误装第三方旧包。
- 修复：官方 npm 包改为 `@shilem/codex-telegram-bridge`；CLI 名称、服务标识和本机数据目录保持兼容。
- 验证：完整检查和发布层测试通过，`npm pack` 产物元数据必须显示作用域包名，随后由签名 Release 工作流发布。

### 版本化 npm 归档名无法作为稳定更新地址

- 根因：作用域 npm 包每个版本生成不同的 tgz 文件名，而客户端配置使用固定 `releases/latest/download` URL；直接引用版本化文件会让旧安装无法发现下一版。
- 修复：npm 继续发布原生作用域包，GitHub Release 额外统一输出 `codex-telegram-bridge.tgz`；签名清单、SHA-256 和安装器均以该稳定产物为准。安装时同时部署仓库内公钥和默认 HTTPS 更新源。
- 验证：发布工作流断言锁文件已注入固定归档，安装器测试覆盖公钥复制及更新配置。

### 群聊成员可操作任务与审批

- 根因：旧版只比较 `chat.id`，callback 未统一检查 `from.id` 和 `chat.type`。
- 修复：1.0 使用本机配对锁定唯一 owner；消息、附件和 callback 统一要求 private chat、owner user ID 和 owner private chat ID。所有拒绝进入脱敏审计。
- 验证：`test/security/security.test.ts` 覆盖群聊、陌生用户和 owner 私聊。

### 更新/重启 callback 在 offset 提交前重放

- 根因：旧 handler 内直接重启进程，Telegram offset 尚未持久化，重启后会再次收到同一 update；旧按钮还可能触发降级。
- 修复：update 与所有 callback 使用持久化一次性 action；点击后先事务消费，再重新验证远端签名和版本递增，安装器原子切换并在健康失败时回滚。
- 验证：安全 nonce、版本降级、签名、篡改拒绝和发布层更新测试。

### 图片 exec 绕过审批与沙箱

- 根因：旧图片模式使用危险的 bypass 参数，并可在用户 HOME 工作。
- 修复：旧 Python/tmux/exec 后端已移除。图片作为受限附件提交给预注册项目的 App Server turn，使用项目权限档和正常审批。
- 验证：仓库不再包含 bypass/exec 图片路径；项目边界和 MIME 测试通过。

### 入站媒体无真实大小上限且永久留存

- 根因：旧下载逻辑先把响应累积到内存，只限制出站附件，媒体长期保存在状态目录。
- 修复：声明大小、Telegram 大小、Content-Length、实际字节四层检查；流式写 0600 临时文件后原子改名；附件限速、magic 验证、二十四小时清理。
- 验证：媒体路径、符号链接逃逸、超限和清理逻辑由 Vitest 覆盖。

### App Server turn 失败被误报为成功

- 根因：初版编排器收到 `turn/completed` 时未检查 `turn.status`，且把 `willRetry=true` 的错误提前终止。
- 修复：只有 `status=completed` 才发送最终成功；failed/interrupted 映射明确失败；可重试错误只显示重试进度。缺少 thread/turn 的全局通知不归入当前任务。
- 验证：App Server 合约测试与严格事件类型检查通过。

### 通知投递、子进程退出与取消竞态冻结任务队列

- 根因：初版通知异步异常无人接管，App Server 已退出的活跃 turn Promise 不会结束；取消又在 interrupt 之后落账，可能和 completed 竞争。
- 修复：通知按序串行并统一接管异常；App Server 暴露 fatal 事件并拒绝所有活跃任务；取消先持久化终态，关停任务标记 `unknown`，审批和提问 Promise 同步撤销；资源释放带超时且逐项记录失败。
- 验证：类型、调度器测试、App Server transport/合约测试通过。

### 审批 requestId 重用导致后续操作永久失败

- 根因：协议 requestId 被误用作 approvals 主键；重启后 JSON-RPC 数字 ID、同项目危险权限或同版本更新均可能重用。
- 修复：数据库迁移为独立随机 `action_id` 主键，requestId 仅作绑定字段；nonce 仍为一次性、限时和上下文绑定。
- 验证：安全测试覆盖同一 binding 再次创建和消费。

### 发布包、原子切换和独立更新任务不可靠

- 根因：npm 默认不打包 lockfile，Unix symlink 替换在 GNU/BSD 行为不同，服务内 updater 可能随服务一起被杀，迁移回滚又未严格保存唯一 offset。
- 修复：签名 tarball 显式注入 shrinkwrap；版本目录通过原子 current 指针切换；更新交给 systemd/launchd/Task Scheduler 独立任务；迁移精确备份和回写 offset，失败闭合；CI action 固定完整 SHA。
- 验证：Unix 安装、1.0→1.1、回滚和 shell 语法测试通过；三平台真实服务验收保留为发布门禁。

### 首次三平台 CI 的发布检查失败

- 根因：Unix 权限测试用 BSD `stat -f` 与 GNU `stat -c` 的短路组合，GNU `stat -f` 会成功返回文件系统信息而不会进入备用命令；同时 `tsx` 固定的旧 esbuild 与 Vitest/Vite 新版本约束冲突，导致 `npm sbom` 把依赖树判为 invalid。
- 修复：权限检查按 `uname` 明确选择 stat 方言；移除仅用于便捷开发命令的 `tsx`，开发脚本改为先编译再运行，重新生成 shrinkwrap。
- 验证：本机 Node 24 完整检查、Unix 发布测试和 `npm sbom --sbom-format cyclonedx` 通过；修复推送后重新等待三平台 CI。

### macOS 1.0 LaunchAgent 无法启动 Codex App Server

- 根因：服务启动器只用绝对路径执行 Bridge 的 Node 24，却没有把该 Node 目录写入 `PATH`。Homebrew 的 `codex` 启动脚本使用 `/usr/bin/env node`，而 launchd 默认 `PATH` 只有系统目录，因此 App Server 以退出码 127 终止。
- 修复：Unix 服务启动器固定写入安装时验证过的 Node 与 Codex 可执行文件目录，再追加系统目录；不依赖交互式 shell 环境。
- 验证：发布测试断言生成的启动器包含确定性 `PATH`；本机 LaunchAgent 日志不再出现 `env: node: No such file or directory`，并需通过 `ctb doctor`。

### Telegram 命令菜单因语言代码无效而启动失败

- 根因：首次实现 `setMyCommands` 时使用了区域代码 `zh-hans`，但 Telegram Bot API 的 `language_code` 只接受两位 ISO 639-1 代码，返回 `Bad Request: invalid language code specified`。
- 修复：简体中文私聊命令菜单统一使用 Telegram 接受的 `zh`，命令描述通过 `Codex｜` 与 `Bridge｜` 前缀分组。
- 验证：本机启动日志包含“Telegram 私聊命令菜单已同步”，LaunchAgent 保持运行，并在 Telegram `/` 菜单人工确认两组命令。

### Telegram 中文命令菜单已同步但客户端不可见

- 根因：服务只写入了 `language_code=zh` 的私聊菜单，Telegram 默认私聊菜单仍为空。客户端语言匹配并不保证使用 `zh` 这个精确语言代码，因此服务端已有二十条命令，用户端仍可能显示空菜单。
- 修复：启动时先同步不带语言代码的默认私聊菜单，再同步 `zh` 中文私聊菜单；任何一步失败都明确中止启动并由服务管理器重试。
- 验证：`getMyCommands` 对默认和 `zh` 两个作用域都返回二十条命令，随后在真实 Telegram 私聊中输入 `/` 验收。

### Telegram 菜单同步无超时导致假运行

- 根因：非长轮询 Telegram API 请求没有硬超时。服务启动时同步命令菜单若遇到连接不返回，Node 进程与 LaunchAgent 都显示运行，但服务尚未启动 App Server 和 `getUpdates`。
- 修复：所有未显式传入取消信号的 Telegram API 单次请求增加二十秒硬超时，继续沿用有限次数重试；长轮询仍使用调用方 AbortSignal。命令菜单作为辅助能力改为后台同步，失败明确记录但不阻塞 App Server 与 long-poll，后续重启再次尝试。
- 验证：超时请求记录 method、attempt 和错误，核心服务仍进入“已启动”状态并正常接收消息，不再无限卡住或呈现假健康。

### 模型、推理强度和 Fast 状态没有跟随本机 Codex

- 根因：模型列表虽来自 App Server，但“当前值”只读取项目数据库覆盖或目录默认项；未读取 `config/read` 的本机有效配置，也没有保存和传递 App Server 的 `serviceTier`。
- 修复：菜单与 `/status` 按“项目覆盖 → 当前工作区的本机 Codex 配置 → 模型目录默认”解析有效状态；Fast 档位直接读取当前模型的 `serviceTiers`，项目级选择存入 SQLite 并传给 thread/turn。清除项目覆盖后恢复跟随本机。
- 验证：交互测试覆盖本机模型、`low` 推理强度和 `default` 服务档位的展示；真实 App Server 合约检查确认本机 Fast 档位为 `priority`。

### App Server 模型刷新超时只出现在原始 stderr

- 根因：Codex App Server 的模型管理器会在后台刷新目录，超时仅通过 stderr 输出；桥接此前没有把它纳入健康状态，用户无法区分“实时目录正常”与“正在使用已有目录”。
- 修复：模型状态组件跟踪最后一次成功 `model/list` 和最近一次刷新告警；`/health` 明确显示目录可用但刷新有告警。任务启动日志与进度卡记录最终模型、推理强度、服务档位及项目/本机来源。
- 验证：单元测试覆盖本机配置、隐藏模型过滤、动态 Fast 档位和刷新告警；本机服务日志应出现模型目录读取成功，并在上游超时时保留结构化告警。

### PR 的 Gitleaks 门禁因 GitHub 权限不足失败

- 根因：CI 将全局权限限制为 `contents: read`，但 Gitleaks 在 `pull_request` 事件中需要读取 PR 提交列表；GitHub API 返回 `403 Resource not accessible by integration`，并非扫描发现秘密。
- 修复：只增加 Gitleaks 所需的 `pull-requests: read`，保持其余默认写权限关闭。
- 验证：PR CI 的 secret-scan 必须成功；三平台构建、App Server 合约和 SBOM 门禁继续保持通过。

### Telegram 同时保留任务正文与重复的最终结果

- 根因：任务排队消息被复用为流式进度卡片并写入完整回复，但 `turn/completed` 又单独发送最终结果；完成时只清理内存映射，没有更新或删除原进度消息。
- 修复：完成时直接把原任务卡片更新为最终结果并移除取消按钮；只有正文超过 Telegram 单条长度限制时才额外发送后续分段。
- 验证：Telegram Gateway 回归测试断言单段最终正文只编辑原消息、不调用 `sendMessage`。

### 模型配置选择完成后旧按钮仍然保留

- 根因：模型、思考深度和 Fast 的 callback 在写入设置后重新渲染完整选择菜单，导致已使用的一次性按钮仍显示在消息中。
- 修复：所有终态 callback 都将原消息更新为结果卡片，并传入空键盘明确移除全部按钮；列表、详情和返回等导航 callback 继续保留按钮。
- 验证：交互测试覆盖项目、模型、思考深度、Fast、权限和取消操作，断言终态结果卡片使用空键盘。

## 0.9 旧版历史（已由 1.0 后端移除）

### 已解决

### Telegram `/ping` 延迟约 60 秒

- 根因：`getUpdates` 使用了通用 60 秒 HTTP 超时和重试，即使 Telegram 长轮询配置为 2 秒，主循环仍会被阻塞。
- 修复：轮询请求使用 `poll_timeout + 3` 秒硬超时、单次尝试；失败后记录 `POLL` 日志并在 2 秒后重试。
- 验证：日志应显示较低的 `PING telegram_age_ms`；`sendMessage elapsed_ms` 单独衡量出站耗时。

### `/exit` 关闭 Codex tmux 会话

- 根因：桥接原样转发 `/exit`，Codex 退出后 tmux server 消失。
- 修复：拦截 `/exit` 和 `/quit`；`CRB_AUTO_RECOVER_TMUX=1` 时自动新建目标 tmux/Codex 会话。
- 验证：Telegram `/exit` 返回拦截提示；会话异常消失后日志包含 `tmux recovery session ready`。

### `/new` 错报“20 秒内未确认”

- 根因：Codex 在新会话收到第一条真实任务时才懒创建 JSONL，不能以 `/new` 后立即变更 JSONL 作为成功条件。
- 修复：检测 `/new` 是否被 TUI 拒绝；未拒绝则立即确认已切换到新对话。
- 验证：`/new` 约 1 秒内收到成功中文提示。

### 平台兼容性

### macOS LaunchAgent 找不到 Homebrew 安装的 tmux

- 根因：launchd 的默认 `PATH` 只有系统目录，不包含 Apple Silicon Homebrew 的 `/opt/homebrew/bin`；桥接进程启动后无法执行 `tmux`。
- 修复：安装脚本在安装时解析 Python、tmux 和 Codex CLI 的实际目录，并将其写入启动器的 `PATH`。
- 验证：重装后 `bridge.log` 不再出现 `No such file or directory: 'tmux'`，且 `tmux -L codex has-session -t codex` 成功。

### 新创建的 Codex TUI 会让桥接服务在启动时退出

- 根因：Codex 在首次实际提交任务后才创建 JSONL 会话文件，但桥接在主循环启动前强制要求该文件存在，导致 LaunchAgent 以退出码 2 重启。
- 修复：仅对“尚无 Codex TUI JSONL”这一预期的新会话状态记录等待日志并继续启动，后台每 30 秒报告一次等待状态；其他会话定位错误仍然抛出。JSONL 线程会在首个 TUI 回合创建后自动绑定。
- 验证：新 tmux/Codex 会话启动后日志包含 `startup waiting for Codex session JSONL`，服务保持运行；提交首条任务后出现 `watching ...rollout-*.jsonl`。

### macOS 不能使用 Linux 安装脚本

- 根因：早期安装脚本固定写入 systemd 用户服务，而 macOS 用 launchd。
- 修复：安装脚本根据平台写入 Linux systemd unit 或 macOS LaunchAgent，并用对应服务管理器重启。
- 验证：macOS 执行 `launchctl print gui/$(id -u)/com.codex-telegram-bridge.codex`。
