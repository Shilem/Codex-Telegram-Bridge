# #0031 历史问题：PR 的 Gitleaks 门禁因 GitHub 权限不足失败

- 2026-08-14T10:48:11Z `issue`: 历史问题：PR 的 Gitleaks 门禁因 GitHub 权限不足失败 [BUG_LOG.md]
- 2026-08-14T10:48:12Z `attempt`: 历史根因：CI 将全局权限限制为 `contents: read`，但 Gitleaks 在 `pull_request` 事件中需要读取 PR 提交列表；GitHub API 返回 `403 Resource not accessible by integration`，并非扫描发现秘密。 [BUG_LOG.md] (worked)
- 2026-08-14T10:48:12Z `fix`: 历史修复：只增加 Gitleaks 所需的 `pull-requests: read`，保持其余默认写权限关闭。；验证：PR CI 的 secret-scan 必须成功；三平台构建、App Server 合约和 SBOM 门禁继续保持通过。 [BUG_LOG.md]
- 2026-08-14T10:52:41Z `fix`: 历史修复与验证详情已完整归档 [Projectmem 历史问题]
