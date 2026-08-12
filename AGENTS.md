# AI 协作说明

开始任务前完整阅读 `AGENT_BEHAVIOR.md` 与 `BUG_LOG.md`。本项目核心入口是 `src/service.ts` 和 `src/cli.ts`；`src/app-server/` 处理官方 stdio JSON-RPC，`src/storage/` 与 `src/security/` 提供事务账本和授权，`src/telegram/` 负责 Telegram 适配，`deploy/` 与 `scripts/` 负责三平台安装、迁移、更新和回滚。

项目使用 Node.js 24 LTS、TypeScript strict、better-sqlite3 WAL、Vitest 和 ESLint。禁止重新引入 Python/tmux 后端、终端屏幕解析、Codex JSONL 推断、`shell=true` 或绕过审批/沙箱的执行路径。

禁止提交 Bot Token、Chat ID、生产配置、数据库、WAL、会话内容、日志、附件或状态目录。Telegram API、App Server、SQLite、服务管理和更新流程的改动必须包含结构化可验证日志和自动化测试。

定位代码时优先使用仓库 `.codegraph/`：先执行 `codegraph explore` 或 `codegraph node`，代码变化后执行 `codegraph sync`。不要用静默兜底掩盖错误；定位根因并保留可观测性。大型重构先建分支；提交 Git 时使用中文日志，说明需求/问题与实现思路。

最低验证：

```bash
npm run check
test/distribution/test_distribution.sh
git diff --check
```

Windows PowerShell 动态测试由 GitHub Actions `windows-latest` 完成；本机不能验证的平台必须明确保留验收项。
