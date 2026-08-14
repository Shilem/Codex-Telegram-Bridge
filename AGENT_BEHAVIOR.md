# Agent 行为规范

- 所有用户可见提示和项目文档使用简体中文；Bot Token、所有者标识和生产配置只存在于主机本地。
- 运行架构固定为 Node.js 24 + TypeScript + Codex App Server stdio JSON-RPC + SQLite WAL。不得重新引入 tmux、屏幕解析、JSONL 猜测或无沙箱 exec 后端。
- 开始任务前阅读本文件和 `BUG_LOG.md`；关键技术栈、协议或产品边界变化时同步更新 `AGENTS.md`、`CLAUDE.md` 和相关文档。
- 不吞掉 Telegram、App Server、SQLite、安装或更新错误。关键路径记录 `updateId/taskId/threadId/turnId/requestId`、耗时和脱敏结果，用户错误必须说明原因、影响和下一步。
- 绝不记录 Bot Token、任务正文、命令全文、diff、附件内容或用户/聊天原始 ID；审计使用加盐指纹和脱敏元数据。
- 所有 Telegram update、任务创建和任务状态迁移必须保持事务语义；崩溃后的运行中任务标记为 `unknown`，不得自动重放。
- Plan 模式必须使用 App Server `collaborationMode/list` 返回的官方预设；以 `item/completed` 的 `plan` item 作为权威计划。计划操作按钮必须一次性、互斥并绑定生成计划的 Codex thread；“执行计划”固定切回 Default 模式并恢复该 thread。
- 普通消息、附件和 callback 统一要求 private chat、已配对 owner user ID、已配对 private chat ID；所有 callback 必须使用一次性、限时且绑定上下文的签名 nonce。
- 默认权限是 `workspace-write + on-request`。完全访问必须由主机显式启用、Telegram 二次确认并限制当前项目十五分钟；到期不接受新危险任务。
- 项目路径和回传文件必须以 realpath 验证在预注册根目录或专用产物目录内；拒绝符号链接逃逸。
- `/ping` 只检查 Telegram 收发延迟；`/health` 才检查 App Server、Codex 登录、数据库、项目、磁盘和最近错误。
- 每个实例必须使用独立 Bot；不得建议多个 long-poll 消费者共享 Token。
- 大规模重构、实验性协议变更或上游升级先建分支。提交前运行 `npm run check` 和发布层测试。
