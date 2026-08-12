#!/usr/bin/env bash
set -euo pipefail
umask 077

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=scripts/release-lib.sh
. "$REPO_ROOT/scripts/release-lib.sh"

INSTALL_ROOT=${CTB_INSTALL_ROOT:-"$HOME/.local/share/codex-telegram-bridge"}
BIN_DIR=${CTB_BIN_DIR:-"$HOME/.local/bin"}
NODE_BIN=${CTB_NODE_BIN:-"$(command -v node || true)"}
PUBLIC_KEY=${CTB_UPDATE_PUBLIC_KEY:-}
MANIFEST= SIGNATURE= ARCHIVE=

usage() {
  echo "用法：$0 --manifest <文件或URL> --signature <文件或URL> --archive <文件或URL> --public-key <PEM文件>" >&2
}
while [ $# -gt 0 ]; do
  case "$1" in
    --manifest) MANIFEST=${2:-}; shift 2 ;;
    --signature) SIGNATURE=${2:-}; shift 2 ;;
    --archive) ARCHIVE=${2:-}; shift 2 ;;
    --public-key) PUBLIC_KEY=${2:-}; shift 2 ;;
    *) usage; exit 2 ;;
  esac
done
[ -n "$MANIFEST" ] && [ -n "$SIGNATURE" ] && [ -n "$ARCHIVE" ] && [ -n "$PUBLIC_KEY" ] || { usage; exit 2; }
ctb_node24_probe "$NODE_BIN"
ctb_assert_safe_root "$INSTALL_ROOT"
[ -L "$INSTALL_ROOT/current" ] || ctb_die "未找到 current 指针，请先安装"

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/ctb-update.XXXXXX")
cleanup() { rm -rf -- "$TMP_ROOT"; }
trap cleanup EXIT

fetch() {
  local source=$1 output=$2
  case "$source" in
    https://*) ctb_require_command curl; curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$source" -o "$output" ;;
    http://*) ctb_die "拒绝通过明文 HTTP 下载更新" ;;
    *) cp "$source" "$output" ;;
  esac
}
fetch "$MANIFEST" "$TMP_ROOT/manifest.json"
fetch "$SIGNATURE" "$TMP_ROOT/manifest.sig"
fetch "$ARCHIVE" "$TMP_ROOT/release.tgz"
ctb_verify_release "$TMP_ROOT/manifest.json" "$TMP_ROOT/manifest.sig" "$PUBLIC_KEY" "$TMP_ROOT/release.tgz" "$NODE_BIN"

VERSION=$($NODE_BIN -e 'const m=require(process.argv[1]);process.stdout.write(String(m.version||""))' "$TMP_ROOT/manifest.json")
CURRENT_VERSION=$(cat "$INSTALL_ROOT/current/VERSION")
$NODE_BIN -e 'const [a,b]=process.argv.slice(1);const p=s=>s.split(/[.-]/).map(x=>/^\d+$/.test(x)?Number(x):x);const A=p(a),B=p(b);for(let i=0;i<Math.max(A.length,B.length);i++){const x=A[i]??0,y=B[i]??0;if(x===y)continue;if(typeof x===typeof y)process.exit(x>y?0:1);process.exit(typeof x==="number"?0:1)}process.exit(1)' "$VERSION" "$CURRENT_VERSION" || \
  ctb_die "拒绝安装非升级版本：当前 $CURRENT_VERSION，目标 $VERSION"

mkdir "$TMP_ROOT/package"
tar -xzf "$TMP_ROOT/release.tgz" -C "$TMP_ROOT/package"
PACKAGE_DIR="$TMP_ROOT/package"
[ -f "$PACKAGE_DIR/package.json" ] || {
  first_dir=$(find "$PACKAGE_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  [ -n "$first_dir" ] && [ -f "$first_dir/package.json" ] || ctb_die "release 包缺少 package.json"
  PACKAGE_DIR=$first_dir
}

OLD_TARGET=$(ctb_current_target "$INSTALL_ROOT")
CTB_PACKAGE_DIR="$PACKAGE_DIR" CTB_VERSION="$VERSION" CTB_SKIP_SERVICE=1 \
  "$REPO_ROOT/scripts/install.sh"

restart_service() {
  case "$(uname -s)" in
    Linux) systemctl --user restart codex-telegram-bridge.service ;;
    Darwin)
      local domain="gui/$(id -u)"
      launchctl kickstart -k "$domain/com.shilem.codex-telegram-bridge"
      ;;
    *) ctb_die "不支持的平台" ;;
  esac
}

if [ "${CTB_SKIP_SERVICE:-0}" = 1 ]; then
  ctb_log "测试模式：已切换到 $VERSION，跳过服务健康检查"
  exit 0
fi
restart_service
if ! "$BIN_DIR/ctb" doctor; then
  ctb_log "新版本健康检查失败，正在原子回滚到 $OLD_TARGET"
  ctb_atomic_current "$INSTALL_ROOT" "$OLD_TARGET"
  restart_service || true
  ctb_die "更新失败，已回滚到 $CURRENT_VERSION"
fi
ctb_log "更新成功：$CURRENT_VERSION → $VERSION"
