#!/bin/sh
# kimi-base 发布打包（POSIX sh）
# 以 package.json 的 files 清单为发布面做 git archive（维护面 tests/progress 等不进包）；
# 剔除运行时状态/私密 feedback/旁路文件；打完对包内容跑泄漏扫描，命中即非零退出。
# 用法：sh make-release.sh [输出目录]
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT_DIR=${1:-"$SCRIPT_DIR/release"}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
PKG="kimi-base-${STAMP}.zip"

if ! command -v git >/dev/null 2>&1; then
  echo "错误：未找到 git" >&2
  exit 1
fi
if ! git -C "$SCRIPT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "错误：$SCRIPT_DIR 不是 git 仓库；git archive 需要仓库" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "错误：未找到 node（读取 package.json files 清单需要）" >&2
  exit 1
fi
if ! command -v unzip >/dev/null 2>&1 && ! command -v python3 >/dev/null 2>&1; then
  echo "错误：未找到 unzip 或 python3（泄漏扫描需要解包校验）" >&2
  exit 1
fi

extract_zip() {
  # $1=zip 文件 $2=目标目录；unzip 优先，python3（标准库 zipfile）兜底
  if command -v unzip >/dev/null 2>&1; then
    unzip -q "$1" -d "$2"
  else
    python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$1" "$2"
  fi
}

# 发布面 = package.json files 清单（逐行 NUL 安全输出，供 git archive pathspec 使用）
FILES=$(node -e 'const p=require(process.argv[1]);process.stdout.write((p.files??[]).join("\n"))' "$SCRIPT_DIR/package.json")
if [ -z "$FILES" ]; then
  echo "错误：package.json 无 files 清单，无法确定发布面" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

echo ">> git archive 打包中（发布面 = package.json files）..."
# pathspec 剔除：运行时状态、私密 feedback、旁路与临时文件
# shellcheck disable=SC2086
git -C "$SCRIPT_DIR" archive --format=zip -o "$TMP_DIR/$PKG" HEAD -- \
  $FILES \
  ':(exclude)**/.kimi-base/state/**' \
  ':(exclude)**/*.kimi-base-new*' \
  ':(exclude)**/feedback/**' \
  ':(exclude)**/*.tmp' \
  ':(exclude)**/*.log'

echo ">> 解包校验..."
mkdir -p "$TMP_DIR/x"
extract_zip "$TMP_DIR/$PKG" "$TMP_DIR/x"

# 泄漏扫描：token / 私钥 / 个人路径；命中即失败（非零退出）
LEAK=0
scan() {
  LABEL=$1
  PATTERN=$2
  HITS=$(grep -rInE -e "$PATTERN" "$TMP_DIR/x" 2>/dev/null || true)
  if [ -n "$HITS" ]; then
    echo "泄漏扫描命中（$LABEL）：" >&2
    echo "$HITS" | head -20 >&2
    LEAK=1
  fi
}

scan "token" '(sk|pk|rk|sess)-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|A(KIA|SIA)[0-9A-Z]{16}'
scan "私钥" 'BEGIN [A-Z ]*PRIVATE KEY-----'
scan "个人路径" '/(Users|home)/[A-Za-z0-9._-]+/|[A-Za-z]:\\Users\\'

# 禁入面复核：包内不得出现运行时状态/旁路/私密 feedback
FORBIDDEN=$(cd "$TMP_DIR/x" && find . \( -path '*/.kimi-base/state/*' -o -name '*.kimi-base-new*' \) -print 2>/dev/null | grep -v 'state/\.gitignore' || true)
if [ -n "$FORBIDDEN" ]; then
  echo "包内含禁入文件：" >&2
  echo "$FORBIDDEN" >&2
  LEAK=1
fi

if [ "$LEAK" -ne 0 ]; then
  echo "发布中止：泄漏扫描未通过" >&2
  exit 2
fi

mv "$TMP_DIR/$PKG" "$OUT_DIR/$PKG"
echo "发布包就绪：$OUT_DIR/$PKG"
