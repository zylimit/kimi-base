#!/usr/bin/env bash
# skill-description-lint.sh - 校验 .kimi-code/skills/ 下所有 SKILL.md 的发现元数据。
# 规则：frontmatter 存在；name 为 kebab-case 且等于目录名；description 必填、≤180 字符、
# 触发式开头（当/由）；不含流程摘要词（防止模型读摘要而不加载全文）。
set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# 脚本位于 <root>/.kimi-code/skills/skill-builder/scripts/
ROOT=$(cd "$SCRIPT_DIR/../../../.." && pwd)

python3 - "$ROOT" <<'PY'
from pathlib import Path
import re
import sys

root = Path(sys.argv[1])
skills_dir = root / ".kimi-code" / "skills"
failures = []

def fail(path, message):
    failures.append(f"{path.relative_to(root)}: {message}")

if not skills_dir.is_dir():
    print(f"skill-description-lint: {skills_dir} 不存在", file=sys.stderr)
    raise SystemExit(1)

for path in sorted(skills_dir.glob("*/SKILL.md")):
    text = path.read_text(encoding="utf-8")
    m = re.match(r"---\n(.*?)\n---\n", text, re.S)
    if not m:
        fail(path, "missing frontmatter")
        continue

    fields = {}
    for line in m.group(1).splitlines():
        if ":" not in line:
            fail(path, f"invalid frontmatter line: {line}")
            continue
        key, value = line.split(":", 1)
        fields[key.strip()] = value.strip().strip('"')

    name = fields.get("name", "")
    desc = fields.get("description", "")
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name):
        fail(path, f"invalid name: {name!r}")
    if name != path.parent.name:
        fail(path, f"name {name!r} != directory {path.parent.name!r}")
    if not desc:
        fail(path, "missing description")
        continue
    if len(desc) > 180:
        fail(path, f"description too long: {len(desc)} chars")
    if not (desc.startswith("当") or desc.startswith("由")):
        fail(path, "description should describe trigger conditions first")

    # 发现元数据不应是迷你流程。写成流程摘要，模型可能照着摘要做而不加载全文。
    workflow_tokens = ["通过", "分阶段", "输出", "生成", "执行", "支持", "内置", "维护"]
    hits = [token for token in workflow_tokens if token in desc]
    if hits:
        fail(path, "description contains workflow summary token(s): " + ", ".join(hits))

if failures:
    print("skill-description-lint: failed", file=sys.stderr)
    for item in failures:
        print(f"- {item}", file=sys.stderr)
    raise SystemExit(1)

print("skill-description-lint: passed")
PY
