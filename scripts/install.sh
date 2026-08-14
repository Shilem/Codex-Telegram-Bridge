#!/usr/bin/env bash
set -euo pipefail
umask 077

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=scripts/release-lib.sh
. "$REPO_ROOT/scripts/release-lib.sh"

PRODUCT_ID=com.shilem.codex-telegram-bridge
INSTALL_ROOT=${CTB_INSTALL_ROOT:-"$HOME/.local/share/codex-telegram-bridge"}
CONFIG_HOME=${XDG_CONFIG_HOME:-"$HOME/.config"}
STATE_HOME=${XDG_STATE_HOME:-"$HOME/.local/state"}
CONFIG_DIR=${CTB_CONFIG_DIR:-"$CONFIG_HOME/codex-telegram-bridge"}
CONFIG_FILE=${CTB_CONFIG_FILE:-"$CONFIG_DIR/config.json"}
STATE_DIR=${CTB_STATE_DIR:-"$STATE_HOME/codex-telegram-bridge"}
BIN_DIR=${CTB_BIN_DIR:-"$HOME/.local/bin"}
NODE_BIN=${CTB_NODE_BIN:-"$(command -v node || true)"}
CODEX_BIN=${CTB_CODEX_BIN:-"$(command -v codex || true)"}
PACKAGE_DIR=${CTB_PACKAGE_DIR:-"$REPO_ROOT"}
SKIP_SERVICE=${CTB_SKIP_SERVICE:-0}

ctb_assert_safe_root "$INSTALL_ROOT"
ctb_node24_probe "$NODE_BIN"
ctb_codex_probe "$CODEX_BIN"
ctb_require_command npm

case "$(uname -s)" in
  Darwin) PLATFORM=macos ;;
  Linux) PLATFORM=linux ;;
  *) ctb_die "Unix 安装器不支持的平台：$(uname -s)，Windows 请使用 install.ps1" ;;
esac

VERSION=${CTB_VERSION:-$($NODE_BIN -e 'const p=require(process.argv[1]+"/package.json");process.stdout.write(p.version)' "$PACKAGE_DIR")}
[[ "$VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z._-]*$ ]] || ctb_die "版本号无效：$VERSION"
VERSION_DIR="$INSTALL_ROOT/versions/$VERSION"
STAGE_DIR="$INSTALL_ROOT/versions/.staging-$VERSION-$$"
ctb_assert_safe_root "$STAGE_DIR"

mkdir -p "$INSTALL_ROOT/versions" "$CONFIG_DIR" "$STATE_DIR/artifacts" "$BIN_DIR"
if [ ! -f "$CONFIG_DIR/update-public-key.pem" ]; then
  cp "$REPO_ROOT/deploy/update-public-key.pem" "$CONFIG_DIR/update-public-key.pem"
  chmod 644 "$CONFIG_DIR/update-public-key.pem"
fi
cleanup_stage() { [ ! -d "$STAGE_DIR" ] || rm -rf -- "$STAGE_DIR"; }
trap cleanup_stage EXIT

if [ ! -d "$PACKAGE_DIR/dist" ]; then
  [ "${CTB_SKIP_BUILD:-0}" = 1 ] && ctb_die "CTB_SKIP_BUILD=1 但 dist 不存在"
  ctb_log "构建 TypeScript 发布文件"
  (cd "$PACKAGE_DIR" && npm ci && npm run build)
fi

mkdir -p "$STAGE_DIR"
cp -R "$PACKAGE_DIR/dist" "$STAGE_DIR/dist"
cp -R "$PACKAGE_DIR/scripts" "$STAGE_DIR/scripts"
cp "$PACKAGE_DIR/package.json" "$STAGE_DIR/"
if [ -f "$PACKAGE_DIR/npm-shrinkwrap.json" ]; then
  cp "$PACKAGE_DIR/npm-shrinkwrap.json" "$STAGE_DIR/"
elif [ -f "$PACKAGE_DIR/package-lock.json" ]; then
  cp "$PACKAGE_DIR/package-lock.json" "$STAGE_DIR/"
else
  ctb_die "发布包缺少 npm-shrinkwrap.json 或 package-lock.json"
fi
printf '%s\n' "$NODE_BIN" > "$STAGE_DIR/NODE_BIN"
printf '%s\n' "$CODEX_BIN" > "$STAGE_DIR/CODEX_BIN"
if [ "${CTB_SKIP_DEPENDENCIES:-0}" != 1 ]; then
  (cd "$STAGE_DIR" && npm ci --omit=dev)
else
  mkdir -p "$STAGE_DIR/node_modules"
fi
printf '%s\n' "$VERSION" > "$STAGE_DIR/VERSION"

if [ -e "$VERSION_DIR" ]; then
  ctb_die "版本目录已存在，拒绝覆盖：$VERSION_DIR"
fi
mv "$STAGE_DIR" "$VERSION_DIR"
ctb_atomic_current "$INSTALL_ROOT" "$VERSION_DIR"

cat > "$BIN_DIR/ctb" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "$NODE_BIN" "$INSTALL_ROOT/current/dist/cli.js" "\$@"
EOF
cat > "$BIN_DIR/ctb-service-run" <<EOF
#!/usr/bin/env bash
set -euo pipefail
umask 077
export CTB_CONFIG_FILE="$CONFIG_FILE"
export CTB_CONFIG_DIR="$CONFIG_DIR"
export CTB_STATE_DIR="$STATE_DIR"
export CTB_INSTALL_ROOT="$INSTALL_ROOT"
export CTB_BIN_DIR="$BIN_DIR"
export CTB_NODE_BIN="$NODE_BIN"
export CTB_CODEX_BIN="$CODEX_BIN"
export PATH="$(dirname "$NODE_BIN"):$(dirname "$CODEX_BIN"):/usr/bin:/bin:/usr/sbin:/sbin"
exec "$NODE_BIN" "$INSTALL_ROOT/current/dist/service.js"
EOF
chmod 755 "$BIN_DIR/ctb" "$BIN_DIR/ctb-service-run"

if [ ! -f "$CONFIG_FILE" ]; then
  "$NODE_BIN" -e 'const fs=require("fs");const [template,out,state,codex]=process.argv.slice(1);const value=JSON.parse(fs.readFileSync(template,"utf8"));value.stateDirectory=state;value.artifactDirectory=require("path").join(state,"artifacts");value.codexExecutable=codex;fs.writeFileSync(out,JSON.stringify(value,null,2)+"\n",{mode:0o600})' \
    "$REPO_ROOT/deploy/config.json.example" "$CONFIG_FILE" "$STATE_DIR" "$CODEX_BIN"
  chmod 600 "$CONFIG_FILE"
  ctb_log "已创建配置：$CONFIG_FILE"
else
  ctb_log "保留现有配置：$CONFIG_FILE"
fi

if [ ! -f "$CONFIG_DIR/bot-token" ]; then
  : > "$CONFIG_DIR/bot-token"
  chmod 600 "$CONFIG_DIR/bot-token"
  ctb_log "请将 Bot Token 写入 $CONFIG_DIR/bot-token"
fi

if [ "$SKIP_SERVICE" = 1 ]; then
  ctb_log "CTB_SKIP_SERVICE=1：已跳过真实服务注册"
elif [ "$PLATFORM" = linux ]; then
  UNIT_DIR=${CTB_SYSTEMD_USER_DIR:-"$CONFIG_HOME/systemd/user"}
  mkdir -p "$UNIT_DIR"
  "$NODE_BIN" -e 'const fs=require("fs");const [input,output,config,runner]=process.argv.slice(1);const quote=v=>`"${v.replaceAll("\\","\\\\").replaceAll("\"","\\\"")}"`;let text=fs.readFileSync(input,"utf8");text=text.replaceAll("__CONFIG_FILE__",quote(`CTB_CONFIG_FILE=${config}`)).replaceAll("__RUNNER__",quote(runner));fs.writeFileSync(output,text,{mode:0o600})' \
    "$REPO_ROOT/deploy/codex-telegram-bridge.service.template" "$UNIT_DIR/codex-telegram-bridge.service" "$CONFIG_FILE" "$BIN_DIR/ctb-service-run"
  systemctl --user daemon-reload
  systemctl --user enable codex-telegram-bridge.service
elif [ "$PLATFORM" = macos ]; then
  PLIST_DIR=${CTB_LAUNCH_AGENTS_DIR:-"$HOME/Library/LaunchAgents"}
  LOG_DIR=${CTB_LOG_DIR:-"$HOME/Library/Logs/codex-telegram-bridge"}
  PLIST_FILE="$PLIST_DIR/$PRODUCT_ID.plist"
  mkdir -p "$PLIST_DIR" "$LOG_DIR"
  "$NODE_BIN" -e 'const fs=require("fs");const [input,output,runner,config,logs]=process.argv.slice(1);const xml=v=>v.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll("\"","&quot;").replaceAll("'"'"'","&apos;");let text=fs.readFileSync(input,"utf8");text=text.replaceAll("__RUNNER__",xml(runner)).replaceAll("__CONFIG_FILE__",xml(config)).replaceAll("__LOG_DIR__",xml(logs));fs.writeFileSync(output,text,{mode:0o600})' \
    "$REPO_ROOT/deploy/$PRODUCT_ID.plist.template" "$PLIST_FILE" "$BIN_DIR/ctb-service-run" "$CONFIG_FILE" "$LOG_DIR"
  plutil -lint "$PLIST_FILE" >/dev/null
fi

if [ -s "$CONFIG_DIR/bot-token" ] && [ "$SKIP_SERVICE" != 1 ]; then
  if [ "$PLATFORM" = linux ]; then
    systemctl --user restart codex-telegram-bridge.service
    systemctl --user is-active codex-telegram-bridge.service >/dev/null
  else
    DOMAIN="gui/$(id -u)"
    launchctl bootout "$DOMAIN" "$PLIST_FILE" >/dev/null 2>&1 || true
    launchctl bootstrap "$DOMAIN" "$PLIST_FILE"
    launchctl kickstart -k "$DOMAIN/$PRODUCT_ID"
  fi
  "$BIN_DIR/ctb" doctor
else
  if [ "$SKIP_SERVICE" = 1 ]; then
    ctb_log "Token 未配置或处于测试模式；未启动服务。"
  elif [ "$PLATFORM" = linux ]; then
    ctb_log "Token 尚未配置。写入后执行：systemctl --user start codex-telegram-bridge.service"
  else
    ctb_log "Token 尚未配置。写入后执行：launchctl bootstrap gui/$(id -u) '$PLIST_FILE'"
  fi
fi
ctb_log "安装完成：$VERSION_DIR"
