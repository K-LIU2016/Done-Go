// W11 golden-smoke · 冒烟产物结构先行单测（RED 契约）。
// 依据：DAG 组4：真实外呼只在 smoke.mjs 的 main()（组4 冒烟阶段执行，本测试绝不触发）；
// 本文件固化黄金场景数据与预算红线（PRD §3.2 课程设计：初中老师 4 课时工作坊）：
// 生图 ≤20、生视频 ≤2（BUILD-PLAN §2.3）；产品默认 30 张/天与冒烟 ≤20 是两个数字。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { goldenScenario, SMOKE_BUDGET } from '../../../../scripts/agentic/media/smoke.mjs';
import { composeSample } from '../../../../scripts/agentic/composer/compose-sample.mjs';
import { DEFAULT_IMAGE_QUOTA } from '../../../../scripts/agentic/media/quota.mjs';

test('the smoke budget obeys the hard caps: ≤20 images, ≤2 videos', () => {
  assert.ok(SMOKE_BUDGET.images > 0 && SMOKE_BUDGET.images <= 20, '生图冒烟配额在 20 以内');
  assert.ok(SMOKE_BUDGET.videos >= 0 && SMOKE_BUDGET.videos <= 2, '生视频冒烟配额在 2 以内');
  assert.notEqual(SMOKE_BUDGET.images, DEFAULT_IMAGE_QUOTA, '冒烟预算与产品默认（30）是分开的两个数字');
});

test('goldenScenario is the PRD §3.2 course-design mission: 2 pure-visual slide samples', () => {
  const g = goldenScenario();
  assert.ok(g.missionId && g.version >= 1);
  assert.equal(g.samples.length, 2, '黄金场景 = 2 页幻灯片样张');
  for (const s of g.samples) {
    assert.equal(s.layout, 'slide-title-bullets-image');
    assert.equal(s.image.model, 'z-image-turbo', '纯画面用 z-image-turbo（PRD §2.4）');
    assert.ok(s.image.prompt.includes('不要出现任何文字'), '配图 prompt 必须声明无文字（PRD §10.3）');
    assert.equal(s.watermark, '示意');
    assert.ok(typeof s.text.title === 'string' && s.text.title.length > 0);
    assert.ok(Array.isArray(s.text.bullets) && s.text.bullets.length > 0);
  }
  assert.notEqual(g.samples[0].page, g.samples[1].page, '两页样张是不同的页');
});

test('goldenScenario carries a storyboard and a Chinese narration for the 40s reel', () => {
  const g = goldenScenario();
  assert.ok(Array.isArray(g.storyboard) && g.storyboard.length >= 4, '预演片至少 4 个分镜（黄金场景时间线）');
  for (const sb of g.storyboard) {
    assert.ok(sb.at && sb.actor && sb.text, '分镜字段 at/actor/text（PRD §10.3）');
  }
  assert.ok(typeof g.narration === 'string' && g.narration.length >= 20);
  assert.ok(/课时|课程|交付/.test(g.narration), '旁白围绕黄金场景（课程设计工作坊）');
});

test('the golden samples render through composeSample without any network (快照固化冒烟产物结构)', () => {
  const g = goldenScenario();
  for (const s of g.samples) {
    const html = composeSample(s, null); // 冒烟时才有真图；结构测试不依赖网络
    assert.ok(html.includes(`data-layout="${s.layout}"`));
    assert.ok(html.includes('<span class="wm">示意</span>'));
    assert.ok(html.includes(s.text.title));
  }
});
