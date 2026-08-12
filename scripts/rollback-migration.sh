#!/usr/bin/env bash
set -euo pipefail
umask 077

BACKUP=${1:-}
LATEST_OFFSET=${2:-}
LEGACY_ENV=${CTB_LEGACY_ENV:-"$HOME/.config/telegram-agent-bridge.env"}
[ -n "$BACKUP" ] && [ -d "$BACKUP" ] || { echo "用法：$0 <迁移备份目录> <新服务已确认的最新 Telegram offset>" >&2; exit 2; }
[[ "$LATEST_OFFSET" =~ ^[0-9]+$ ]] || { echo "offset 必须是非负整数" >&2; exit 2; }
[ -f "$BACKUP/telegram-agent-bridge.env" ] || { echo "备份缺少旧配置" >&2; exit 1; }
mkdir -p "$(dirname "$LEGACY_ENV")"
cp "$BACKUP/telegram-agent-bridge.env" "$LEGACY_ENV"
chmod 600 "$LEGACY_ENV"
if [ -d "$BACKUP/legacy-state" ]; then
  LEGACY_STATE=$(awk -F= '/^TAB_STATE_DIR=/{print substr($0,index($0,"=")+1);exit}' "$LEGACY_ENV")
  LEGACY_STATE=${LEGACY_STATE:-"$HOME/.local/state/telegram-agent-bridge"}
  LEGACY_STATE=${LEGACY_STATE/#\~/$HOME}
  mkdir -p "$LEGACY_STATE"
  cp -R "$BACKUP/legacy-state/". "$LEGACY_STATE/"
  [ -f "$BACKUP/legacy-offset-path" ] || { echo "备份缺少精确 offset 路径，拒绝谎报恢复成功" >&2; exit 1; }
  OFFSET_FILE=$(cat "$BACKUP/legacy-offset-path")
  [ -n "$OFFSET_FILE" ] || { echo "旧服务没有可验证 offset 文件，拒绝回滚以免重放" >&2; exit 1; }
  tmp="$OFFSET_FILE.$$.tmp"; printf '%s\n' "$LATEST_OFFSET" > "$tmp"; mv -f "$tmp" "$OFFSET_FILE"
else
  echo "备份缺少旧状态目录，无法回写 offset" >&2; exit 1
fi
case "$(uname -s)" in
  Linux) systemctl --user restart telegram-agent-bridge.service ;;
  Darwin)
    [ -f "$BACKUP/legacy.plist" ] || { echo "备份缺少旧 LaunchAgent" >&2; exit 1; }
    launchctl bootstrap "gui/$(id -u)" "$BACKUP/legacy.plist" >/dev/null 2>&1 || true
    launchctl kickstart -k "gui/$(id -u)/com.codex-telegram-bridge.codex"
    ;;
esac
echo "已恢复旧服务，并将 Telegram offset 更新为 $LATEST_OFFSET，避免消息重放。"
