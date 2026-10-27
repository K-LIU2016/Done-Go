// M15 交付台泳道 组件页测试（RED 先行）
// 契约：board.js mount(el, { blocks, segs, now, running, paused, speed, simState, onPauseAll, onSpeed }) → handle.update
//   DOM（prototype L107-116/L222-231/L507-513）：toolbar(全部暂停/速度/simState) + .axis 刻度 + .lanes > .lane(.name + .track)
//   segs：{ b, s, e, c, text }[]（c ∈ r/w/v/u/d/g）；now 分钟数（13:00=780 … 19:00=1140）
import { test, expect } from '@playwright/test';

const BLOCKS = [
  { id: 'r', start: '14:00', end: '15:00', title: 'AI 教育的深度研究' },
  { id: 'c', start: '15:00', end: '17:00', title: '课程设计' },
];
const SEGS = [
  { b: 'r', s: '13:30', e: '14:05', c: 'r', text: '检索 ×3' },
  { b: 'r', s: '14:05', e: '14:40', c: 'w', text: '写作 第 1–5 节' },
  { b: 'c', s: '15:00', e: '15:25', c: 'g', text: '规划 4 课时' },
];

async function mount(page: import('@playwright/test').Page, extra: Record<string, unknown> = {}) {
  await page.goto('/component.html?c=board');
  // BLOCKS/SEGS 必须经 evaluate 入参进入页面上下文（Node 常量不会随闭包序列化）
  await page.evaluate(([patch, blocks, segs]) => {
    window.__calls = [];
    const props = {
      blocks, segs, now: 840, running: true, paused: false, speed: 1,
      simState: '执行中（模拟时钟）', ...patch,
    } as Record<string, unknown>;
    props.onPauseAll = () => window.__calls!.push(['pauseAll']);
    props.onSpeed = () => window.__calls!.push(['speed']);
    window.__mount('board', props);
  }, [extra, BLOCKS, SEGS] as const);
}

test('M15 每块一条泳道：name + track（prototype L509）', async ({ page }) => {
  await mount(page);
  await expect(page.locator('.lane')).toHaveCount(2);
  await expect(page.locator('.lane .name').first()).toContainText('AI 教育的深度研究');
  await expect(page.locator('.lane .track').first()).toBeAttached();
});

test('M15 seg 色类 r/w/v/u/d/g + 时间窗虚线框 + 刻度 13:00–19:00（prototype L113/L229）', async ({ page }) => {
  await mount(page);
  await expect(page.locator('.seg.r')).toHaveCount(1);
  await expect(page.locator('.seg.w')).toHaveCount(1);
  await expect(page.locator('.seg.g')).toHaveCount(1);
  await expect(page.locator('.seg').first()).toContainText('检索 ×3');
  const dashed = await page.evaluate(() => {
    const win = Array.from(document.querySelectorAll('.lane .track > div')).find((el) => getComputedStyle(el).borderLeftStyle === 'dashed');
    return win ? getComputedStyle(win).borderLeftStyle : null;
  });
  expect(dashed).toBe('dashed');
  const ticks = await page.locator('.axis span, .axis div:last-child span').allTextContents();
  expect(ticks.filter((t) => /^\d{2}:\d{2}$/.test(t))).toEqual(['13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00']);
});

test('M15 nowline 当前时刻竖线随 now 定位（prototype L114）', async ({ page }) => {
  await mount(page, { now: 840 }); // 14:00 = (840-780)/360 = 16.67%
  const left = await page.evaluate(() => parseFloat((document.querySelector('.nowline') as HTMLElement).style.left));
  expect(left).toBeGreaterThan(15);
  expect(left).toBeLessThan(19);
});

test('M15 toolbar：全部暂停（未运行禁用/暂停态文案「继续」）+ 速度 ×1×4 + simState（prototype L227-230）', async ({ page }) => {
  await mount(page, { running: false });
  await expect(page.locator('button:has-text("全部暂停")')).toBeDisabled();
  await mount(page, { running: true, paused: true });
  await expect(page.locator('button.danger')).toContainText('继续');
  await page.locator('button.danger').click();
  await page.locator('button:has-text("速度")').click();
  expect(await page.evaluate(() => window.__calls)).toEqual([['pauseAll'], ['speed']]);
  await expect(page.locator('#simState, .simState')).toContainText('执行中');
});

test('M15 update 只挪样式不重建行（50 块 60fps 约束，DAG M15）', async ({ page }) => {
  await mount(page);
  await page.evaluate(([blocks, segs]) => {
    document.querySelector('.lane .track .seg')!.setAttribute('data-marker', 'keep');
    document.querySelector('.nowline')!.setAttribute('data-marker', 'nl');
    window.__update({ blocks, segs, now: 900, running: true, paused: false, speed: 1, simState: '执行中' });
  }, [BLOCKS, SEGS] as const);
  expect(await page.getAttribute('.lane .track .seg', 'data-marker')).toBe('keep');
  expect(await page.getAttribute('.nowline', 'data-marker')).toBe('nl');
  const left = await page.evaluate(() => parseFloat((document.querySelector('.nowline') as HTMLElement).style.left));
  expect(left).toBeGreaterThan(32); // 15:00 → 33.33%
  expect(left).toBeLessThan(34);
});

test('M15 ≤560px 纵向时间线降级：泳道单列（PRD §5.8，DAG M15）', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1280) > 560, 'mobile-only');
  await mount(page);
  const cols = await page.evaluate(() => getComputedStyle(document.querySelector('.lane')!).gridTemplateColumns.split(' ').length);
  expect(cols).toBe(1);
});
