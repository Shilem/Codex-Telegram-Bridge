# #0009 历史问题：Telegram 任务卡持续闪烁并被过程内容覆盖

- 2026-08-14T10:48:00Z `issue`: 历史问题：Telegram 任务卡持续闪烁并被过程内容覆盖 [BUG_LOG.md]
- 2026-08-14T10:48:00Z `attempt`: 历史根因：`item/agentMessage/delta` 的 commentary 与 final_answer 共用同一个累加字符串，导致多条过程播报和最终答复堆叠；进度节流只阻止重复计时器，没有阻止上一条 `editMessageText` 尚未完成时继续发起编辑。网络变慢或触发 429 后，大量编辑并发重试，较旧的半截过程消息可能在最终定稿之后返回并覆盖结果。 [BUG_LOG.md] (worked)
- 2026-08-14T10:48:00Z `fix`: 历史修复：按 App Server 的 `itemId` 和 `phase` 独立聚合每条 Agent 消息，以 `item/completed` 正文作为权威结果；commentary 只替换当前进度，不进入最终正文。进度更新改为单一串行 drain，发送中继续合并最新文本，最终定稿先建立终态屏障再等待在途编辑结束。Telegram API 对同一聊天的发送、编辑、删除和文件发送统一串行并保持一秒间隔，429 按官方 `retry_after` 等待并保留结构化限流日志。；验证：单元测试覆盖慢请求期间数百个增量合并、最终定稿不被旧编辑覆盖、多条 commentary 不进入 final_answer、同一聊天一秒限速和持续 429 的可诊断错误；完整检查、发布层测试及重启后的本机服务验收通过。 [BUG_LOG.md]
- 2026-08-14T10:52:38Z `fix`: 历史修复与验证详情已完整归档 [Projectmem 历史问题]
