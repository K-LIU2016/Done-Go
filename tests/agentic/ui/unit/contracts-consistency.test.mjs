// M21 门禁⑥：合并 W0 契约后的一致性测试（BUILD-PLAN §2.2/§2.4.6）
// 双向契约：
//   ① 自己产出的对象（fixtures.preview() 5 块 × patched 两态 = 10 个 Preview JSON）
//      用 scripts/agentic/contracts.mjs 对 contracts/agentic/preview.schema.json（FROZEN v1）校验通过；
//   ② 自己能吃下 W0 的 fixtures（contracts/agentic/fixtures/preview.fixtures.json 全部 valid 样例）：
//      shape.blocks 逐块过 W5 渲染层（registry.renderShape，未知类型降级不抛）、
//      boundary（budget 整段串）过 boundaries.normalizeBoundary、storyboard 条目 at/actor/text 可读。
// 附：invalid 样例被校验器拒绝（证校验器在岗，非恒真断言）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSchema, validate } from '../../../../scripts/agentic/contracts.mjs';
import { preview } from '../../../../web/agentic/ui/fixtures.js';
import { renderShape } from '../../../../web/agentic/ui/shape/registry.js';
import '../../../../web/agentic/ui/shape/text-shapes.js'; // 注册 outline/facts/caveat/table/cards（副作用）
import '../../../../web/agentic/ui/shape/rich-shapes.js'; // 注册 checklist/timeline/slides/diffSummary/mapRoute/personCard/sample
import { normalizeBoundary } from '../../../../web/agentic/ui/boundaries.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../../');
const contractDir = join(root, 'contracts/agentic');
const schema = loadSchema('preview.schema.json', contractDir);
const w0Fixtures = JSON.parse(readFileSync(join(contractDir, 'fixtures/preview.fixtures.json'), 'utf8'));

const IDS = ['r', 'c', 'f', 'b', 's'];

test('M21 ① 产出校验：fixtures.preview() 全部 10 个对象过 W0 preview.schema.json（FROZEN v1）', () => {
  for (const id of IDS) {
    for (const opts of [{}, { patched: true }]) {
      const result = validate(preview(id, opts), schema, { schemaDir: contractDir });
      assert.deepEqual(
        { id, opts, valid: result.valid },
        { id, opts, valid: true },
        `preview(${id}, ${JSON.stringify(opts)}) 契约校验失败：${JSON.stringify(result.errors)}`,
      );
    }
  }
});

test('M21 ② 吃下 W0 fixtures：valid 样例 shape.blocks 逐块过 W5 渲染层（降级不抛）', () => {
  assert.ok(w0Fixtures.valid.length >= 2, 'W0 preview fixtures 至少 2 个 valid 样例');
  for (const sample of w0Fixtures.valid) {
    assert.ok(Array.isArray(sample.shape.blocks), '样例 shape.blocks 应为数组');
    for (const block of sample.shape.blocks) {
      const html = renderShape(block);
      assert.equal(typeof html, 'string', `块 ${block.type} 应渲染出字符串`);
      assert.ok(html.length > 0, `块 ${block.type} 渲染结果非空（未知类型降级纯文本也非空）`);
      assert.ok(!html.includes('<script'), '渲染结果不得引入脚本');
    }
  }
});

test('M21 ② 吃下 W0 fixtures：boundary（budget 整段串）过 normalizeBoundary 四栏不丢', () => {
  for (const sample of w0Fixtures.valid) {
    const b = normalizeBoundary(sample.boundary);
    assert.ok(Array.isArray(b.will) && Array.isArray(b.wont) && Array.isArray(b.needs) && Array.isArray(b.budget));
    // 契约 budget 是整段串：normalizeItems 单串容忍收为单元素，内容不丢
    if (typeof sample.boundary.budget === 'string' && sample.boundary.budget.trim()) {
      assert.deepEqual(b.budget, [sample.boundary.budget.trim()]);
    }
  }
});

test('M21 ② 吃下 W0 fixtures：storyboard 条目 at/actor/text 三键可读（you 以 actor 标记）', () => {
  for (const sample of w0Fixtures.valid) {
    for (const ev of sample.storyboard || []) {
      for (const key of ['at', 'actor', 'text']) assert.ok(key in ev, `storyboard 条目缺 ${key}`);
    }
  }
});

test('M21 附：invalid 样例被校验器拒绝（校验器在岗）', () => {
  assert.ok(w0Fixtures.invalid.length >= 1, 'W0 fixtures 应带 invalid 样例');
  const rejected = w0Fixtures.invalid.filter((v) => validate(v, schema, { schemaDir: contractDir }).valid === false);
  assert.equal(rejected.length, w0Fixtures.invalid.length, '全部 invalid 样例都应被拒绝');
});
