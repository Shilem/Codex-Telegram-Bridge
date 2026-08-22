# #0017 历史问题：更新/重启 callback 在 offset 提交前重放

- 2026-08-14T10:48:04Z `issue`: 历史问题：更新/重启 callback 在 offset 提交前重放 [BUG_LOG.md]
- 2026-08-14T10:48:04Z `attempt`: 历史根因：旧 handler 内直接重启进程，Telegram offset 尚未持久化，重启后会再次收到同一 update；旧按钮还可能触发降级。 [BUG_LOG.md] (worked)
- 2026-08-14T10:48:04Z `fix`: 历史修复：update 与所有 callback 使用持久化一次性 action；点击后先事务消费，再重新验证远端签名和版本递增，安装器原子切换并在健康失败时回滚。；验证：安全 nonce、版本降级、签名、篡改拒绝和发布层更新测试。 [BUG_LOG.md]
- 2026-08-14T10:52:39Z `fix`: 历史修复与验证详情已完整归档 [Projectmem 历史问题]
