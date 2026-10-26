// M16 「📷 拍一下」入口 + 建议卡（快→深升级）组件页测试（RED 先行）
// 契约：capture-card.js mount(el, { card, onCapture, onAction }) → handle.update({ card })
//   入行（prototype L391）：「现场感知」+ 📷 拍一下按钮
//   card（props 对齐 PRD §6.8.2 ContextDelta 形状）：
//     { phase: 'quick'|'deep', blockId, seen, change?, risk?, suggestion?, evidence: {imageRef}, model, ms }
//   快卡 .capcard（prototype L386-390）：.lv「即时 · <model> <ms> · 深度分析中…」+ seen
//   深卡 .capcard.deep：.lv「已升级 · <model> <ms>」+ change + 建议 + 三动作（⏱ 提醒 / 步骤卡跳步 / 记下来）
import { test, expect } from '@playwright/test';

const QUICK = {
  phase: 'quick', blockId: 'b', seen: '正在按说明书组装书架，胶水和螺丝已就位。',
  evidence: { imageRef: 'assets/photo-craft.jpg' }, model: 'qwen3.5-omni-flash', ms: '1.5s',
};
const DEEP = {
  phase: 'deep', blockId: 'b',
  seen: '正在按说明书组装书架，胶水和螺丝已就位。',
  change: '隔板已上胶，但胶水溢出、没用夹具固定，可能会不平。',
  risk: '隔板不平会影响成品',
  suggestion: '用湿布擦掉多余胶水 → 直尺检查水平 → 夹子固定 15 分钟再拧螺丝。',
  evidence: { imageRef: 'assets/photo-craft.jpg' }, model: 'qwen3-vl-plus', ms: '6.0s',
};

async function mount(page: import('@playwright/test').Page, card: Record<string, unknown> | null = QUICK) {
  await page.goto('/component.html?c=capture-card');
  await page.evaluate((c) => {
    window.__calls = [];
    const props = { card: c } as Record<string, unknown>;
    props.onCapture = () => window.__calls!.push(['capture']);
    props.onAction = (act: string) => window.__calls!.push(['action', act]);
    window.__mount('capture-card', props);
  }, card);
}

test('M16 入口行：现场感知 + 📷 拍一下按钮（prototype L391）', async ({ page }) => {
  await mount(page, null);
  await expect(page.locator('#host')).toContainText('现场感知');
  const btn = page.locator('button:has-text("拍一下")');
  await expect(btn).toBeVisible();
  await btn.click();
  expect(await page.evaluate(() => window.__calls)).toEqual([['capture']]);
});

test('M16 快卡：即时一句话 seen + 深度分析中提示（prototype L386-388）', async ({ page }) => {
  await mount(page);
  await expect(page.locator('.capcard')).toHaveCount(1);
  await expect(page.locator('.capcard')).not.toHaveClass(/deep/);
  await expect(page.locator('.capcard .lv')).toContainText('即时 · qwen3.5-omni-flash 1.5s');
  await expect(page.locator('.capcard .lv')).toContainText('深度分析中');
  await expect(page.locator('.capcard')).toContainText('正在按说明书组装书架');
});

test('M16 快卡缩略图来自 ui/assets/ 白名单', async ({ page }) => {
  await mount(page);
  await expect(page.locator('.capcard img')).toHaveAttribute('src', 'assets/photo-craft.jpg');
});

test('M16 快卡 aria-live=polite（升级可被播报，DAG M16）', async ({ page }) => {
  await mount(page);
  expect(await page.getAttribute('.capcard', 'aria-live')).toBe('polite');
});

test('M16 深卡：已升级态 + change + 建议 + 三动作（prototype L388-389）', async ({ page }) => {
  await mount(page, DEEP);
  await expect(page.locator('.capcard')).toHaveClass(/deep/);
  await expect(page.locator('.capcard .lv')).toContainText('已升级 · qwen3-vl-plus 6.0s');
  await expect(page.locator('.capcard')).toContainText('胶水溢出');
  await expect(page.locator('.capcard')).toContainText('夹子固定 15 分钟');
  const acts = page.locator('.capcard .acts button');
  await expect(acts).toHaveCount(3);
});

test('M16 三动作回调 onAction(timer|step|note) + ✓ 反馈（prototype L626）', async ({ page }) => {
  await mount(page, DEEP);
  await page.locator('.capcard .acts button').first().click();  // ⏱ 提醒
  await page.locator('.capcard .acts button').nth(1).click();   // 步骤卡跳步
  await page.locator('.capcard .acts button').nth(2).click();   // 记下来
  expect(await page.evaluate(() => window.__calls)).toEqual([
    ['action', 'timer'], ['action', 'step'], ['action', 'note'],
  ]);
  await expect(page.locator('#capNote, .cap-note')).toContainText('✓');
});

test('M16 快→深同卡原地升级不重建（DAG M16「同卡原地升级」）', async ({ page }) => {
  await mount(page, QUICK);
  await page.evaluate((quick) => {
    document.querySelector('.capcard')!.setAttribute('data-marker', 'keep');
    window.__update({ card: JSON.parse(JSON.stringify(quick)) }); // 同内容 update：节点保留
  }, QUICK);
  expect(await page.getAttribute('.capcard', 'data-marker')).toBe('keep');
  await page.evaluate((deep) => window.__update({ card: deep }), DEEP);
  expect(await page.getAttribute('.capcard', 'data-marker')).toBe('keep', '升级必须原卡换态');
  await expect(page.locator('.capcard')).toHaveClass(/deep/);
});

test('M16 ≤560px 单列布局（prototype L184）', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1280) > 560, 'mobile-only');
  await mount(page, DEEP);
  const cols = await page.evaluate(() => getComputedStyle(document.querySelector('.capcard')!).gridTemplateColumns.split(' ').length);
  expect(cols).toBe(1);
});
