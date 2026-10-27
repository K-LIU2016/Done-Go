// M05 交付徽标 + 块卡列表 组件页测试（RED 先行）
// 契约：block-card.js mount(el, { blocks, sel, status, pending, onSelect }) → handle.update
//   DOM（prototype L343-351）：button.block[data-b] > .t 时间 + .ttl 标题(+span.dot.<status>) + .chips
//   chips：类型 chip / 可交付度 chip.hi|chip.mid / 「需要你 N」chip.you / 状态 chip
import { test, expect } from '@playwright/test';

async function mount(page: import('@playwright/test').Page, extra: Record<string, unknown> = {}) {
  await page.goto('/component.html?c=block-card');
  await page.evaluate((patch) => {
    window.__calls = [];
    const props = { ...window.__defaults('block-card')!, ...patch } as Record<string, unknown>;
    props.onSelect = (id: string) => window.__calls!.push(['select', id]);
    window.__mount('block-card', props);
  }, extra);
}

test('M05 黄金场景 5 张块卡，时间与标题齐全（PRD §5.1 交付徽标宿主）', async ({ page }) => {
  await mount(page);
  await expect(page.locator('button.block')).toHaveCount(5);
  await expect(page.locator('.block[data-b=r] .t')).toHaveText('14:00–15:00');
  await expect(page.locator('.block[data-b=r] .ttl')).toContainText('AI 教育的深度研究');
});

test('M05 类型 chip + 可交付度 chip（hi/mid，prototype L250-251）', async ({ page }) => {
  await mount(page);
  await expect(page.locator('.block[data-b=r] .chip').first()).toHaveText('研究报告');
  await expect(page.locator('.block[data-b=r] .chip.hi')).toContainText('可交付度 高');
  await expect(page.locator('.block[data-b=c] .chip.mid')).toContainText('可交付度 中');
});

test('M05 「需要你 N」chip.you 按待办数出现/隐藏（PRD §3.2 +3s 行）', async ({ page }) => {
  await mount(page, { pending: { c: 2, r: 0 } });
  await expect(page.locator('.block[data-b=c] .chip.you')).toHaveText('需要你 2');
  await expect(page.locator('.block[data-b=r] .chip.you')).toHaveCount(0);
});

test('M05 状态点五态 + 状态 chip（prep/live/need/ready/done，prototype L342/L58-64）', async ({ page }) => {
  await mount(page, { status: { r: 'prep', c: 'live', f: 'need', b: 'ready', s: 'done' } });
  for (const [id, cls] of [['r', 'prep'], ['c', 'live'], ['f', 'need'], ['b', 'ready'], ['s', 'done']] as const) {
    await expect(page.locator(`.block[data-b=${id}] .dot.${cls}`)).toHaveCount(1);
  }
  await expect(page.locator('.block[data-b=r] .chips')).toContainText('准备中');
  await expect(page.locator('.block[data-b=b] .chips')).toContainText('待验收');
});

test('M05 pulse 动画只在运行态、reduced-motion 下不闪（DAG M05）', async ({ page }) => {
  await mount(page, { status: { r: 'live' } });
  const animated = await page.evaluate(() => getComputedStyle(document.querySelector('.dot.live')!).animationName);
  expect(animated).not.toBe('none');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await page.evaluate(() => getComputedStyle(document.querySelector('.dot.live')!).animationName);
  expect(reduced).toBe('none');
});

test('M05 kind 左边条色随块类别（--k-*，prototype L49/L256）', async ({ page }) => {
  await mount(page);
  const borders = await page.evaluate(() => {
    const pick = (id: string) => (document.querySelector(`.block[data-b=${id}]`) as HTMLElement).style.borderLeftColor;
    return { r: pick('r'), c: pick('c'), s: pick('s') };
  });
  expect(borders.r).toBeTruthy();
  expect(borders.c).toBeTruthy();
  expect(borders.r).not.toBe(borders.c);
});

test('M05 点击选中回调 + 选中态 .sel（prototype L345）', async ({ page }) => {
  await mount(page, { sel: 'r' });
  await expect(page.locator('.block[data-b=r]')).toHaveClass(/sel/);
  await page.locator('.block[data-b=c]').click();
  const calls = await page.evaluate(() => window.__calls);
  expect(calls).toEqual([['select', 'c']]);
});

test('M05 update：切块/改状态不整绘（增量约束，PRD §5.2 末教训）', async ({ page }) => {
  await mount(page, { sel: 'r' });
  await page.evaluate(() => {
    document.querySelector('.block[data-b=r]')!.setAttribute('data-marker', 'keep');
    window.__update({ ...window.__defaults('block-card')!, sel: 'c', status: { r: 'live' } });
  });
  await expect(page.locator('.block[data-b=c]')).toHaveClass(/sel/);
  await expect(page.locator('.block[data-b=r] .dot.live')).toHaveCount(1);
  expect(await page.getAttribute('.block[data-b=r]', 'data-marker')).toBe('keep');
});
