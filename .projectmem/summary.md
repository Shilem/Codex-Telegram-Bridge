# projectmem - Codex-Telegram-Bridge

_Last updated: 2026-08-22_

## Project purpose
通过 Telegram 私聊安全控制本机 Codex App Server

## Recent issues
- [DONE] #legacy_db5a Legacy issue: Merge pull request #2 from Shilem/fix/scoped-npm-package -> Merge pull request #2 from Shilem/fix/scoped-npm-package (fixed)
- [DONE] #legacy_d0a5 Legacy issue: fix: 收口 Telegram 消息与按钮生命周期 -> fix: 收口 Telegram 消息与按钮生命周期 (fixed)
- [DONE] #legacy_c92b Legacy issue: fix: 补齐 PR 秘密扫描读取权限 -> fix: 补齐 PR 秘密扫描读取权限 (fixed)
- [DONE] #legacy_938e Legacy issue: fix: 补齐企业版月度额度展示 -> fix: 补齐企业版月度额度展示 (fixed)
- [DONE] #legacy_8569 Legacy issue: fix: 切换 npm OIDC 可信发布 -> fix: 切换 npm OIDC 可信发布 (fixed)
- [DONE] #legacy_7b9f Legacy issue: fix: 修复三平台 CI 发布检查 -> fix: 修复三平台 CI 发布检查 (fixed)
- [DONE] #legacy_46a7 Legacy issue: fix: 修复签名更新终态反馈 -> fix: 修复签名更新终态反馈 (fixed)
- [DONE] #legacy_16b2 Legacy issue: fix: 修复 Telegram 任务生命周期并补齐额度查询 -> fix: 修复 Telegram 任务生命周期并补齐额度查询 (fixed)
- [DONE] #legacy_056f Legacy issue: fix: 使用作用域 npm 包并固化签名更新源 -> fix: 使用作用域 npm 包并固化签名更新源 (fixed)
- [DONE] #legacy_0013 Legacy issue: Merge pull request #3 from Shilem/fix/npm-trusted-publishing -> Merge pull request #3 from Shilem/fix/npm-trusted-publishing (fixed)
- [DONE] #0052 Linux /update worker 未继承 XDG_RUNTIME_DIR 与 DBUS_SESSION_BUS_ADDRESS，安装完成后 systemctl --user restart 无法连接 user bus，导致更新失败。VPS journal 已复现：Failed to connect to user scope bus。 [src/update/manager.ts:#workerEnvironment] -> #0052 已修复：Linux /update 独立 worker 保留 user systemd bus 环境，安装后可安全重启服务。 [79 项测试、审计与分发测试通过] (fixed)
- [DONE] #0051 Telegram /version 仍硬编码输出 1.0.0，而发布元数据已为 1.1.2；发布后用户会看到错误版本。 [src/telegram/controller.ts:414] -> #0051 已修复：/version 和所有运行入口引用共享版本常量，避免发布版本漂移。 [完整测试与分发校验通过] (fixed)
- [DONE] #0050 重启动作在 Telegram update 未提交时崩溃会遗留 pending；恢复流程跳过它但 request 仍将其视为活跃，导致后续 /restart 永久被拒绝。应终态化未落账动作并通知。 [src/telegram/controller.ts:138] -> #0050 已修复：重启动作仅在 Telegram update 已提交后启动，恢复时取消未落账动作。 [完整测试与分发校验通过] (fixed)
  - Failed attempt: 为未落账重启动作新增终态化接口后，既有恢复测试 mock 未实现 RestartProvider.cancelUncommitted，TypeScript 类型检查失败；需补齐接口 mock。 [test/telegram/restart-notification.test.ts:38]
  - Failed attempt: 未落账取消测试中的 expect.stringContaining 被严格 lint 视为 any；改为读取终态后直接断言失败原因。 [test/update/restart-manager.test.ts:137]
- [DONE] #0049 重启请求只拒绝 launching/running 动作，未拒绝 pending；两个已提交 callback 在 worker 启动前可创建重复重启动作。 [src/update/restart-manager.ts:54] -> #0049 已修复：重启动作创建阶段已按活动状态去重。 [完整测试与分发校验通过] (fixed)
- [DONE] #0048 Linux 重启 worker 的环境白名单未传递 XDG_RUNTIME_DIR 与 DBUS_SESSION_BUS_ADDRESS，systemctl --user restart 可能无法连接 user systemd bus。 [src/update/restart-manager.ts:184] -> #0048 已修复：Linux user systemd 需要的受控会话环境已传递给重启 worker。 [完整测试与分发校验通过] (fixed)
- [DONE] #0047 重启动作在 Telegram update 已提交、独立 worker 尚未启动时若服务退出，会永久保持 pending；启动恢复仅处理非 pending 动作，导致重启及终态通知丢失。 [src/telegram/controller.ts:138] -> #0047 已修复：重启动作按 Telegram update 落账状态恢复，避免崩溃窗口永久 pending。 [完整测试与分发校验通过] (fixed)
  - Failed attempt: 重启恢复回归测试的 launching mock 被 TypeScript 推断为 string，未满足 RestartProvider 返回类型；需保留字面量联合类型。 [test/telegram/restart-notification.test.ts:40]
- [DONE] #0046 归档会话自动替代后，旧 threads 记录仍为 closed_at NULL；同一项目/权限可能出现两个本地活跃会话，导致会话菜单状态失真。 [src/orchestrator/app-task-executor.ts:259] -> 归档会话自动替代时，saveThread 在事务内关闭旧活跃 threads 记录后保存替代会话，恢复每项目/权限档位一个活跃会话的账本一致性。 [src/runtime/store-adapter.ts:103] (fixed)
  - Failed attempt: 首次实现会话替代账本关闭时，saveThread 的可选旧会话参数接收到 string | null | undefined，TypeScript 类型检查失败；需在调用处规范为 undefined。 [src/orchestrator/app-task-executor.ts:260]
  - Failed attempt: 修正可选旧会话 ID 后类型检查通过，但新增 SQLite 回归测试直接断言 .all() 的 any 返回值，被 ESLint 拒绝；需显式标注查询行类型。 [test/storage/database.test.ts:49]
  - Failed attempt: 显式 SQLite 行类型后，Vitest expect.any(Number) 仍因严格 no-unsafe-assignment 被 ESLint 拒绝；改为直接断言 closed_at 的运行时类型。 [test/storage/database.test.ts:49]
- [DONE] #0045 任务恢复复用已归档 Codex thread，App Server 返回 -32600 并导致 Telegram 任务失败；需识别归档会话并建立安全恢复策略 [src/orchestrator/app-task-executor.ts:201] -> 已识别归档会话的 AppServerRpcError(-32600)，自动创建并持久化替代会话后继续任务；其他 resume 错误保持失败可见。已覆盖回归测试并完成全量验证。 [src/orchestrator/app-task-executor.ts:205] (fixed)
- [OPEN] #0044 交互式 zsh 启动时 .zshrc 第 13 行引用缺失的 ~/.langflow/uv/env，虽不影响退出状态但会输出错误 [/Users/lemeng.shi/.zshrc:13] (open)
- [DONE] #0043 交互式终端默认 Node v26 超出项目支持范围，手动执行本项目命令时可能绕过 Node 24 约束 [package.json] -> 安装 Homebrew node@24 并将其 bin 目录置于 zsh PATH 最前；新交互 shell 的 node 为 v24.19.0，npm run check（73 tests）与发布测试均通过。 [/Users/lemeng.shi/.zshrc] (fixed)
  - Failed attempt: 首次追加 Node 24 PATH 的补丁未匹配 .zshrc 文件末尾上下文，未修改用户 shell 配置。 [/Users/lemeng.shi/.zshrc]
- [DONE] #0042 本机 Node 为 v26.5.0，超出项目声明的 >=24 <25 支持范围，当前自动化不能替代 Node 24 验收 [package.json] -> 核实 LaunchAgent 包装脚本与运行中 Bridge PID 均使用 Codex runtime 的 Node v24.19.0；终端默认 Node v26 仅影响交互 shell，不影响正式服务。安装器已通过 ctb_node24_probe 强制 Node 24。 [scripts/install.sh] (fixed)
  - Partial attempt: 通过临时 npx Node v24.19.0 完成完整检查、发布测试与 App Server 合约验证；系统 node 仍为 v26.5.0，未满足本机受支持运行时要求。 [package.json]
- [DONE] #0041 macOS distribution 测试退出 0 但输出 scripts/update.sh:79 的 VERSION 变量 unbound 错误，需单独复现和修复。 [scripts/update.sh:79] -> 已用 ${VERSION} 明确变量边界，并由发布测试断言测试模式更新输出不含 unbound variable；macOS 复现已消失。 [scripts/update.sh:79] (fixed)
- [DONE] #0040 迁入 38 个历史问题后 summary.md 达 32.9 KB，超过 config.toml 的 20 KB 限制并使会话启动上下文膨胀 [.projectmem/summary.md] -> 历史 issue 细节保留在 38 个 issue 文件中，summary.md 已降至约 10.2 KB，低于 20 KB 配置上限 [.projectmem/summary.md] (fixed)
  - Failed attempt: 首次按 JSON 转义文本匹配 38 条历史根因事件，因冒号编码形式不一致匹配为 0，未修改文件 [.projectmem/events.jsonl]
- [DONE] #0039 历史问题：macOS 不能使用 Linux 安装脚本 [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0038 历史问题：新创建的 Codex TUI 会让桥接服务在启动时退出 [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0037 历史问题：macOS LaunchAgent 找不到 Homebrew 安装的 tmux [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0036 历史问题：`/new` 错报“20 秒内未确认” [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0035 历史问题：`/exit` 关闭 Codex tmux 会话 [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0034 历史问题：Telegram `/ping` 延迟约 60 秒 [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0033 历史问题：模型配置选择完成后旧按钮仍然保留 [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0032 历史问题：Telegram 同时保留任务正文与重复的最终结果 [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0031 历史问题：PR 的 Gitleaks 门禁因 GitHub 权限不足失败 [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0030 历史问题：App Server 模型刷新超时只出现在原始 stderr [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0029 历史问题：模型、推理强度和 Fast 状态没有跟随本机 Codex [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0028 历史问题：Telegram 菜单同步无超时导致假运行 [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0027 历史问题：Telegram 中文命令菜单已同步但客户端不可见 [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0026 历史问题：Telegram 命令菜单因语言代码无效而启动失败 [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0025 历史问题：macOS 1.0 LaunchAgent 无法启动 Codex App Server [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0024 历史问题：首次三平台 CI 的发布检查失败 [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0023 历史问题：发布包、原子切换和独立更新任务不可靠 [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0022 历史问题：审批 requestId 重用导致后续操作永久失败 [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0021 历史问题：通知投递、子进程退出与取消竞态冻结任务队列 [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0020 历史问题：App Server turn 失败被误报为成功 [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0019 历史问题：入站媒体无真实大小上限且永久留存 [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0018 历史问题：图片 exec 绕过审批与沙箱 [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0017 历史问题：更新/重启 callback 在 offset 提交前重放 [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0016 历史问题：群聊成员可操作任务与审批 [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0015 历史问题：Windows 发布测试夹具缺少 deploy 目录 [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0014 历史问题：版本化 npm 归档名无法作为稳定更新地址 [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0013 历史问题：npm 包名与既有第三方包冲突 [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0012 历史问题：npm 自动发布被 2FA 与私有仓库 provenance 拒绝 [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0011 历史问题：README 的首次安装路径无法闭环 [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0010 历史问题：Codex 本机登录失效时 Telegram 任务卡没有终态反馈 [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0009 历史问题：Telegram 任务卡持续闪烁并被过程内容覆盖 [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0008 历史问题：Bridge 内执行发布测试时配置夹具被宿主环境覆盖 [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0007 历史问题：取消任务能力存在但 Telegram 菜单不可见 [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0006 历史问题：审批卡展示 App Server 不允许的按钮且缺少额度查询 [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0005 历史问题：Telegram 无法进入 Codex 官方 Plan 模式 [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0004 历史问题：README 与当前 Telegram 功能不一致 [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0003 历史问题：Enterprise 的 Monthly 额度未显示 [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0002 历史问题：Telegram 签名更新确认后没有终态反馈 [BUG_LOG.md] -> 历史修复与验证详情已完整归档 [Projectmem 历史问题] (fixed)
- [DONE] #0001 docs/MIGRATION.md 声称 Windows 无 rollback-migration.ps1，但仓库实际存在该脚本，迁移回滚文档已失真 [docs/MIGRATION.md] -> 迁移文档现已给出 Windows rollback-migration.ps1 的 Backup 与 LatestOffset 调用方式，并保留 offset 安全约束 [docs/MIGRATION.md] (fixed)

## Decisions
- 历史问题、失败尝试、修复与验证统一由 Projectmem 管理；仓库不再维护 BUG_LOG.md，长期工程约束统一维护在 AGENTS.md，CLAUDE.md 仅作为兼容入口 [AGENTS.md]
- Projectmem MCP 改为仓库级 .codex/config.toml，并以 cwd 绑定 Codex-Telegram-Bridge；全局配置不再拥有项目专属 --root。 [.codex/config.toml]
- Projectmem 项目级 MCP 同时设置 Codex cwd 与 Projectmem --root；--root 作为最高优先级项目绑定，防止客户端启动目录变化导致跨仓库读取 [.codex/config.toml]
- Bridge 重启采用一次性持久化动作和独立 worker：Telegram callback 先消费并落账，再由 worker 调用平台服务管理器，重启后的新实例恢复并发送终态；禁止直接由 callback 结束当前进程。 [src/update/]

## Notes
- ci: 升级 Node 24 运行时工作流依赖
- test: 修复 Windows 更新测试兼容性
- 已将原 BUG_LOG.md 的 38 个历史问题逐条迁移为 Projectmem 已关闭 issue，每条保留历史根因、修复和验证信息；可用“历史问题：”检索 [Projectmem]
- 已核查重启路径：现有更新动作会先持久化，再由独立 worker 调用平台服务管理器；重启功能应复用该模式，避免在 Telegram update 的 offset 落账前结束当前进程。 [src/update/manager.ts]
- High churn detected: test/update/restart-manager.test.ts (4 edits in 10 min) [test/update/restart-manager.test.ts]
- High churn detected: src/update/restart-worker.ts (4 edits in 10 min) [src/update/restart-worker.ts]
- 已实现经 Telegram /restart 二次确认的安全 Bridge 重启：确认动作先持久化，服务提交 Telegram offset 后才启动独立 worker；Linux/macOS/Windows 分别使用既有服务管理器命令，重启后恢复 Telegram 终态。验证：npm run check（73 tests）、distribution test、git diff --check。 [src/update/restart-manager.ts]
- 本机 npm 配置的 npm.shopee.io 镜像不支持 npm audit API；发布审计须显式使用 https://registry.npmjs.org，已验证为 0 vulnerabilities。 [docs/RELEASE.md]
- High churn detected: test/telegram/restart-notification.test.ts (4 edits in 10 min) [test/telegram/restart-notification.test.ts]
- High churn detected: test/update/restart-manager.test.ts (4 edits in 10 min) [test/update/restart-manager.test.ts]

## Key files
- `BUG_LOG.md`
- `npm-shrinkwrap.json`
- `package.json`
- `test/distribution/test_distribution.sh`
- `README.md`
- `scripts/install.sh`
- `src/app-server/index.ts`
- `src/app-server/model-state.ts`
- `src/app-server/types.ts`
- `src/cli.ts`
- `src/core/types.ts`
- `src/orchestrator/app-task-executor.ts`
- `src/runtime/store-adapter.ts`
- `src/security/projects.ts`
- `src/service.ts`
- `src/storage/schema.ts`
- `src/storage/types.ts`
- `src/telegram/api.ts`
- `src/telegram/commands.ts`
- `src/telegram/controller.ts`

## Open questions
- None logged yet.
