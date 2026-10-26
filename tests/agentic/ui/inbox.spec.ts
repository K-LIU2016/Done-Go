// M14 「需要你」收件箱 组件页测试（RED 先行）
// 契约：inbox.js
//   mount(el, { needs, blocks, onAnswer, onClose }) → handle.update  // 面板（prototype L236-239/L515-523）
//   mountBell(el, { count, onToggle }) → handle.update              // 顶栏铃铛 + 计数徽标（prototype L195/L517）
//   need：{ id, title, body, opts, due, def, b, done }（done 非空 = 已处理/超时默认）
import { test, expect } from '@playwright/test';

const BLOCKS = [
  { id: 'r', title: 'AI 教育的深度研究' },
  { id: 'c', title: '课程设计' },
];
const NEEDS = [
  { id: 'n1', title: '确认研究受众', body: '我按"国内 K12 · 初中教师"来写，对吗？', opts: ['对', '改成高中'], due: '14:00', def: '按"对"继续', b: 'r', done: '' },
  { id: 'n2', title: '大纲方向', body: 'A：偏实操；B：偏系统', opts: ['A', 'B'], due: '15:45', def: '按 A 继续', b: 'c', done: '' },
];

async function mountInbox(page: import('@playwright/test').Page, needs = NEEDS) {
  await page.goto('/component.html?c=inbox');
  await page.evaluate((n) => {
    window.__calls = [];
    const props = { needs: n, blocks: BLOCKS } as Record<string, unknown>;
    props.onAnswer = (id: string, value: string) => window.__calls!.push(['answer', id, value]);
    props.onClose = () => window.__calls!.push(['close']);
    window.__mount('inbox', props);
  }, needs);
}

test('M14 need 卡：标题/正文/所属块/截止/超时默认（PRD §5.5 规则）', async ({ page }) => {
  await mountInbox(page);
  await expect(page.locator('.need').first()).toContainText('确认研究受众');
  const meta = await page.locator('.need').first().locator('.meta').textContent();
  expect(meta).toContain('AI 教育的深度研究');
  expect(meta).toContain('截止 14:00');
  expect(meta).toContain('超时：按"对"继续');
});

test('M14 选项按钮组作答 → onAnswer(needId, value)（prototype L640）', async ({ page }) => {
  await mountInbox(page);
  await page.locator('.need button[data-ans=n1], .need').first().locator('button', { hasText: '对' }).click();
  expect(await page.evaluate(() => window.__calls)).toEqual([['answer', 'n1', '对']]);
});

test('M14 已处理：降透明 + 「已处理：」、无按钮（prototype L519-521）', async ({ page }) => {
  await mountInbox(page, [{ ...NEEDS[0], done: '你选了「对」' }]);
  const card = page.locator('.need').first();
  await expect(card).toContainText('已处理：你选了「对」');
  expect(await card.locator('.acts button').count()).toBe(0);
  const opacity = await page.evaluate(() => getComputedStyle(document.querySelector('.need')!).opacity);
  expect(parseFloat(opacity)).toBeLessThan(1);
});

test('M14 超时默认态：done 以「超时 · 」开头（prototype L607）', async ({ page }) => {
  await mountInbox(page, [{ ...NEEDS[1], done: '超时 · 按 A 继续' }]);
  await expect(page.locator('.need').first()).toContainText('已处理：超时 · 按 A 继续');
});

test('M14 空态文案 + 关闭按钮 + Esc（prototype L238/L644）', async ({ page }) => {
  await mountInbox(page, []);
  await expect(page.locator('#host')).toContainText('现在没有需要你处理的事');
  await page.locator('button:has-text("关闭")').click();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.__calls)).toEqual([['close'], ['close']]);
});

test('M14 铃铛：未决计数徽标，0 时隐藏，点击 onToggle（prototype L38/L517）', async ({ page }) => {
  await page.goto('/component.html?c=inbox-bell');
  const out = await page.evaluate(() => {
    window.__calls = [];
    const handle = window.__mount('inbox-bell', {
      count: 2,
      onToggle: () => window.__calls!.push(['toggle']),
    }) as { update(p: Record<string, unknown>): void };
    const badge = () => document.querySelector('#host b') as HTMLElement;
    const state1 = { count: badge().textContent, hidden: badge().classList.contains('hidden') };
    handle.update({ count: 0 });
    const state2 = { hidden: badge().classList.contains('hidden') };
    (document.querySelector('#host button') as HTMLElement).click();
    return { state1, state2, calls: window.__calls };
  });
  expect(out.state1.count).toBe('2');
  expect(out.state1.hidden).toBe(false);
  expect(out.state2.hidden).toBe(true);
  expect(out.calls).toEqual([['toggle']]);
});

test('M14 面板 aria-label=需要你（prototype L236）', async ({ page }) => {
  await mountInbox(page);
  const label = await page.evaluate(() => document.querySelector('.inbox')?.getAttribute('aria-label'));
  expect(label).toBe('需要你');
});
