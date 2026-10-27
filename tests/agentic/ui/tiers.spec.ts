// M07 预演四档进度 + 场景片异步卡 组件页测试（RED 先行）
// 契约：
//   tiers.js mount(el, { blockId, scene, onReel, onScene }) → handle.update
//     DOM（prototype L373-377）：.tiers 内四档 形✓/样✓/动▶/真
//   scene-card.js mount(el, { scene: {status,url,poster} }) → handle.update（off/queued/generating/ready）
//     DOM（prototype L162-164/L378-382）：off 空；generating .scenebox>.bar>i；ready 16:9 video+「示意 · AI 生成」
import { test, expect } from '@playwright/test';

async function mountTiers(page: import('@playwright/test').Page, extra: Record<string, unknown> = {}) {
  await page.goto('/component.html?c=tiers');
  await page.evaluate((patch) => {
    window.__calls = [];
    const props = { ...window.__defaults('tiers')!, ...patch } as Record<string, unknown>;
    props.onReel = () => window.__calls!.push(['reel']);
    props.onScene = () => window.__calls!.push(['scene']);
    window.__mount('tiers', props);
  }, extra);
}

async function mountScene(page: import('@playwright/test').Page, scene: Record<string, unknown>) {
  await page.goto('/component.html?c=scene-card');
  await page.evaluate((s) => { window.__mount('scene-card', { scene: s }); }, scene);
}

test('M07 四档 chips：形✓/样✓/动▶（prototype L376）', async ({ page }) => {
  await mountTiers(page, { scene: 'off' });
  const tiers = page.locator('.tiers .tier');
  await expect(tiers).toHaveCount(4);
  await expect(tiers.nth(0)).toContainText('形');
  await expect(tiers.nth(1)).toContainText('样');
  await expect(tiers.nth(2)).toContainText('动');
  await expect(tiers.nth(3)).toContainText('真');
});

test('M07 「动 ▶」触发 onReel 回调（DAG M07）', async ({ page }) => {
  await mountTiers(page, { scene: 'off' });
  await page.locator('.tiers [data-reel], .tiers .tier.go').first().click();
  expect(await page.evaluate(() => window.__calls)).toContainEqual(['reel']);
});

test('M07 「真」三态：off→生成按钮 / generating→生成中 / ready→✓（prototype L375，D-9 默认关）', async ({ page }) => {
  await mountTiers(page, { scene: 'off' });
  const real = page.locator('.tiers .tier').nth(3);
  await expect(real).toContainText('生成场景片');
  await real.click();
  expect(await page.evaluate(() => window.__calls)).toEqual([['scene']]);

  await mountTiers(page, { scene: 'generating' });
  await expect(page.locator('.tiers .tier').nth(3)).toContainText('生成中');

  await mountTiers(page, { scene: 'ready' });
  await expect(page.locator('.tiers .tier').nth(3)).toHaveClass(/ok/);
  await expect(page.locator('.tiers .tier').nth(3)).toContainText('✓');
});

test('M07 scene-card：off 不渲染任何场景卡（D-9）', async ({ page }) => {
  await mountScene(page, { status: 'off' });
  expect(await page.evaluate(() => document.querySelector('#host')!.innerHTML.trim())).toBe('');
});

test('M07 scene-card：generating 进度条存在且宽度为百分比（prototype L163-164）', async ({ page }) => {
  await mountScene(page, { status: 'generating' });
  const bar = page.locator('.scenebox .bar i');
  await expect(bar).toBeAttached();
  const width = await page.evaluate(() => {
    const el = document.querySelector('.scenebox .bar i') as HTMLElement;
    window.__update({ scene: { status: 'generating' } });
    return el.style.width;
  });
  expect(width).toMatch(/%$/);
});

test('M07 scene-card：ready → 16:9 video + poster + controls +「示意 · AI 生成」角标（prototype L381）', async ({ page }) => {
  await mountScene(page, { status: 'ready', url: 'assets/scene-classroom.mp4', poster: 'assets/scene-classroom-poster.jpg' });
  const video = page.locator('.scenebox video');
  await expect(video).toBeAttached();
  await expect(video).toHaveAttribute('poster', 'assets/scene-classroom-poster.jpg');
  expect(await video.getAttribute('controls')).not.toBeNull();
  const ar = await page.evaluate(() => getComputedStyle(document.querySelector('.scenebox .frame')!).aspectRatio);
  expect(ar).toContain('16');
  await expect(page.locator('.scenebox .wm')).toHaveText(/示意/);
});

test('M07 场景状态 aria-live=polite 播报（DAG M07）', async ({ page }) => {
  await mountScene(page, { status: 'generating' });
  const live = await page.evaluate(() => {
    const el = document.querySelector('.scenebox')!;
    window.__update({ scene: { status: 'ready', url: 'assets/scene-classroom.mp4' } });
    return el.getAttribute('aria-live') ?? document.querySelector('[aria-live=polite]')?.getAttribute('aria-live');
  });
  expect(live).toBe('polite');
});

test('M07 generating→ready 同卡原地升级不重建（增量约束）', async ({ page }) => {
  await mountScene(page, { status: 'generating' });
  await page.evaluate(() => {
    document.querySelector('.scenebox')!.setAttribute('data-marker', 'keep');
    window.__update({ scene: { status: 'ready', url: 'assets/scene-classroom.mp4' } });
  });
  expect(await page.getAttribute('.scenebox', 'data-marker')).toBe('keep');
  await expect(page.locator('.scenebox video')).toBeAttached();
});
