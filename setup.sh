#!/bin/sh
# kimi-base 安装入口（POSIX sh）
# 用法：sh setup.sh <target-project-dir> [--dry-run]
# 等价于：node runtime/kimi-base.mjs install <target>，并打印插件安装提示。
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ $# -lt 1 ]; then
  echo "用法：sh setup.sh <target-project-dir> [--dry-run]" >&2
  exit 1
fi

TARGET=$1
shift || true

if ! command -v node >/dev/null 2>&1; then
  echo "错误：未找到 node（需要 Node >= 18）" >&2
  exit 1
fi

node "$SCRIPT_DIR/runtime/kimi-base.mjs" install "$TARGET" "$@"
CODE=$?

if [ "$CODE" -eq 0 ]; then
  echo ""
  echo "项目面安装完成。还差一步：安装 Kimi Code 插件（提供全局 hooks）："
  echo "  /plugins install $SCRIPT_DIR"
  echo "未安装插件时，hook 闸门（危险命令拦截/写前对账/完成门）不会挂载，"
  echo "治理仅靠 CLI 手动调用，属于建议性约束。"
fi

exit "$CODE"
