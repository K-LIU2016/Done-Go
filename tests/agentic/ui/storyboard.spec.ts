// M09 分镜轴 + 旁白控件 组件页测试（RED 先行）
// 契约：storyboard.js mount(el, { events, lines, map }) → handle { update({litIdx}), setLine(i) }
//   DOM（prototype L86-95/L415-450）：.story > .rail(.ev 两行交错 + .head 播放头) + .narr(▶ 听旁白 + .subtitle)
//   events: [at, icon, text, you?][]；map[i]：字幕行 i → 点亮事件索引（prototype L437）
import { test, expect } from '@playwright/test';

const EVENTS = [
  ['13:30', '🔎', '研究员先找资料'],
  ['13:55', '✋', '你确认受众', true],
  ['14:30', '🧪', '核验引用'],
  ['14:52', '📦', '研究交付'],
  ['15:00', '🧭', '课程接力'],
  ['15:28', '✋', '你选大纲方向', true],
] as unknown as [string, string, string, boolean?][];

const LINES = [
  '下午一点半，我先派三个研究员分头找资料。',
  '两点前需要你确认一下受众，三十秒就好。',
  '两点半我会让另一个模型逐条核对引用。',
  '三点开始做课程设计，直接用研究结论。',
  '三点半我会请你在两个大纲方向里选一个。',
  '五点前交付课程方案。',
];
const MAP = [0, 1, 2, 4, 5, 5];

async function mount(page: import('@playwright/test').Page) {
  await page.goto('/component.html?c=storyboard');
  await page.evaluate(([ev, lines, map]) => {
    window.__mount('storyboard', { events: ev, lines, map });
  }, [EVENTS, LINES, MAP] as unknown as [unknown, unknown, unknown]);
}

test('M09 rail：事件节点齐全，you 触点高亮类（prototype L424/L90）', async ({ page }) => {
  await mount(page);
  await expect(page.locator('.rail .ev')).toHaveCount(6);
  await expect(page.locator('.rail .ev.you')).toHaveCount(2);
  await expect(page.locator('.rail .ev').first()).toContainText('研究员先找资料');
});

test('M09 rail：左右 clampX 8–92% + 两行交错（prototype L421-424）', async ({ page }) => {
  await mount(page);
  const geo = await page.evaluate(() => Array.from(document.querySelectorAll('.rail .ev')).map((el) => ({
    left: parseFloat((el as HTMLElement).style.left),
    top: parseFloat((el as HTMLElement).style.top),
  })));
  expect(geo.length).toBe(6);
  for (const g of geo) {
    expect(g.left).toBeGreaterThanOrEqual(8);
    expect(g.left).toBeLessThanOrEqual(92);
  }
  expect(geo[0].top).not.toBe(geo[1].top, '相邻事件交错两行');
  expect(new Set(geo.map((g) => g.top)).size).toBe(2);
});

test('M09 播放头 .head 存在且随点亮事件移动（prototype L92/L424）', async ({ page }) => {
  await mount(page);
  await expect(page.locator('.rail .head')).toBeAttached();
  const left0 = await page.evaluate(() => (document.querySelector('.rail .head') as HTMLElement).style.left);
  await page.evaluate(() => (window.__handle as unknown as { setLine(i: number): void }).setLine(1));
  const left1 = await page.evaluate(() => (document.querySelector('.rail .head') as HTMLElement).style.left);
  expect(left0).toBeTruthy();
  expect(left1).toBeTruthy();
  expect(left1).not.toBe(left0);
});

test('M09 setLine：字幕=lines[i]、map[i] 事件点亮 .lit（prototype L437/L442）', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => (window.__handle as unknown as { setLine(i: number): void }).setLine(3));
  await expect(page.locator('.subtitle')).toHaveText(LINES[3]);
  await expect(page.locator('.rail .ev.lit')).toHaveCount(1);
  const litIndex = await page.evaluate(() => Array.from(document.querySelectorAll('.rail .ev')).findIndex((el) => el.classList.contains('lit')));
  expect(litIndex).toBe(MAP[3]);
});

test('M09 setLine 只动 class/字幕，不重建 rail（增量约束，DAG M09）', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => {
    document.querySelectorAll('.rail .ev')[2].setAttribute('data-marker', 'keep');
    (window.__handle as unknown as { setLine(i: number): void }).setLine(4);
  });
  expect(await page.getAttribute('.rail .ev:nth-child(3)', 'data-marker')).toBe('keep');
  await expect(page.locator('.subtitle')).toHaveText(LINES[4]);
});

test('M09 update({litIdx}) 只切换点亮类、旧节点保留（DAG M09）', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => window.__update({ litIdx: 0 }));
  await expect(page.locator('.rail .ev.lit')).toHaveCount(1);
  await page.evaluate(() => {
    document.querySelector('.rail .ev.lit')!.setAttribute('data-marker', 'keep');
    window.__update({ litIdx: 3 });
  });
  await expect(page.locator('.rail .ev.lit')).toHaveCount(1);
  expect(await page.evaluate(() => document.querySelectorAll('.rail .ev[data-marker]').length)).toBe(1, '旧节点不得被重建');
});

test('M09 ▶ 听旁白：点击后字幕立即出第一句（prototype L435-449）', async ({ page }) => {
  await mount(page);
  const btnText = await page.locator('.narr button').textContent();
  expect(btnText).toContain('旁白');
  await page.locator('.narr button').click();
  await expect(page.locator('.subtitle')).toHaveText(LINES[0]);
});

test('M09 reduced-motion：节点过渡关停（prototype L185 全局降级）', async ({ page }) => {
  await mount(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const dur = await page.evaluate(() => getComputedStyle(document.querySelector('.rail .ev')!).transitionDuration);
  expect(parseFloat(dur)).toBe(0);
});
