import { test, expect, type Page } from '@playwright/test';

const day = '2026-10-19';
const method = { id: 'm-demo', version: 1, createdAt: '2026-10-18T08:00:00.000Z', updatedAt: '2026-10-18T08:00:00.000Z', name: '论文要点与出处核验', purpose: '带着研究问题读论文', category: 'read', fit: '公开材料', unfit: '无权分享的材料', inputs: '[论文]、[研究问题]', steps: '整理要点\n回到原文核对', verify: '核对页码和关键结论', stop: '缺少来源就停止', modelId: 'unknown', modelReason: '未验证', status: 'active', origin: { taskId: 'source-demo', date: '2026-10-18', quality: 'accepted' } };
const state = { v: 1, pv: 5, mode: 'demo', name: '', wake: 960, entries: [
  { id: 'read-demo', date: day, title: '读论文：比较不同方法的假设、结论和适用条件，然后逐项核对关键引用', kind: 'explore', prio: 1, start: '09:00', end: '10:00' },
  { id: 'write-demo', date: day, title: '整理研究提纲', kind: 'create', prio: 2, start: '10:30', end: '11:30' },
  { id: 'walk-demo', date: day, title: '去公园走走', kind: 'restore', prio: 4, start: '17:00', end: '17:30' }
], methods: [method], methodUses: [], trials: [], drafts: [], fw: {}, sound: false, pal: 0 };
async function open(page: Page) {
  await page.clock.install({ time: new Date(day + 'T10:45:00+08:00') });
  await page.route('https://**', route => route.abort());
  await page.route('**/api/llm/config', route => route.fulfill({ json: { endpoints: [] } }));
  await page.route('**/api/assistant/config', route => route.fulfill({ json: { available: true, provider: 'openai', model: 'fixture-configured-model-with-a-long-name-for-responsive-testing', destination: 'https://example.test/v1/chat/completions', reasoningEffort: 'xhigh' } }));
  await page.addInitScript(state => {
    if (!localStorage.getItem('companion-ux-fixture')) {
      localStorage.setItem('tango-donego.web.v1', JSON.stringify(state));
      localStorage.setItem('tango-donego.lang', 'zh');
      localStorage.setItem('tango-donego.llm.v1', JSON.stringify({ mode: 'off', consent: false }));
      localStorage.setItem('companion-ux-fixture', '1');
    }
  }, state);
  await page.goto('/#today');
}
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

test('companion pages preserve clear actions at 360, 768 and 1440 with explicit demo records', async ({ page }, info) => {
  await open(page);
  const widths = info.project.name === 'mobile' ? [360] : [1440, 768];
  for (const width of widths) {
    await page.setViewportSize({ width, height: width === 360 ? 800 : 1000 });
    for (const route of ['today', 'assistant', 'review', 'line']) {
      await page.goto('/#' + route);
      await expect(page.locator('.demo-notice')).toContainText('演示记录');
      expect(await noOverflow(page)).toBe(true);
      await page.screenshot({ path: info.outputPath('companion-' + width + '-' + route + '.png'), fullPage: true });
    }
    await page.goto('/#today');
    const capture = await page.locator('#cap-text').boundingBox(), route = await page.locator('.paper-route').boundingBox();
    expect(capture!.y).toBeLessThan(route!.y);
    await page.locator('.paper-route .paper-event', { hasText: '去公园走走' }).click();
    await expect(page.locator('.sheet [data-act="event-ai"]')).toHaveCount(0);
    await page.locator('[data-act="close"]').first().click();
    await page.locator('.paper-route .paper-event', { hasText: '读论文：' }).click();
    await expect(page.locator('.sheet [data-act="event-ai"]')).toBeVisible();
    await page.locator('[data-act="close"]').first().click();
  }
  if (info.project.name === 'desktop') {
    const logo = new URL('/brand/robot-logo.png', page.url()).href;
    await page.setContent('<html lang="zh-CN"><body style="background:#FAF8F3;color:#252722;font:16px sans-serif;padding:32px"><h1>品牌素材尺寸检查 · 测试页</h1><p>原始 PNG，未重绘白色 T</p><div style="display:flex;gap:40px;align-items:end">' + [16, 24, 32, 48].map(size => '<figure><img src="' + logo + '" width="' + size + '" height="' + size + '" alt="原始探戈 Logo"><figcaption>' + size + ' px</figcaption></figure>').join('') + '</div></body></html>');
    await expect.poll(() => page.locator('img').evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
    await page.screenshot({ path: info.outputPath('logo-size-audit.png') });
  }
});

test('create and edit a task, then choose a task-specific AI prompt without calling a model', async ({ page }) => {
  await open(page);
  let calls = 0;
  await page.route('**/api/assistant/chat', route => { calls++; return route.abort(); });
  await page.locator('#cap-text').fill('下午两点到三点开会');
  await page.locator('#capGo').click();
  await page.locator('[data-act="draft-commit"]').click();
  await page.locator('.paper-route .paper-event', { hasText: '开会' }).click();
  await page.locator('.sheet [data-act="edit"]').click();
  await page.locator('#ed-title').fill('准备组会议程');
  await page.locator('[data-act="ed-save"]').click();
  const row = page.locator('.paper-stop', { hasText: '准备组会议程' });
  await expect(row).toContainText('14:00');
  await row.locator('button.paper-event').click();
  await page.locator('.sheet [data-act="event-ai"]').click();
  await page.locator('.sheet details', { has: page.locator('#model-prompt') }).locator('summary').click();
  await expect(page.locator('#model-prompt')).toBeEditable();
  await page.locator('#model-prompt').fill('先列议程，再核对讨论目标；不编造参会者。');
  await expect(page.locator('.sheet')).not.toContainText('本地工作流规则候选');
  await expect(page.locator('.sheet .model-reason').first()).not.toBeEmpty();
  await expect(page.locator('.sheet')).toContainText('暂时不用 AI');
  expect(calls).toBe(0);
});

test('reuse an existing method only after choosing a task, with editable method versions', async ({ page }) => {
  await open(page);
  await page.goto('/#review');
  await page.locator('[data-act="method-library"]').click();
  await page.locator('[data-act="method-reuse"]').click();
  await expect(page.locator('.sheet')).toContainText('这次用在哪件事');
  await page.locator('.sheet [data-act="method-edit"]').click();
  await page.locator('#me-verify').fill('核对页码、结论与原始图表');
  await page.locator('[data-act="method-edit-save"]').click();
  await page.locator('[data-act="method-library"]').click();
  await page.locator('[data-act="method-reuse"]').click();
  await page.locator('.reuse-task[data-id="read-demo"]').click();
  await expect(page.locator('.sheet')).toContainText('核对页码、结论与原始图表');
  await page.locator('[data-act="method-apply"]').click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('tango-donego.web.v1')!));
  expect(saved.entries[0].methodRef).toMatchObject({ methodId: 'm-demo', version: 2 });
  expect(saved.methodUses[0]).toMatchObject({ methodVersion: 2, status: 'applied', taskId: 'read-demo' });
  expect(saved.entries[1]).not.toHaveProperty('methodRef');
});

test('short viewport, long response and enlarged text leave chat and keyboard controls usable', async ({ page }, info) => {
  await open(page);
  await page.setViewportSize({ width: 360, height: 460 });
  await page.goto('/#assistant');
  await page.route('**/api/assistant/chat', route => route.fulfill({ contentType: 'text/event-stream', body: 'data: ' + JSON.stringify({ text: '这是受控测试回答。\n\n' + '请逐项核对任务要求和来源。\n'.repeat(30) }) + '\n\ndata: [DONE]\n\n' }));
  await page.locator('#assistant-message').fill('测试长回答');
  await page.locator('#assistant-send').click();
  await expect(page.locator('.companion-message:not(.is-user)')).toContainText('受控测试回答');
  await page.locator('#assistant-message').fill('下一条草稿');
  await page.locator('#assistant-message').scrollIntoViewIfNeeded();
  await expect(page.locator('#assistant-send')).toBeInViewport();
  await page.locator('#assistant-privacy summary').click();
  await page.locator('#assistant-share-metrics').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#assistant-share-metrics')).toBeFocused();
  await expect(page.locator('#assistant-message')).toHaveValue('下一条草稿');
  await page.locator('#assistant-privacy summary').click();
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  expect(await noOverflow(page)).toBe(true);
  await page.locator('#assistant-message').scrollIntoViewIfNeeded();
  await expect(page.locator('#assistant-send')).toBeInViewport();
  await page.screenshot({ path: info.outputPath('companion-zoom-short-' + info.project.name + '.png'), fullPage: true });
});
