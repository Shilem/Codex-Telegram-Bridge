# Project Map - Codex-Telegram-Bridge

Status: maintained project map.

## Project purpose
通过 Telegram 私聊安全控制本机 Codex App Server

## Stack
- Tags: github-actions, javascript, typescript
- Key libraries: @eslint/js, @types/better-sqlite3, @types/node, @types/proper-lockfile, @typescript-eslint/eslint-plugin, @typescript-eslint/parser, better-sqlite3, commander, eslint, pino
- Detected from: package.json, tsconfig.json, .github/workflows

## Structure
- `src/service.ts` — Bridge 服务入口，装配配置、存储、App Server、Telegram 和调度器
- `src/cli.ts` — 主机侧 `ctb` CLI，负责配对、项目、诊断、迁移、更新和卸载
- `src/app-server/` — Codex App Server stdio JSON-RPC 客户端、transport、模型与额度状态
- `src/telegram/` — Telegram Bot API、命令、callback、消息卡片和控制器
- `src/storage/` — SQLite WAL schema、迁移、事务账本和状态存储
- `src/security/` — owner 鉴权、项目边界、审批 nonce、权限租约和脱敏审计
- `src/scheduler/` — 全局 FIFO 单任务调度
- `src/orchestrator/` — App Server thread/turn 与 Telegram 任务生命周期编排
- `src/media/` — 入站附件校验、隔离、产物回传和保留清理
- `src/update/` — 签名更新、独立 worker、终态恢复和回滚
- `src/runtime/` — 运行时存储适配与任务执行支撑
- `deploy/` — 三平台服务模板、默认配置和更新公钥
- `scripts/` — 安装、迁移、更新、回滚和卸载脚本
- `test/` — Vitest 单元、集成、App Server 合约和发布测试
- `tests/` — 补充测试与夹具
- `docs/` — 架构、安全、隐私、迁移、排障和发布文档
- `README.md` — 面向使用者的安装、配对与日常操作入口
- `AGENTS.md` — 唯一长期、版本化的 AI 协作规范

## Entry points
- `npm run start` → `node dist/service.js`
- `npm run dev` → `npm run build && node dist/service.js`
- `npm run build` → `tsc -p tsconfig.build.json`
- `npm run test` → `vitest run`

## Relationships
- `src/service.ts` 装配 `src/app-server/`、`src/telegram/`、`src/storage/`、`src/security/` 和 `src/scheduler/`
- `src/telegram/controller.ts` 校验 update 后通过 `src/storage/` 落账，并把任务交给调度器
- `src/orchestrator/app-task-executor.ts` 调用 `src/app-server/` 创建或恢复 thread/turn，并把公开事件映射回 Telegram
- `src/security/` 为 Telegram callback、项目文件和危险权限提供边界校验
- `src/update/` 调用 `scripts/update.*` 完成独立更新任务，并在重启后恢复终态通知
- `scripts/install.*` 使用 `deploy/` 模板安装三平台服务，发布行为由 `test/distribution/` 验证
