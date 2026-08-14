#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/ctb-distribution-test.XXXXXX")
cleanup() { rm -rf -- "$TMP"; }
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
assert_file() { [ -f "$1" ] || fail "缺少文件 $1"; }
assert_contains() { grep -F "$2" "$1" >/dev/null || fail "$1 不包含 $2"; }

mkdir -p "$TMP/bin" "$TMP/package/dist" "$TMP/package/scripts" "$TMP/home"
cp "$ROOT/scripts/"*.sh "$TMP/package/scripts/"
REAL_NODE=$(command -v node)
cat > "$TMP/bin/node24" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = --version ]; then echo v24.10.0; exit 0; fi
exec "$REAL_NODE" "\$@"
EOF
cat > "$TMP/bin/codex" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = app-server ] && [ "${2:-}" = --help ]
EOF
chmod 755 "$TMP/bin/node24" "$TMP/bin/codex"
cat > "$TMP/package/package.json" <<'EOF'
{"name":"codex-telegram-bridge-test","version":"1.0.0","type":"module"}
EOF
cat > "$TMP/package/package-lock.json" <<'EOF'
{"name":"codex-telegram-bridge-test","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"codex-telegram-bridge-test","version":"1.0.0"}}}
EOF
cat > "$TMP/package/dist/cli.js" <<'EOF'
process.exit(0)
EOF
cat > "$TMP/package/dist/service.js" <<'EOF'
process.exit(0)
EOF

HOME="$TMP/home" PATH="$TMP/bin:$PATH" \
CTB_INSTALL_ROOT="$TMP/install" CTB_CONFIG_DIR="$TMP/config" CTB_CONFIG_FILE="$TMP/config/config.json" \
CTB_STATE_DIR="$TMP/state" CTB_BIN_DIR="$TMP/user-bin" \
CTB_NODE_BIN="$TMP/bin/node24" CTB_CODEX_BIN="$TMP/bin/codex" CTB_PACKAGE_DIR="$TMP/package" \
CTB_SKIP_DEPENDENCIES=1 CTB_SKIP_SERVICE=1 "$ROOT/scripts/install.sh"

[ -L "$TMP/install/current" ] || fail "current 不是原子符号链接"
[ "$(cat "$TMP/install/current/VERSION")" = 1.0.0 ] || fail "current 版本错误"
assert_file "$TMP/config/config.json"
assert_file "$TMP/config/bot-token"
assert_file "$TMP/config/update-public-key.pem"
assert_contains "$TMP/user-bin/ctb-service-run" "export PATH=\"$TMP/bin:$TMP/bin:/usr/bin:/bin:/usr/sbin:/sbin\""
if [ "$(uname -s)" = Darwin ]; then
  TOKEN_MODE=$(stat -f '%Lp' "$TMP/config/bot-token")
else
  TOKEN_MODE=$(stat -c '%a' "$TMP/config/bot-token")
fi
[ "$TOKEN_MODE" = 600 ] || fail "Token 权限不是 600"
assert_contains "$TMP/config/config.json" '"allowDangerFullAccess": false'
assert_contains "$TMP/config/config.json" '"updatePublicKeyFile": "update-public-key.pem"'
assert_contains "$TMP/config/config.json" 'releases/latest/download/codex-telegram-bridge.tgz'
assert_contains "$TMP/config/update-public-key.pem" 'BEGIN PUBLIC KEY'

mkdir -p "$TMP/release/dist"
cp -R "$TMP/package/scripts" "$TMP/release/scripts"
cp "$TMP/package/package.json" "$TMP/release/package.json"
cp "$TMP/package/package-lock.json" "$TMP/release/package-lock.json"
cp "$TMP/package/dist/"* "$TMP/release/dist/"
sed -i.bak 's/1.0.0/1.1.0/g' "$TMP/release/package.json" "$TMP/release/package-lock.json"
rm "$TMP/release/package.json.bak" "$TMP/release/package-lock.json.bak"
(cd "$TMP/release" && tar -czf "$TMP/release.tgz" .)
HASH=$(shasum -a 256 "$TMP/release.tgz" | awk '{print $1}')
printf '{"version":"1.1.0","archive":"release.tgz","sha256":"%s"}\n' "$HASH" > "$TMP/manifest.json"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$TMP/private.pem" >/dev/null 2>&1
openssl rsa -pubout -in "$TMP/private.pem" -out "$TMP/public.pem" >/dev/null 2>&1
openssl dgst -sha256 -sign "$TMP/private.pem" -out "$TMP/manifest.sig" "$TMP/manifest.json"

HOME="$TMP/home" PATH="$TMP/bin:$PATH" \
CTB_INSTALL_ROOT="$TMP/install" CTB_CONFIG_DIR="$TMP/config" CTB_STATE_DIR="$TMP/state" CTB_BIN_DIR="$TMP/user-bin" \
CTB_NODE_BIN="$TMP/bin/node24" CTB_CODEX_BIN="$TMP/bin/codex" CTB_SKIP_DEPENDENCIES=1 CTB_SKIP_SERVICE=1 \
  "$ROOT/scripts/update.sh" --manifest "$TMP/manifest.json" --signature "$TMP/manifest.sig" --archive "$TMP/release.tgz" --public-key "$TMP/public.pem"
[ "$(cat "$TMP/install/current/VERSION")" = 1.1.0 ] || fail "签名更新未切换到 1.1.0"

cp "$TMP/manifest.json" "$TMP/tampered.json"
printf ' ' >> "$TMP/tampered.json"
if HOME="$TMP/home" PATH="$TMP/bin:$PATH" CTB_INSTALL_ROOT="$TMP/install" CTB_NODE_BIN="$TMP/bin/node24" \
  "$ROOT/scripts/update.sh" --manifest "$TMP/tampered.json" --signature "$TMP/manifest.sig" --archive "$TMP/release.tgz" --public-key "$TMP/public.pem" >/dev/null 2>&1; then
  fail "篡改 manifest 未被拒绝"
fi
HOME="$TMP/home" PATH="$TMP/bin:$PATH" CTB_INSTALL_ROOT="$TMP/install" CTB_BIN_DIR="$TMP/user-bin" \
  CTB_SKIP_SERVICE=1 "$ROOT/scripts/rollback-version.sh" 1.0.0
[ "$(cat "$TMP/install/current/VERSION")" = 1.0.0 ] || fail "版本回滚未恢复 1.0.0"

assert_contains "$ROOT/deploy/codex-telegram-bridge.service.template" 'Restart=on-failure'
assert_contains "$ROOT/deploy/codex-telegram-bridge.service.template" 'UMask=0077'
assert_contains "$ROOT/deploy/codex-telegram-bridge.service.template" 'StartLimitBurst=5'
assert_contains "$ROOT/deploy/com.shilem.codex-telegram-bridge.plist.template" '<string>com.shilem.codex-telegram-bridge</string>'
assert_contains "$ROOT/deploy/windows-task.xml.template" '<RunLevel>LeastPrivilege</RunLevel>'
assert_contains "$ROOT/scripts/install.ps1" 'app-server --help'
assert_contains "$ROOT/scripts/update.ps1" 'VerifyData'

echo "distribution tests passed"
