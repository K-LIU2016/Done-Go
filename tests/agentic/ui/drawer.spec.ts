// M06 块抽屉壳 组件页测试（RED 先行）
// 契约：drawer.js mount(el, { blockId, stage, onClose }) → handle { update(props), showTab(name) }
//   DOM（prototype L199/L210-218/L533-536）：nav.stepper 4 阶段 + div.tabs[role=tablist] 5 标签 + 五 section 显隐
import { test, expect } from '@playwright/test';

async function mount(page: import('@playwright/test').Page, extra: Record<string, unknown> = {}) {
  await page.goto('/component.html?c=drawer');
  await page.evaluate((patch) => {
    window.__calls = [];
    const props = { ...window.__defaults('drawer')!, ...patch } as Record<string, unknown>;
    props.onClose = () => window.__calls!.push(['close']);
    window.__mount('drawer', props);
  }, extra);
}

const TABS = ['preview', 'bound', 'live', 'art', 'trace'];

test('M06 五标签 role=tablist + aria-selected（prototype L211-212）', async ({ page }) => {
  await mount(page);
  const tabs = page.locator('[role=tablist] [role=tab], .tabs button');
  await expect(tabs).toHaveCount(5);
  for (const t of TABS) await expect(page.locator(`.tabs button[data-tab=${t}]`)).toBeVisible();
  await expect(page.locator('.tabs button[data-tab=preview]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.tabs button[data-tab=bound]')).toHaveAttribute('aria-selected', 'false');
});

test('M06 五 section 只显示当前标签（.hidden 切换，prototype L533-536）', async ({ page }) => {
  await mount(page);
  await expect(page.locator('#tab-preview, section[data-tab=preview]')).toBeVisible();
  for (const t of ['bound', 'live', 'art', 'trace']) {
    await expect(page.locator(`#tab-${t}, section[data-tab=${t}]`)).toBeHidden();
  }
  await page.locator('.tabs button[data-tab=trace]').click();
  await expect(page.locator('#tab-trace, section[data-tab=trace]')).toBeVisible();
  await expect(page.locator('#tab-preview, section[data-tab=preview]')).toBeHidden();
});

test('M06 键盘左右切换标签（tablist 方向键，DAG M06）', async ({ page }) => {
  await mount(page);
  const first = page.locator('.tabs button[data-tab=preview]');
  await first.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.tabs button[data-tab=bound]')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.tabs button[data-tab=live]')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.tabs button[data-tab=bound]')).toHaveAttribute('aria-selected', 'true');
});

test('M06 阶段条 ①说②看③定④交 on/done 状态（prototype L199/L331-337）', async ({ page }) => {
  await mount(page, { stage: 'sign' });
  await expect(page.locator('.stepper [data-s=see]')).toHaveClass(/done/);
  await expect(page.locator('.stepper [data-s=sign]')).toHaveClass(/on/);
  await expect(page.locator('.stepper [data-s=run]')).not.toHaveClass(/done|on/);
  await page.evaluate(() => window.__update({ ...window.__defaults('drawer')!, stage: 'run' }));
  await expect(page.locator('.stepper [data-s=sign]')).toHaveClass(/done/);
  await expect(page.locator('.stepper [data-s=run]')).toHaveClass(/on/);
});

test('M06 update 切块不重建面板 DOM（增量约束，DAG M06）', async ({ page }) => {
  await mount(page, { blockId: 'r' });
  await page.evaluate(() => {
    const panel = document.querySelector('#tab-preview, section[data-tab=preview]')!;
    panel.setAttribute('data-marker', 'keep');
    window.__update({ ...window.__defaults('drawer')!, blockId: 'c' });
  });
  expect(await page.getAttribute('#tab-preview, section[data-tab=preview]', 'data-marker')).toBe('keep');
});

test('M06 移动端（≤720px）底部抽屉 + Esc 关闭（PRD §5.8，DAG M06）', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1280) > 720, 'mobile-only');
  await mount(page, { blockId: 'r' });
  const box = await page.locator('#host > *').first().boundingBox();
  expect(box).toBeTruthy();
  expect(box!.y).toBeGreaterThan(page.viewportSize()!.height * 0.3, '移动端抽屉应贴底（底部抽屉）');
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.__calls)).toEqual([['close']]);
});
