# #0015 历史问题：Windows 发布测试夹具缺少 deploy 目录

- 2026-08-14T10:48:03Z `issue`: 历史问题：Windows 发布测试夹具缺少 deploy 目录 [BUG_LOG.md]
- 2026-08-14T10:48:03Z `attempt`: 历史根因：Windows 安装器新增公钥部署后，测试夹具仍只复制 `scripts` 和 `dist`，与真实 npm 包结构不一致，导致 CI 找不到 `deploy/update-public-key.pem`。 [BUG_LOG.md] (worked)
- 2026-08-14T10:48:03Z `fix`: 历史修复：Windows 发布测试构造完整的 `deploy` 夹具，并断言公钥文件与更新配置均正确安装。；验证：PR 的 Windows Node.js 24 发布任务通过。 [BUG_LOG.md]
- 2026-08-14T10:52:39Z `fix`: 历史修复与验证详情已完整归档 [Projectmem 历史问题]
