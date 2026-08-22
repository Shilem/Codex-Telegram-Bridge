# #0028 历史问题：Telegram 菜单同步无超时导致假运行

- 2026-08-14T10:48:10Z `issue`: 历史问题：Telegram 菜单同步无超时导致假运行 [BUG_LOG.md]
- 2026-08-14T10:48:10Z `attempt`: 历史根因：非长轮询 Telegram API 请求没有硬超时。服务启动时同步命令菜单若遇到连接不返回，Node 进程与 LaunchAgent 都显示运行，但服务尚未启动 App Server 和 `getUpdates`。 [BUG_LOG.md] (worked)
- 2026-08-14T10:48:10Z `fix`: 历史修复：所有未显式传入取消信号的 Telegram API 单次请求增加二十秒硬超时，继续沿用有限次数重试；长轮询仍使用调用方 AbortSignal。命令菜单作为辅助能力改为后台同步，失败明确记录但不阻塞 App Server 与 long-poll，后续重启再次尝试。；验证：超时请求记录 method、attempt 和错误，核心服务仍进入“已启动”状态并正常接收消息，不再无限卡住或呈现假健康。 [BUG_LOG.md]
- 2026-08-14T10:52:41Z `fix`: 历史修复与验证详情已完整归档 [Projectmem 历史问题]
