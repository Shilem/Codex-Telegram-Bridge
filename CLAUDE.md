# Claude Code / Codex 项目约定

请遵守 `AGENTS.md`、`AGENT_BEHAVIOR.md` 和 `BUG_LOG.md`。开始修改前使用 CodeGraph 定位符号与调用链；不要读取或输出用户真实配置、Token、SQLite 数据库、日志和附件。

实现必须保持以下不变量：仅私聊且唯一 owner；全局单运行任务；项目必须由主机预注册；App Server 只使用 stdio；SQLite update/task/approval 事务与崩溃恢复；callback 一次性绑定；完全访问双确认和十五分钟租约；隐藏推理不外发。

提交前运行 `npm run check`。修改安装、迁移、更新或回滚时，再运行 `test/distribution/test_distribution.sh` 和 Shell 语法检查。真实 Bot、三平台服务重启、真实读写审批及自动回滚属于独立人工验收，不能用单元测试冒充。
