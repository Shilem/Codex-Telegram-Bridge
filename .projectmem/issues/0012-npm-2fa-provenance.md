# #0012 历史问题：npm 自动发布被 2FA 与私有仓库 provenance 拒绝

- 2026-08-14T10:48:02Z `issue`: 历史问题：npm 自动发布被 2FA 与私有仓库 provenance 拒绝 [BUG_LOG.md]
- 2026-08-14T10:48:02Z `attempt`: 历史根因：首次发布使用普通登录令牌，无法满足 npm 的自动发布 2FA 要求；切换 Granular Token 后，私有 GitHub 仓库又不满足公开包 provenance 的来源可见性要求。 [BUG_LOG.md] (worked)
- 2026-08-14T10:48:02Z `fix`: 历史修复：完成全历史隐私检查后将源码仓库公开；首次发布使用带 2FA bypass 的最小权限令牌；发布成功后建立绑定仓库、`release.yml` 和 `release` environment 的 OIDC Trusted Publisher，删除长期 `NPM_TOKEN` 及工作流引用。；验证：`v1.0.0` npm provenance 与 GitHub Release 成功；release environment 仅保留签名私钥，后续发布通过 OIDC 获取短期凭证。 [BUG_LOG.md]
- 2026-08-14T10:52:39Z `fix`: 历史修复与验证详情已完整归档 [Projectmem 历史问题]
