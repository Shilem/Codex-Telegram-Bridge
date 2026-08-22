# #0010 历史问题：Codex 本机登录失效时 Telegram 任务卡没有终态反馈

- 2026-08-14T10:48:00Z `issue`: 历史问题：Codex 本机登录失效时 Telegram 任务卡没有终态反馈 [BUG_LOG.md]
- 2026-08-14T10:48:01Z `attempt`: 历史根因：任务调度器只将执行异常写入 SQLite 和本机日志；`AppServerTaskExecutor` 未把异常回传给 Telegram。认证失效导致 App Server 以 401 终止时，任务进度卡会被取消或停留在运行状态，用户看不到原因和恢复步骤。 [BUG_LOG.md] (worked)
- 2026-08-14T10:48:01Z `fix`: 历史修复：执行器在所有非取消异常上发送终态失败卡；识别 `token_invalidated`、401 和登录刷新失败，明确提示本机 Codex/ChatGPT 重新登录并重启 Bridge。其他错误也展示原因、影响与 `/health` 后的重试步骤；通知投递失败会记录结构化错误，不覆盖原任务错误。；验证：执行器单元测试覆盖失效登录的 Telegram 失败提示；Gateway 测试覆盖失败时复用原进度卡、清除按钮并标记“任务失败”。 [BUG_LOG.md]
- 2026-08-14T10:52:38Z `fix`: 历史修复与验证详情已完整归档 [Projectmem 历史问题]
