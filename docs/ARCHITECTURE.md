# 架构说明

## 目标与边界

Codex Telegram Bridge 是单用户、单 Bot、自托管的远程开发客户端。服务不监听 HTTP 或 WebSocket 端口，只在本机启动 `codex app-server --listen stdio://`。所有工作区必须由主机 CLI 预注册，全局最多运行一个 Codex turn。

## 模块

- `src/telegram/`：Bot API 长轮询、消息编辑、按钮、附件下载、速率限制和命令路由。
- `src/app-server/`：基于 JSONL 的 JSON-RPC transport、initialize、thread、turn、interrupt、通知和服务端请求。
- `src/storage/`：SQLite WAL、事务迁移、任务状态机、Telegram update 幂等、thread/turn 绑定。
- `src/security/`：本机配对、owner 鉴权、项目 realpath 边界、审批 nonce、危险权限租约和脱敏审计。
- `src/scheduler/`：全局 FIFO 单任务队列。
- `src/orchestrator/`：把任务映射为 App Server thread/turn，把公开事件映射到 Telegram。
- `src/media/`：媒体隔离、magic 检测、回传边界和保留清理。
- `src/update/`：签名清单、版本递增检查、权限受限的持久化更新动作和独立 worker。worker 由当前 Node.js 24 绝对路径启动，只向安装脚本传递白名单环境，并原子记录成功、失败或自动回滚结果；Bridge 重启后恢复未通知动作并回写原 Telegram 消息。
- `src/cli.ts`：仅主机可执行的配对、项目、doctor、迁移、更新、回滚和卸载。

## 数据流

1. 长轮询取得 update，控制器先检查 SQLite 是否已处理。
2. 统一验证 chat type、owner user ID 和 private chat ID。
3. 普通任务在一个事务内写入 update 和 task，并从 `received` 转为 `queued`。
4. 调度器按创建时间领取一个任务并转为 `running`。
5. 编排器创建或恢复绑定相同项目与权限档的 App Server thread，再创建 turn。
6. 公开计划、工具事件和回答流向 Telegram；原始 reasoning 和 raw response 被策略层拦截。
7. 服务端审批和提问暂停任务；一次性 callback 或对指定消息的回复恢复执行。
8. turn 完成、失败或中断后写入终态。进程崩溃留下的运行中工作在下次启动转为 `unknown`。

## SQLite

启动时固定执行：

```text
PRAGMA journal_mode=WAL
PRAGMA foreign_keys=ON
PRAGMA synchronous=FULL
PRAGMA busy_timeout=5000
```

迁移在事务中执行，版本记录在 `schema_migrations`。核心业务表为 `owners`、`pairing_codes`、`projects`、`threads`、`telegram_updates`、`tasks`、`task_events`、`approvals`、`permission_leases`、`audit_events` 和 `runtime_settings`。

任务状态：

```text
received → queued → running
running ↔ waiting_input / waiting_approval
running → completed / failed / cancelled / unknown
waiting_* → failed / cancelled / unknown
unknown → queued / completed / failed / cancelled（仅显式操作）
```

`received`、`queued` 也可在执行前进入 `failed` 或 `cancelled`；等待输入或审批的任务可恢复为 `running`，也可进入失败、取消或 `unknown`。

## App Server 协议

协议字段以当前 Codex App Server schema 为准；升级 Codex CLI 时可使用 `codex app-server generate-ts --out <directory>` 生成对照类型，并运行真实 App Server 合约测试。握手顺序为 `initialize` → `initialized`；任务主路径使用 `thread/start`、`thread/resume`、`turn/start` 和 `turn/interrupt`，并通过 `collaborationMode/list`、`config/read`、`model/list` 与账户接口读取实时能力。审批绑定 `requestId + threadId + turnId + itemId`。

参考：[OpenAI App Server](https://learn.chatgpt.com/docs/app-server)。
