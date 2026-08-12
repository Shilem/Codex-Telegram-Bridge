#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/release-lib.sh
. "$SCRIPT_ROOT/release-lib.sh"
INSTALL_ROOT=${CTB_INSTALL_ROOT:-"$HOME/.local/share/codex-telegram-bridge"}
BIN_DIR=${CTB_BIN_DIR:-"$HOME/.local/bin"}
ctb_assert_safe_root "$INSTALL_ROOT"
CURRENT=$(ctb_current_target "$INSTALL_ROOT")
[ -n "$CURRENT" ] || ctb_die "current 指针不存在"
TARGET=${1:-}
if [ -z "$TARGET" ]; then
  TARGET=$(find "$INSTALL_ROOT/versions" -mindepth 1 -maxdepth 1 -type d ! -path "$CURRENT" -exec test -f '{}/VERSION' ';' -print | while IFS= read -r path; do printf '%s %s\n' "$(stat -f '%m' "$path" 2>/dev/null || stat -c '%Y' "$path")" "$path"; done | sort -rn | awk 'NR==1{print $2}')
else
  TARGET="$INSTALL_ROOT/versions/$TARGET"
fi
[ -d "$TARGET" ] || ctb_die "没有可回滚版本"
ctb_atomic_current "$INSTALL_ROOT" "$TARGET"
restart() {
  case "$(uname -s)" in
    Linux) systemctl --user restart codex-telegram-bridge.service ;;
    Darwin) launchctl kickstart -k "gui/$(id -u)/com.shilem.codex-telegram-bridge" ;;
    *) ctb_die "不支持的平台" ;;
  esac
}
if [ "${CTB_SKIP_SERVICE:-0}" != 1 ]; then
  restart
  if ! "$BIN_DIR/ctb" doctor; then
    ctb_atomic_current "$INSTALL_ROOT" "$CURRENT"
    restart || true
    ctb_die "目标版本健康检查失败，已恢复原版本"
  fi
fi
ctb_log "已回滚到 $(cat "$TARGET/VERSION")"
