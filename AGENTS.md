# AI 协作说明

开始任务前阅读 `AGENT_BEHAVIOR.md` 与 `BUG_LOG.md`。本项目以 `src/codex_repl_bridge.py` 为核心，`deploy/` 保存可公开模板，`scripts/` 负责安装和更新。

禁止提交 Bot Token、Chat ID、生产环境配置、会话 JSONL、日志或状态文件。对 Telegram API、tmux 和 systemd 的改动必须包含可验证日志，并在测试通过后更新文档。

大规模重构或上游升级必须先建分支。不要用静默兜底掩盖错误；应定位根因并保留可观测性。
