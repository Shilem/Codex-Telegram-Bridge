#!/usr/bin/env bash
set -euo pipefail
umask 077

LEGACY_ENV=${1:-"$HOME/.config/telegram-agent-bridge.env"}
INSTALL_ROOT=${CTB_INSTALL_ROOT:-"$HOME/.local/share/codex-telegram-bridge"}
CONFIG_HOME=${XDG_CONFIG_HOME:-"$HOME/.config"}
STATE_HOME=${XDG_STATE_HOME:-"$HOME/.local/state"}
CONFIG_DIR=${CTB_CONFIG_DIR:-"$CONFIG_HOME/codex-telegram-bridge"}
STATE_DIR=${CTB_STATE_DIR:-"$STATE_HOME/codex-telegram-bridge"}
BIN_DIR=${CTB_BIN_DIR:-"$HOME/.local/bin"}
BACKUP_ROOT=${CTB_MIGRATION_BACKUP_ROOT:-"$STATE_DIR/migration-backups"}
[ -f "$LEGACY_ENV" ] || { echo "旧配置不存在：$LEGACY_ENV" >&2; exit 1; }
[ -x "$BIN_DIR/ctb" ] || { echo "请先安装 1.0，再运行迁移" >&2; exit 1; }

legacy_value() {
  local key=$1
  awk -v key="$key" 'index($0,key"=")==1 {v=substr($0,length(key)+2); if ((substr(v,1,1)=="\"" && substr(v,length(v),1)=="\"") || (substr(v,1,1)=="\047" && substr(v,length(v),1)=="\047")) v=substr(v,2,length(v)-2); print v; exit}' "$LEGACY_ENV"
}
BOT_TOKEN=$(legacy_value TAB_BOT_TOKEN); [ -n "$BOT_TOKEN" ] || BOT_TOKEN=$(legacy_value CRB_BOT_TOKEN)
CHAT_ID=$(legacy_value TAB_CHAT_ID)
WORKDIR=$(legacy_value TAB_WORKDIR)
LEGACY_STATE=$(legacy_value TAB_STATE_DIR)
[ -n "$LEGACY_STATE" ] || LEGACY_STATE="$HOME/.local/state/telegram-agent-bridge"
LEGACY_STATE=${LEGACY_STATE/#\~/$HOME}
WORKDIR=${WORKDIR/#\~/$HOME}
[ -n "$BOT_TOKEN" ] || { echo "旧配置没有 Bot Token" >&2; exit 1; }
[ -n "$CHAT_ID" ] || { echo "旧配置没有 Chat ID" >&2; exit 1; }
[ -d "$WORKDIR" ] || { echo "旧工作目录不存在：$WORKDIR" >&2; exit 1; }

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP="$BACKUP_ROOT/$STAMP"
mkdir -p "$BACKUP" "$CONFIG_DIR" "$STATE_DIR"
cp "$LEGACY_ENV" "$BACKUP/telegram-agent-bridge.env"
[ ! -d "$LEGACY_STATE" ] || cp -R "$LEGACY_STATE" "$BACKUP/legacy-state"
[ ! -f "$HOME/Library/LaunchAgents/com.codex-telegram-bridge.codex.plist" ] || cp "$HOME/Library/LaunchAgents/com.codex-telegram-bridge.codex.plist" "$BACKUP/legacy.plist"

restore_legacy() {
  case "$(uname -s)" in
    Linux) systemctl --user restart telegram-agent-bridge.service >/dev/null 2>&1 || true ;;
    Darwin)
      [ ! -f "$BACKUP/legacy.plist" ] || launchctl bootstrap "gui/$(id -u)" "$BACKUP/legacy.plist" >/dev/null 2>&1 || true
      launchctl kickstart -k "gui/$(id -u)/com.codex-telegram-bridge.codex" >/dev/null 2>&1 || true
      ;;
  esac
}
case "$(uname -s)" in
  Linux)
    systemctl --user stop telegram-agent-bridge.service >/dev/null 2>&1 || true
    if systemctl --user is-active --quiet telegram-agent-bridge.service; then
      echo "旧服务仍在运行，拒绝启动第二个 getUpdates 消费者" >&2
      exit 1
    fi
    ;;
  Darwin)
    LEGACY_LABEL=com.codex-telegram-bridge.codex
    launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/$LEGACY_LABEL.plist" >/dev/null 2>&1 || true
    if launchctl print "gui/$(id -u)/$LEGACY_LABEL" >/dev/null 2>&1; then
      echo "旧服务仍在运行，拒绝启动第二个 getUpdates 消费者" >&2
      exit 1
    fi
    ;;
esac

printf '%s\n' "$BOT_TOKEN" > "$CONFIG_DIR/bot-token"
chmod 600 "$CONFIG_DIR/bot-token"
OFFSET_FILE=$(find "$LEGACY_STATE" -maxdepth 1 -type f -name 'codex-repl-bridge-*.offset' 2>/dev/null | head -n 1 || true)
OFFSET=0
[ -z "$OFFSET_FILE" ] || OFFSET=$(tr -cd '0-9' < "$OFFSET_FILE")
[ -n "$OFFSET" ] || OFFSET=0
printf '%s\n' "$OFFSET_FILE" > "$BACKUP/legacy-offset-path"
REPORT="$BACKUP/migration-report.json"
CTB_NODE_BIN=${CTB_NODE_BIN:-"$(command -v node)"}
"$CTB_NODE_BIN" -e 'const fs=require("fs");const [out,chat,workdir,offset]=process.argv.slice(1);fs.writeFileSync(out,JSON.stringify({schemaVersion:1,legacy:{chatId:chat,workdir,telegramOffset:Number(offset)},requiresLocalPairing:true,legacySessionImported:false,notes:["旧会话只有在线程 ID 与工作目录均可唯一验证时才可导入"]},null,2)+"\n",{mode:0o600})' "$REPORT" "$CHAT_ID" "$WORKDIR" "$OFFSET"

if ! "$BIN_DIR/ctb" migrate legacy --report "$REPORT"; then
  restore_legacy
  echo "迁移导入失败；旧服务已恢复。备份：$BACKUP" >&2
  exit 1
fi

case "$(uname -s)" in
  Linux)
    systemctl --user restart codex-telegram-bridge.service
    systemctl --user is-active --quiet codex-telegram-bridge.service || { restore_legacy; echo "新服务启动失败，已恢复旧服务" >&2; exit 1; }
    ;;
  Darwin)
    NEW_PLIST="$HOME/Library/LaunchAgents/com.shilem.codex-telegram-bridge.plist"
    launchctl bootstrap "gui/$(id -u)" "$NEW_PLIST" >/dev/null 2>&1 || true
    launchctl kickstart -k "gui/$(id -u)/com.shilem.codex-telegram-bridge"
    launchctl print "gui/$(id -u)/com.shilem.codex-telegram-bridge" >/dev/null || { restore_legacy; echo "新服务启动失败，已恢复旧服务" >&2; exit 1; }
    ;;
esac

echo "迁移数据已导入，但不会自动冒充本机配对。"
echo "请向 Bot 发送 /start，然后在本机执行：ctb pair <十分钟配对码>"
echo "配对后执行 ctb doctor，并手动验收 /ping、/health 和真实只读任务。"
echo "备份与只读迁移报告：$BACKUP"
