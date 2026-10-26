// W11 w0-merge-close · 契约一致性单测（GREEN：对齐 W0 冻结版 contracts.mjs）。
// 依据：BUILD-PLAN §2.2「收尾阶段必须 git merge feat/s2d-w0-contracts，并加一条契约
// 一致性测试：自己产出的对象用 scripts/agentic/contracts.mjs 校验通过、自己能吃下
// W0 的 fixtures」。PRD §10.3 定义 sample/reel/scene 对象。
// 冻结版 API（scripts/agentic/contracts.mjs，feat/s2d-w0-contracts @1331960 冻结）：
// validate(value, schema, { schemaDir }) → { valid, errors }（value 在前）；schema 按
// 对象名放在 contracts/agentic/preview-{sample,reel,scene}.schema.json；fixtures 形如
// { valid: [...], invalid: [...] }，合法样例每个对象 ≥2 个。
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { validate } from '../../../../scripts/agentic/contracts.mjs';
import { goldenScenario, buildSmokePreview } from '../../../../scripts/agentic/media/smoke.mjs';
import { composeSample } from '../../../../scripts/agentic/composer/compose-sample.mjs';
import { composeReel } from '../../../../scripts/agentic/composer/compose-reel.mjs';
import { exportReel } from '../../../../scripts/agentic/composer/export.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const contractsDir = join(root, 'contracts', 'agentic');
const fixturesDir = join(contractsDir, 'fixtures');

const schemaOf = name => JSON.parse(readFileSync(join(contractsDir, name), 'utf8'));
const fixturesOf = name => JSON.parse(readFileSync(join(fixturesDir, name), 'utf8'));
/** 冻结校验入口：value 在前，schema 在后（schemaDir 供 $ref 解析同级 schema）。 */
const check = (value, schema) => validate(value, schema, { schemaDir: contractsDir });

test('W11 产出的 sample/scene 对象过冻结契约（goldenScenario 未生成态 + buildSmokePreview 装配态）', () => {
  const sampleSchema = schemaOf('preview-sample.schema.json');
  const sceneSchema = schemaOf('preview-scene.schema.json');
  const golden = goldenScenario();
  for (const s of golden.samples) {
    const r = check(s, sampleSchema);
    assert.equal(r.valid, true, `golden 样张 ${s.id} 过 preview-sample 契约：${JSON.stringify(r.errors)}`);
  }
  const sr = check(golden.scene, sceneSchema);
  assert.equal(sr.valid, true, `golden scene 过 preview-scene 契约：${JSON.stringify(sr.errors)}`);
  // 冒烟装配态（配图落地：url + status ready）同样必须过契
  const preview = buildSmokePreview({
    golden,
    subtitles: [{ text: '先看第 1 课时样张', startSec: 1, endSec: 3 }],
    durationSec: 32,
    imageUrlFor: id => `/media/${id}.png`,
  });
  for (const s of preview.samples) {
    const r = check(s, sampleSchema);
    assert.equal(r.valid, true, `装配态样张 ${s.id} 过 preview-sample 契约：${JSON.stringify(r.errors)}`);
  }
});

test('W11 产出的 reel 对象过冻结契约（字段取实产，mp4 按留桩语义=null）', () => {
  const reelSchema = schemaOf('preview-reel.schema.json');
  const preview = buildSmokePreview({
    subtitles: [],
    durationSec: 41.58,
    imageUrlFor: id => `/media/${id}.png`,
  });
  const exported = exportReel({ composition: '/previews/m_smoke_course/v1/reel.html' });
  assert.equal(exported.status, 'pending', 'export 留桩未产出 mp4（P2 HyperFrames，BUILD-PLAN W11.2）');
  // composition/narrationAudio/durationSec 全部取 W11 实产字段；mp4 只有 export 成功态才非空
  const reel = {
    composition: '/previews/m_smoke_course/v1/reel.html',
    durationSec: preview.durationSec,
    narrationAudio: preview.narrationAudio,
    mp4: exported.status === 'ok' ? exported.mp4 : null,
  };
  const r = check(reel, reelSchema);
  assert.equal(r.valid, true, `reel 过 preview-reel 契约：${JSON.stringify(r.errors)}`);
});

test('校验器对照组：W0 fixtures valid 全过、invalid 必被拦（证明上面不是空转通过）', () => {
  for (const name of ['preview-sample', 'preview-reel', 'preview-scene']) {
    const schema = schemaOf(`${name}.schema.json`);
    const fx = fixturesOf(`${name}.fixtures.json`);
    assert.ok(fx.valid.length >= 2, `${name} 至少 2 个合法样例（BUILD-PLAN §2.2）`);
    assert.ok(fx.invalid.length >= 1, `${name} 至少 1 个非法样例`);
    for (const v of fx.valid) assert.equal(check(v, schema).valid, true, `${name} 合法样例应过契`);
    for (const v of fx.invalid) assert.equal(check(v, schema).valid, false, `${name} 非法样例必须被拦下`);
  }
});

test('W11 composers 吃下 W0 fixtures 渲染不炸（composeSample/composeReel 全量喂）', () => {
  const files = readdirSync(fixturesDir).filter(f => f.endsWith('.json'));
  assert.ok(files.length >= 2, 'contracts/agentic/fixtures/ 存在（必须先 merge feat/s2d-w0-contracts）');
  let fedSamples = 0;
  let fedPreviews = 0;
  for (const f of files) {
    for (const p of fixturesOf(f).valid ?? []) {
      if (!p || typeof p !== 'object') continue;
      // 样张形状（layout 字段）→ composeSample；配图给缓存后的 { url }（无 url 自然降级纯排版）
      if (p.layout !== undefined) {
        const html = composeSample(p, p.image ?? null);
        assert.equal(typeof html, 'string');
        fedSamples += 1;
      }
      // preview 形状（samples+storyboard）→ composeReel 整体吃下（时长取 reel 实测）
      if (Array.isArray(p.samples) && Array.isArray(p.storyboard)) {
        const reelHtml = composeReel({ ...p, durationSec: p.reel?.durationSec ?? p.durationSec ?? 0 });
        assert.match(reelHtml, /^<!doctype html>/i);
        fedPreviews += 1;
        for (const s of p.samples) {
          const html = composeSample(s, s.image ?? null);
          assert.equal(typeof html, 'string');
          fedSamples += 1;
        }
      }
    }
  }
  assert.ok(fedSamples >= 2, 'fixtures 里喂进 composeSample 的样张 ≥2（含 preview 内嵌 samples）');
  assert.ok(fedPreviews >= 2, 'fixtures 里喂进 composeReel 的 preview ≥2');
});
