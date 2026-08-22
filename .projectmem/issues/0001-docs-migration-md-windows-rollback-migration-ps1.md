# #0001 docs/MIGRATION.md 声称 Windows 无 rollback-migration.ps1，但仓库实际存在该脚本，迁移回滚文档已失真

- 2026-08-14T10:44:43Z `issue`: docs/MIGRATION.md 声称 Windows 无 rollback-migration.ps1，但仓库实际存在该脚本，迁移回滚文档已失真 [docs/MIGRATION.md]
- 2026-08-14T10:49:43Z `attempt`: 将 Windows 回滚说明改为调用现有 scripts/rollback-migration.ps1，并核对参数与脚本实现一致 [docs/MIGRATION.md] (worked)
- 2026-08-14T10:49:47Z `fix`: 迁移文档现已给出 Windows rollback-migration.ps1 的 Backup 与 LatestOffset 调用方式，并保留 offset 安全约束 [docs/MIGRATION.md]
