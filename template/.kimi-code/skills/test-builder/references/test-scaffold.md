# 测试基建最小 scaffold 参考

> 原则：最小可用。先让空套件 + 一个样例用例能跑通，再写真测试。不引入覆盖率门禁、不接 CI（除非用户要求）。新增框架依赖必须先获授权。

---

## 后端 · pytest（Python / FastAPI）

**依赖**（加进 dev 依赖；异步测试才需 pytest-asyncio）：

```text
pytest
pytest-asyncio    # 仅当要测 async 函数/路由时
```

**目录约定**：`tests/`，文件名 `test_*.py`。

**最小可用配置**（`pytest.ini` 或 pyproject 段，按需）：

```ini
[pytest]
testpaths = tests
asyncio_mode = auto    # 用了 pytest-asyncio 才加
```

**样例用例**（`tests/test_smoke.py`，验证基建可跑）：

```python
def test_scaffold_alive():
    assert 1 + 1 == 2
```

**纯逻辑测试范式**（优先：喂构造数据给纯函数/构造器，不起真库）：

```python
from pkg.exporters import build_payload, pack_archive
from pkg.parsers import parse_archive

def test_export_import_roundtrip_contract():
    """命脉契约：导出再导入，实体要素 100% 回灌。"""
    rows = [ ... ]   # 构造最小行
    payload = build_payload(rows)
    res = parse_archive(pack_archive(payload))
    assert len(res.items) == len(rows)
```

**需要真库时**（尽量避免）：用最小 fixture 起测试库 + 事务回滚，**绝不连生产/基线库**。

**跑**：`python -m pytest -q`

---

## 前端 · vitest（TypeScript / React + Vite）

**依赖**（devDependencies）：

```text
vitest
@testing-library/react   # 仅当要测组件渲染时；纯函数不需要
jsdom                    # 组件/DOM 测试才需
```

**package.json scripts**：

```json
{ "scripts": { "test": "vitest run", "test:watch": "vitest" } }
```

**最小配置**（`vitest.config.ts`，纯函数测试可省 environment）：

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { environment: "node" },   // 测组件改 "jsdom"
});
```

**样例 + 纯函数测试范式**（`src/utils.test.ts`，优先测无副作用纯函数）：

```ts
import { describe, it, expect } from "vitest";
import { metersToProjRadius } from "./utils";

describe("utils 纯函数", () => {
  it("scaffold alive", () => expect(1 + 1).toBe(2));
  it("metersToProjRadius 按纬度修正", () => {
    expect(metersToProjRadius(200, 0)).toBeCloseTo(200, 0);
  });
});
```

**跑**：`npm run test`

---

## 取舍提醒

- 先测纯逻辑 / 契约 / 解析（构造数据即可，跑得快、稳）。
- 组件渲染、E2E 成本高，按预算和价值排后。
- scaffold 阶段只求「样例能跑通」，真正的高价值用例按 test-builder 的测试预算优先级补，且每条用例必须带 trace 锚点（REQ 号 / 缺陷号 / 契约条目）。
