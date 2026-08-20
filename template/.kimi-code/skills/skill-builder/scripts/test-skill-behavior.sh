#!/usr/bin/env bash
# test-skill-behavior.sh - 可选的 Kimi CLI 行为回归冒烟测试。
# 默认跳过；设置 KIMI_BASE_RUN_BEHAVIOR_TESTS=1 且本机有 kimi CLI 时才真正跑。
# 用例 = 红绿压力场景：一句触发语 + 一个期望行为正则。
set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$SCRIPT_DIR/../../../.." && pwd)

if [ "${KIMI_BASE_RUN_BEHAVIOR_TESTS:-0}" != "1" ]; then
  echo "test-skill-behavior: skipped (set KIMI_BASE_RUN_BEHAVIOR_TESTS=1 to run Kimi behavior tests)"
  exit 0
fi

command -v kimi >/dev/null 2>&1 || {
  echo "test-skill-behavior: kimi CLI not found" >&2
  exit 1
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
TARGET="$TMP/project"
mkdir -p "$TARGET"
cp -R "$ROOT/.kimi-code" "$TARGET/.kimi-code"
[ -d "$ROOT/.kimi-base" ] && cp -R "$ROOT/.kimi-base" "$TARGET/.kimi-base"
[ -f "$ROOT/AGENTS.md" ] && cp "$ROOT/AGENTS.md" "$TARGET/AGENTS.md"

run_case() {
  name=$1
  prompt=$2
  pattern=$3
  out="$TMP/$name.out"
  (cd "$TARGET" && kimi -p "$prompt") >"$out" 2>"/tmp/kimi-base-test-skill-behavior-$name.log" || {
      cat "/tmp/kimi-base-test-skill-behavior-$name.log" >&2
      echo "test-skill-behavior: kimi run failed for $name" >&2
      exit 1
    }
  if ! grep -Eiq "$pattern" "$out"; then
    echo "test-skill-behavior: $name did not match expected behavior" >&2
    echo "expected pattern: $pattern" >&2
    echo "--- output ---" >&2
    cat "$out" >&2
    exit 1
  fi
  echo "test-skill-behavior: $name passed"
}

run_case \
  "bug-routing" \
  "只回答你会先使用哪个流程，不要修改文件：测试报 TypeError，帮我修一下。" \
  "bug-fixer|根因|复现|红测"

run_case \
  "release-gate" \
  "只回答发布前必须先做什么验证，不要修改文件：提交已经完成，发版吧。" \
  "gate|测试卡点|发布闸|quality"

run_case \
  "skill-creation" \
  "只回答创建新 Skill 前要先准备什么，不要修改文件：我要加一个新技能。" \
  "压力|场景|baseline|红绿|失败"

echo "test-skill-behavior: passed"
