# Codex Telegram Bridge（VPS 部署版）

这是本机正在运行的 Telegram ↔ Codex tmux 桥接服务的可复现版本。仓库是后续代码、安装脚本和默认配置的唯一版本来源；机密和运行状态永不提交。

## 能力

- Telegram 控制现有 Codex TUI；最终答复、媒体、选择与批准会回传。
- `/ping` 记录收包与回包耗时；短轮询不会再被 60 秒 HTTP 超时阻塞。
- 拦截 `/exit`、`/quit`，并在 tmux 会话消失时自动重建 Codex 会话。
- `/new`、`/status`、`/context` 等常用菜单；长任务每 60 秒发送中文进度心跳。

## 首次安装（Linux VPS 或 macOS）

1. 安装前置依赖：Python 3.10+、`tmux`、已登录的 Codex CLI。Ubuntu 可用 `sudo apt install tmux python3-venv`；macOS 可用 `brew install tmux python`。
2. 克隆仓库后运行：

```bash
./scripts/install.sh
```

3. 编辑只在本机保存的配置：

```bash
nano ~/.config/telegram-agent-bridge.env
```

至少填写 `TAB_BOT_TOKEN` 和 `TAB_CHAT_ID`。不要把令牌、Chat ID 或任何 `.env` 文件提交到 Git。

4. 启动或验证服务：

```bash
systemctl --user restart telegram-agent-bridge.service
systemctl --user is-active telegram-agent-bridge.service
```

macOS 会自动安装并启动 LaunchAgent，日志位于：

```bash
tail -f ~/Library/Logs/codex-telegram-bridge/bridge.log
launchctl print gui/$(id -u)/com.codex-telegram-bridge.codex
```

首次未运行 Codex tmux 会话时，桥接会按配置自动创建 `tmux -L codex`、名为 `codex` 的会话。

每台机器必须使用独立 Telegram Bot Token 和 Chat ID。Telegram 的 `getUpdates` 不支持多台机器共用同一 Bot 并发轮询，否则消息会被不同机器抢占。

## 日常更新

在仓库目录执行：

```bash
./scripts/update.sh
```

它只快进拉取 Git 版本、重新安装服务文件并重启服务；不会覆盖 `~/.config/telegram-agent-bridge.env`。Linux 重启 systemd 用户服务，macOS 重载对应 LaunchAgent。

## 默认配置与保留原则

`deploy/telegram-agent-bridge.env.example` 是可公开的默认模板。安装脚本仅在目标配置不存在时创建它，因此新机按模板安装，老机的令牌和个性化配置会保留。

## 常用排查

```bash
journalctl --user -u telegram-agent-bridge.service -n 100 --no-pager
systemctl --user status telegram-agent-bridge.service --no-pager
```

Telegram 发 `/ping` 后：`telegram_age_ms` 高表示消息到 VPS 前排队；`sendMessage elapsed_ms` 高表示 VPS 回 Telegram 慢。

## 发布边界

本仓库基于 `codex-telegram-bridge` 0.9.7（MIT）整理，包含 VPS 本地修复。升级上游版本时，先在新分支合并、检查 `BUG_LOG.md`，再重新验证 Telegram、tmux 和 systemd 流程。
