# #0016 历史问题：群聊成员可操作任务与审批

- 2026-08-14T10:48:04Z `issue`: 历史问题：群聊成员可操作任务与审批 [BUG_LOG.md]
- 2026-08-14T10:48:04Z `attempt`: 历史根因：旧版只比较 `chat.id`，callback 未统一检查 `from.id` 和 `chat.type`。 [BUG_LOG.md] (worked)
- 2026-08-14T10:48:04Z `fix`: 历史修复：1.0 使用本机配对锁定唯一 owner；消息、附件和 callback 统一要求 private chat、owner user ID 和 owner private chat ID。所有拒绝进入脱敏审计。；验证：`test/security/security.test.ts` 覆盖群聊、陌生用户和 owner 私聊。 [BUG_LOG.md]
- 2026-08-14T10:52:39Z `fix`: 历史修复与验证详情已完整归档 [Projectmem 历史问题]
