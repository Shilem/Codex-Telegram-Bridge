#!/usr/bin/env bash

# 供 install/update/migrate 共用。调用方必须先启用 set -euo pipefail。

ctb_log() { printf '[ctb] %s\n' "$*"; }
ctb_die() { printf '[ctb] 错误：%s\n' "$*" >&2; exit 1; }

ctb_require_command() {
  command -v "$1" >/dev/null 2>&1 || ctb_die "缺少命令：$1"
}

ctb_assert_safe_root() {
  case "$1" in
    ""|/|"$HOME") ctb_die "拒绝使用不安全的安装目录：$1" ;;
  esac
}

ctb_node24_probe() {
  local node_bin=$1 version major
  [ -x "$node_bin" ] || ctb_die "Node.js 不可执行：$node_bin"
  version=$($node_bin --version 2>/dev/null) || ctb_die "无法读取 Node.js 版本"
  major=${version#v}; major=${major%%.*}
  [ "$major" = 24 ] || ctb_die "需要 Node.js 24 LTS，当前为 $version"
}

ctb_codex_probe() {
  local codex_bin=$1
  [ -x "$codex_bin" ] || ctb_die "Codex CLI 不可执行：$codex_bin"
  "$codex_bin" app-server --help >/dev/null 2>&1 || \
    ctb_die "当前 Codex CLI 不支持 app-server，请先升级 Codex CLI"
}

ctb_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    ctb_die "缺少 sha256sum 或 shasum"
  fi
}

# manifest 格式：{"version":"1.0.0","archive":"...tgz","sha256":"..."}
# 签名是 openssl dgst -sha256 对 manifest 原始字节生成的二进制签名。
ctb_verify_release() {
  local manifest=$1 signature=$2 public_key=$3 archive=$4 node_bin=$5
  ctb_require_command openssl
  [ -f "$manifest" ] || ctb_die "release manifest 不存在：$manifest"
  [ -f "$signature" ] || ctb_die "release manifest 签名不存在：$signature"
  [ -f "$public_key" ] || ctb_die "更新公钥不存在：$public_key"
  [ -f "$archive" ] || ctb_die "release 包不存在：$archive"
  openssl dgst -sha256 -verify "$public_key" -signature "$signature" "$manifest" >/dev/null 2>&1 || \
    ctb_die "release manifest 签名校验失败"
  local expected actual manifest_archive
  expected=$($node_bin -e 'const fs=require("fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!/^[a-f0-9]{64}$/i.test(m.sha256||""))process.exit(2);process.stdout.write(m.sha256.toLowerCase())' "$manifest") || \
    ctb_die "release manifest 的 sha256 无效"
  manifest_archive=$($node_bin -e 'const fs=require("fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(m.archive||""))' "$manifest") || \
    ctb_die "无法读取 release manifest"
  [ -n "$manifest_archive" ] && [ "$manifest_archive" = "$(basename "$manifest_archive")" ] || \
    ctb_die "release manifest 的包名无效"
  actual=$(ctb_sha256 "$archive")
  [ "$actual" = "$expected" ] || ctb_die "release 包 SHA-256 校验失败"
}

ctb_atomic_current() {
  local install_root=$1 target=$2 current tmp
  ctb_assert_safe_root "$install_root"
  [ -d "$target" ] || ctb_die "待切换版本目录不存在：$target"
  current="$install_root/current"
  tmp="$install_root/.current.$$.tmp"
  ln -s "$target" "$tmp"
  rm -f -- "$current"
  mv -- "$tmp" "$current"
}

ctb_current_target() {
  [ -L "$1/current" ] && readlink "$1/current" || true
}
