#!/usr/bin/env bash
set -euo pipefail

PRODUCT_ID=com.shilem.codex-telegram-bridge
INSTALL_ROOT=${CTB_INSTALL_ROOT:-"$HOME/.local/share/codex-telegram-bridge"}
CONFIG_HOME=${XDG_CONFIG_HOME:-"$HOME/.config"}
STATE_HOME=${XDG_STATE_HOME:-"$HOME/.local/state"}
CONFIG_DIR=${CTB_CONFIG_DIR:-"$CONFIG_HOME/codex-telegram-bridge"}
STATE_DIR=${CTB_STATE_DIR:-"$STATE_HOME/codex-telegram-bridge"}
BIN_DIR=${CTB_BIN_DIR:-"$HOME/.local/bin"}
PURGE=0
[ "${1:-}" != "--purge-data" ] || PURGE=1

case "$(uname -s)" in
  Linux)
    systemctl --user disable --now codex-telegram-bridge.service >/dev/null 2>&1 || true
    UNIT=${CTB_SYSTEMD_USER_DIR:-"$CONFIG_HOME/systemd/user"}/codex-telegram-bridge.service
    [ ! -f "$UNIT" ] || rm -- "$UNIT"
    systemctl --user daemon-reload >/dev/null 2>&1 || true
    ;;
  Darwin)
    PLIST=${CTB_LAUNCH_AGENTS_DIR:-"$HOME/Library/LaunchAgents"}/$PRODUCT_ID.plist
    launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
    [ ! -f "$PLIST" ] || rm -- "$PLIST"
    ;;
  *) echo "不支持的平台" >&2; exit 1 ;;
esac

case "$INSTALL_ROOT" in ""|/|"$HOME") echo "拒绝删除不安全路径：$INSTALL_ROOT" >&2; exit 1;; esac
rm -rf -- "$INSTALL_ROOT"
rm -f -- "$BIN_DIR/ctb" "$BIN_DIR/ctb-service-run"
if [ "$PURGE" = 1 ]; then
  case "$CONFIG_DIR:$STATE_DIR" in *"/:"*|*":/"*|"$HOME:"*|*":$HOME") echo "拒绝删除不安全数据路径" >&2; exit 1;; esac
  rm -rf -- "$CONFIG_DIR" "$STATE_DIR"
  echo "已卸载程序并删除配置和本地数据（不可恢复）。"
else
  echo "已卸载程序；配置和数据已保留。若确认不再需要，可使用 --purge-data。"
fi
