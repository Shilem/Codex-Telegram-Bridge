# 隐私说明

## 本地保存

- Bot Token：独立 0600 文件。
- owner、项目、thread、任务状态、审批、update offset：SQLite。
- 任务正文：默认七天后清空。
- 入站附件和产物：默认二十四小时后删除。
- 脱敏审计：默认三十天后删除。

启动时和每小时执行媒体清理；`/cleanup` 可立即执行媒体、任务正文、审批和审计清理。SQLite 历史页可能在数据库 vacuum 前仍占用磁盘；高隐私环境应配合加密磁盘和受控备份。

## 发送到外部的内容

Telegram 会接触用户发送的消息、附件和 Bot 回复。Codex 服务会接触 owner 明确提交的任务内容以及任务需要读取的项目内容。桥接不会把原始 reasoning、隐藏思维链、Bot Token、数据库或审计日志发送到 Telegram。

## 日志与审计

结构化运行日志不应包含 Token、prompt、命令全文、diff、文件内容或原始 user/chat ID。审计 actor 使用本机随机盐生成指纹，敏感键统一替换为 `[REDACTED]`。

卸载默认保留本地数据。只有显式运行 `ctb uninstall --purge-data` 才删除配置和状态；此操作不可恢复。
