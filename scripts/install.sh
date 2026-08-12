#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
INSTALL_ROOT=${INSTALL_ROOT:-"$HOME/.local/share/codex-telegram-bridge"}
VENV="$INSTALL_ROOT/venv"
CONFIG_DIR="$HOME/.config"
CONFIG_FILE="$CONFIG_DIR/telegram-agent-bridge.env"
RUNNER="$HOME/.local/bin/telegram-agent-bridge-run"
UNIT_DIR="$HOME/.config/systemd/user"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_FILE="$PLIST_DIR/com.codex-telegram-bridge.codex.plist"
LOG_DIR="$HOME/Library/Logs/codex-telegram-bridge"

command -v python3 >/dev/null || { echo '需要 Python 3。' >&2; exit 1; }
command -v tmux >/dev/null || { echo '需要 tmux。' >&2; exit 1; }
command -v codex >/dev/null || { echo '需要已安装并登录的 Codex CLI。' >&2; exit 1; }
SERVICE_PATH="$(dirname "$(command -v python3)"):$(dirname "$(command -v tmux)"):$(dirname "$(command -v codex)"):/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

case "$(uname -s)" in
  Linux) PLATFORM=linux ;;
  Darwin) PLATFORM=macos ;;
  *) echo "暂不支持的平台：$(uname -s)" >&2; exit 1 ;;
esac

mkdir -p "$INSTALL_ROOT" "$CONFIG_DIR" "$(dirname "$RUNNER")" "$UNIT_DIR"
rm -rf "$INSTALL_ROOT/src"
cp -a "$REPO_ROOT/src" "$INSTALL_ROOT/src"
python3 -m venv "$VENV"
"$VENV/bin/python" -m py_compile "$INSTALL_ROOT/src"/*.py

if [ ! -f "$CONFIG_FILE" ]; then
  sed "s|~|$HOME|g" "$REPO_ROOT/deploy/telegram-agent-bridge.env.example" > "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE"
  echo "已创建配置模板：$CONFIG_FILE"
  echo "请填写 TAB_BOT_TOKEN 与 TAB_CHAT_ID 后重新运行本脚本。"
else
  echo "保留现有配置：$CONFIG_FILE"
fi

cat > "$RUNNER" <<RUNNER
#!/usr/bin/env bash
set -euo pipefail
export PATH="$SERVICE_PATH"
ENV_FILE="$CONFIG_FILE"
[ -f "\$ENV_FILE" ] || { echo "配置文件不存在：\$ENV_FILE" >&2; exit 2; }
set -a
. "\$ENV_FILE"
set +a
exec "$VENV/bin/python" "$INSTALL_ROOT/src/codex_repl_bridge.py"
RUNNER
chmod 755 "$RUNNER"

if [ "$PLATFORM" = linux ]; then
  sed "s|__HOME__|$HOME|g" "$REPO_ROOT/deploy/telegram-agent-bridge.service.template" > "$UNIT_DIR/telegram-agent-bridge.service"
  systemctl --user daemon-reload
  systemctl --user enable telegram-agent-bridge.service
else
  mkdir -p "$PLIST_DIR" "$LOG_DIR"
  sed -e "s|__RUNNER__|$RUNNER|g" -e "s|__LOG_DIR__|$LOG_DIR|g" \
    "$REPO_ROOT/deploy/com.codex-telegram-bridge.codex.plist.template" > "$PLIST_FILE"
  plutil -lint "$PLIST_FILE"
fi

if grep -q '^TAB_BOT_TOKEN=$' "$CONFIG_FILE" || grep -q '^TAB_CHAT_ID=$' "$CONFIG_FILE"; then
  echo "配置尚未填写完成；服务未启动。"
  exit 0
fi
if [ "$PLATFORM" = linux ]; then
  systemctl --user restart telegram-agent-bridge.service
  systemctl --user is-active telegram-agent-bridge.service
else
  DOMAIN="gui/$(id -u)"
  launchctl bootout "$DOMAIN" "$PLIST_FILE" >/dev/null 2>&1 || true
  launchctl bootstrap "$DOMAIN" "$PLIST_FILE"
  launchctl kickstart -k "$DOMAIN/com.codex-telegram-bridge.codex"
  launchctl print "$DOMAIN/com.codex-telegram-bridge.codex" >/dev/null
  echo "macOS LaunchAgent 已启动：com.codex-telegram-bridge.codex"
fi
