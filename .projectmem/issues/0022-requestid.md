# #0022 历史问题：审批 requestId 重用导致后续操作永久失败

- 2026-08-14T10:48:06Z `issue`: 历史问题：审批 requestId 重用导致后续操作永久失败 [BUG_LOG.md]
- 2026-08-14T10:48:07Z `attempt`: 历史根因：协议 requestId 被误用作 approvals 主键；重启后 JSON-RPC 数字 ID、同项目危险权限或同版本更新均可能重用。 [BUG_LOG.md] (worked)
- 2026-08-14T10:48:07Z `fix`: 历史修复：数据库迁移为独立随机 `action_id` 主键，requestId 仅作绑定字段；nonce 仍为一次性、限时和上下文绑定。；验证：安全测试覆盖同一 binding 再次创建和消费。 [BUG_LOG.md]
- 2026-08-14T10:52:40Z `fix`: 历史修复与验证详情已完整归档 [Projectmem 历史问题]
