# #0035 历史问题：`/exit` 关闭 Codex tmux 会话

- 2026-08-14T10:48:14Z `issue`: 历史问题：`/exit` 关闭 Codex tmux 会话 [BUG_LOG.md]
- 2026-08-14T10:48:14Z `attempt`: 历史根因：桥接原样转发 `/exit`，Codex 退出后 tmux server 消失。 [BUG_LOG.md] (worked)
- 2026-08-14T10:48:14Z `fix`: 历史修复：拦截 `/exit` 和 `/quit`；`CRB_AUTO_RECOVER_TMUX=1` 时自动新建目标 tmux/Codex 会话。；验证：Telegram `/exit` 返回拦截提示；会话异常消失后日志包含 `tmux recovery session ready`。 [BUG_LOG.md]
- 2026-08-14T10:52:42Z `fix`: 历史修复与验证详情已完整归档 [Projectmem 历史问题]
