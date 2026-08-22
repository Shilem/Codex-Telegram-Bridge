# AI 协作说明

开始任务前先读取并遵守 Projectmem 当前项目指令、摘要和项目地图；历史问题、尝试、修复、决策及关键约束以 Projectmem 为权威来源，不再维护独立 Bug 日志。本项目核心入口是 `src/service.ts` 和 `src/cli.ts`；`src/app-server/` 处理官方 stdio JSON-RPC，`src/storage/` 与 `src/security/` 提供事务账本和授权，`src/telegram/` 负责 Telegram 适配，`deploy/` 与 `scripts/` 负责三平台安装、迁移、更新和回滚。

项目使用 Node.js 24 LTS、TypeScript strict、better-sqlite3 WAL、Vitest 和 ESLint。禁止重新引入 Python/tmux 后端、终端屏幕解析、Codex JSONL 推断、`shell=true` 或绕过审批/沙箱的执行路径。

禁止提交 Bot Token、Chat ID、生产配置、数据库、WAL、会话内容、日志、附件或状态目录。Telegram API、App Server、SQLite、服务管理和更新流程的改动必须包含结构化可验证日志和自动化测试。

所有用户可见提示和项目文档使用简体中文。关键路径记录 `updateId/taskId/threadId/turnId/requestId`、耗时和脱敏结果；不得记录 Bot Token、任务正文、命令全文、diff、附件内容或原始 user/chat ID。错误必须保留原因、影响和可执行的下一步。

所有 Telegram update、任务创建和状态迁移保持事务语义；崩溃后的运行中任务标记为 `unknown`，不得自动重放。普通消息、附件和 callback 统一要求 private chat、已配对 owner user ID 与 private chat ID；callback 必须是一次性、限时且绑定上下文的签名 nonce。每个实例使用独立 Bot，不得让多个 long-poll 消费者共享 Token。

默认权限为 `workspace-write + on-request`。`danger-full-access` 只能由主机显式启用，经 Telegram 二次确认后授予当前项目十五分钟。项目路径和回传文件必须通过 realpath 验证位于预注册根目录或专用产物目录内，拒绝符号链接逃逸。

Plan 模式使用 App Server `collaborationMode/list` 的官方 Plan/Default 预设；`item/completed` 的 `plan` item 是权威结果。Telegram 的执行/跳过按钮必须是一次性互斥动作，执行时恢复生成计划的原 Codex thread 并明确切回 Default 模式。

`/ping` 只检查 Telegram 收发延迟；`/health` 才检查 App Server、Codex 登录、数据库、项目、磁盘和最近错误。`/quota` 先用 `account/read` 判断账户类型：ChatGPT Enterprise 的月度额度读取 `individualLimit`，普通窗口读取 `primary/secondary`；API Key 和 Bedrock 不调用 ChatGPT 额度接口，缺失数值不得本地估算。

定位代码时优先使用仓库 `.codegraph/`：先执行 `codegraph explore` 或 `codegraph node`，代码变化后执行 `codegraph sync`。不要用静默兜底掩盖错误；定位根因并保留可观测性。大型重构先建分支；提交 Git 时使用中文日志，说明需求/问题与实现思路。

最低验证：

```bash
npm run check
test/distribution/test_distribution.sh
git diff --check
```

Windows PowerShell 动态测试由 GitHub Actions `windows-latest` 完成；本机不能验证的平台必须明确保留验收项。
