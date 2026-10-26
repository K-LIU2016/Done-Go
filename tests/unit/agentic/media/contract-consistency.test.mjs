// W11 w0-merge-close · 契约一致性先行单测（RED 契约）。
// 依据：BUILD-PLAN §2.2："收尾阶段必须 git merge feat/s2d-w0-contracts，并加一条契约
// 一致性测试：自己产出的对象用 scripts/agentic/contracts.mjs 校验通过、自己能吃下
// W0 的 fixtures"。PRD §10.3 定义 sample/reel/scene 对象。
// ⚠️ 假设（组5 合并后需与冻结版对齐）：contracts.mjs 导出名为 validate（或
// validateObject/default）的校验函数，调用形态 (schema, obj) 或 (obj, schema)，
// 返回真值或 { ok }；schema 文件按对象名放在 contracts/agentic/。
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const importHere = rel => import(pathToFileURL(join(root, rel)).href);
const contractsDir = join(root, 'contracts', 'agentic');
const fixturesDir = join(contractsDir, 'fixtures');

// PRD §10.3 的 canonical 对象（W11 产出）
const CANONICAL_SAMPLE = {
  id: 's1',
  layout: 'slide-title-bullets-image',
  page: '第 2 课时 · 首页',
  text: { title: 'AI 进课堂 · 第 2 课时：用 AI 备课', bullets: ['用 AI 生成导入问题', '对照课标逐条核对', '说出 AI 帮了哪、错在哪'] },
  image: { prompt: '老师在教室用平板备课，清新鼠尾草绿，扁平插画，不要出现任何文字', model: 'z-image-turbo', url: '/api/media/abc.png', status: 'ready' },
  watermark: '示意',
};
const CANONICAL_REEL = { composition: '/api/previews/m_123/v4/reel.html', durationSec: 42, narrationAudio: '/api/previews/m_123/v4/narration.wav', mp4: null };
const CANONICAL_SCENE = { status: 'off', model: 'happyhorse-1.1-t2v', url: null };

async function loadContracts() {
  const mod = await importHere('scripts/agentic/contracts.mjs');
  const validator = mod.validate ?? mod.validateObject ?? mod.default;
  assert.equal(typeof validator, 'function', 'contracts.mjs 未导出可识别的校验入口（validate/validateObject/default）');
  return { mod, validator };
}

function loadSchema(candidates) {
  for (const name of candidates) {
    try { return JSON.parse(readFileSync(join(contractsDir, name), 'utf8')); } catch { /* try next */ }
  }
  assert.fail('contracts/agentic/ 缺少 ' + candidates.join(' 或 ') + '（必须先 merge feat/s2d-w0-contracts）');
}

async function validates(validator, schema, obj) {
  let result;
  try { result = await validator(schema, obj); } catch { result = await validator(obj, schema); }
  if (result && typeof result === 'object') return result.ok !== false;
  return !!result;
}

test('W11 sample/reel/scene objects pass the W0 contract validator', async () => {
  const { validator } = await loadContracts();
  const sampleSchema = loadSchema(['sample.schema.json', 'samples.schema.json']);
  const reelSchema = loadSchema(['reel.schema.json']);
  const sceneSchema = loadSchema(['scene.schema.json']);
  assert.ok(await validates(validator, sampleSchema, CANONICAL_SAMPLE), 'sample 对象过契');
  assert.ok(await validates(validator, reelSchema, CANONICAL_REEL), 'reel 对象过契');
  assert.ok(await validates(validator, sceneSchema, CANONICAL_SCENE), 'scene 对象过契');
});

test('W11 composers swallow W0 fixtures without breaking (吃下 fixtures 渲染不炸)', async () => {
  const { composeSample } = await importHere('scripts/agentic/composer/compose-sample.mjs');
  const { composeReel } = await importHere('scripts/agentic/composer/compose-reel.mjs');
  const files = readdirSync(fixturesDir).filter(f => f.endsWith('.json'));
  assert.ok(files.length >= 2, 'contracts/agentic/fixtures/ 至少每个对象 2 个合法样例（BUILD-PLAN §2.2）');
  let fed = 0;
  for (const f of files) {
    const fixture = JSON.parse(readFileSync(join(fixturesDir, f), 'utf8'));
    const previews = Array.isArray(fixture) ? fixture : [fixture];
    for (const p of previews) {
      if (Array.isArray(p?.samples)) {
        for (const s of p.samples) {
          const html = composeSample(s, s.image ?? null);
          assert.equal(typeof html, 'string');
          fed += 1;
        }
        if (Array.isArray(p.storyboard)) {
          const reelHtml = composeReel({ ...p, durationSec: p.reel?.durationSec ?? p.durationSec ?? 0 });
          assert.match(reelHtml, /^<!doctype html>/i);
        }
      }
    }
  }
  assert.ok(fed > 0, 'fixtures 里必须有带 samples 的对象可喂给 composeSample');
});
