# 发布流程

## 门禁

```bash
npm ci
npm run check
npm audit --audit-level=high
test/distribution/test_distribution.sh
git diff --check
```

CI 在 macOS、Ubuntu 和 Windows 的 Node.js 24 上运行类型检查、lint、Vitest、构建、安装器测试、依赖审计、secret scan 和 SBOM。App Server initialize 合约应使用真实 Codex CLI；模型调用使用受控测试环境。

## 产物

- npm 包与 provenance
- CycloneDX SBOM
- release archive
- release manifest（版本、产物名、SHA-256）
- detached manifest signature
- `SHA256SUMS`

签名私钥只能存在于受保护的 GitHub release environment；仓库只发布公钥。更新器必须验证 HTTPS、签名、产物名、SHA-256 和版本递增。

官方 npm 包名为 `@shilem/codex-telegram-bridge`。GitHub Release 的安装归档固定命名为 `codex-telegram-bridge.tgz`，使已安装客户端可以通过稳定的 `releases/latest/download` 地址获取后续签名版本。

## 候选版本人工验收

每个候选版本使用独立测试 Bot，在 macOS、Linux 和 Windows 分别验证：安装、配对、项目切换、只读任务、读写审批接受/拒绝、取消、附件、重启、签名更新和健康失败自动回滚。

只有 clean、已同步的 `main`、全部门禁通过、三平台人工验收完成后才创建正式 tag。功能分支通过本地测试或推送不等于正式发布。
