# 安全模型

## 信任边界

受信任：运行服务的本机账户、本机 Codex CLI、已配对 owner、预注册项目和签名发布密钥。

不受信任：所有 Telegram update 内容、群聊成员、陌生私聊、callback data、文件名、MIME 声明、Content-Length、符号链接、更新下载地址和旧按钮。

## 身份

首次 `/start` 只在 private chat 生成十分钟一次性配对码。`ctb pair <code>` 必须在主机执行，成功后数据库只允许一个未吊销 owner。后续每条消息、附件和 callback 同时检查：

- `chat.type === private`
- `from.id` 等于 owner Telegram user ID
- `chat.id` 等于 owner private chat ID

拒绝只进入脱敏审计，不记录原始 user/chat ID。

除 `/start`、`/help`、`/ping` 外，默认拒绝接收时间超过十分钟的普通消息和命令，避免服务停机期间积压的旧操作在恢复后执行；时限可通过 `maxUpdateAgeMinutes` 调整。callback 另由一次性 nonce 的有效期约束。

## 审批与 callback

审批 action ID 使用随机 nonce、HMAC 签名和 SHA-256 存储，绑定 request/thread/turn/item，有到期时间且只能消费一次。选择题、任务取消、危险权限、更新和取消按钮也使用持久化一次性 action。普通文本 `yes` 或 `1` 不会批准命令或文件修改。

## 权限

- `read-only`
- `workspace-write + on-request`（默认）
- `danger-full-access`

完全访问只有在 `allowDangerFullAccess=true` 且 owner 在 Telegram 二次确认后才生成十五分钟当前项目租约。租约到期后新任务失败闭合；危险 thread 被关闭，项目恢复默认权限。已经运行的任务允许完成。

## 文件与媒体

- 入站声明大小、Telegram `getFile` 大小、HTTP Content-Length 和实际流式字节均检查。
- 临时文件 0600，目录 0700，写入同步后原子改名。
- 图片使用 magic bytes 验证；文件名净化，不参与 shell 拼接。
- 出站文件经过 realpath，只允许预注册项目或专用产物目录；符号链接逃逸被拒绝。
- 默认入站 20 MB、出站 50 MB；每个 owner 十分钟最多十个附件。

## 更新

更新地址必须是 HTTPS；release manifest 使用本地公钥验证签名，产物再校验 SHA-256。只允许版本递增。Telegram 更新按钮一次性且十分钟过期；点击后重新下载并验证最新清单，旧按钮和远端版本变化均拒绝。新版本安装到独立目录，原子切换 `current`，doctor 失败自动恢复旧指针。

## 已知边界

Telegram Bot 私聊不是端到端加密。主机账户被攻破、Codex CLI 或发布私钥被攻破不在本服务能够完全抵御的范围内。管理员仍应使用最小权限主机账户、磁盘加密和独立 Bot。

参考：[OpenAI 安全与审批](https://learn.chatgpt.com/codex/agent-approvals-security)。
