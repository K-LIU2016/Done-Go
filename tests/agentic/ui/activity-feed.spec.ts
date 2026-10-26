// M12 活动流（可展开「为什么」）组件页测试（RED 先行）
// 契约：activity-feed.js mount(el, { signed, cost, items }) → handle.update
//   DOM（prototype L117-124/L471-477）：.cost 行 + .feed > .it（time+icon+text，why 用 details）
//   items: {t, icon, text, why?}[]（按时间正序给入，渲染最新在前）
import { test, expect } from '@playwright/test';

const COST = { agents: '研究员 ×3 · 写作者 · 校对员', calls: 24, status: '进行中' };
const ITEMS = [
  { t: '13:30', icon: '🔎', text: '研究员 ×3 开始检索', why: '合同允许提前 30 分钟准备；三路并行去重后合并' },
  { t: '13:44', icon: '🗂', text: '找到 23 个来源，保留 9 个', why: '规则：2024 年以前的政策文件仅作背景' },
  { t: '14:05', icon: '✍️', text: '写作者开始合成第 1–5 节' },
];

async function mount(page: import('@playwright/test').Page, extra: Record<string, unknown> = {}) {
  await page.goto('/component.html?c=activity-feed');
  // COST/ITEMS 必须经 evaluate 入参进入页面上下文（Node 常量不会随闭包序列化）
  await page.evaluate(([patch, cost, items]) => {
    const props = { signed: true, cost, items, ...patch } as Record<string, unknown>;
    window.__mount('activity-feed', props);
  }, [extra, COST, ITEMS] as const);
}

test('M12 未签约空态文案（prototype L474）', async ({ page }) => {
  await mount(page, { signed: false });
  await expect(page.locator('#host')).toContainText('签约后');
});

test('M12 cost 行：agent 组成 / 调用数 / 状态（prototype L475）', async ({ page }) => {
  await mount(page);
  const cost = page.locator('.cost');
  await expect(cost).toContainText('研究员 ×3 · 写作者 · 校对员');
  await expect(cost).toContainText('24');
  await expect(cost).toContainText('进行中');
});

test('M12 条目倒序渲染、最新条带 .new（prototype L476）', async ({ page }) => {
  await mount(page);
  await expect(page.locator('.feed .it')).toHaveCount(3);
  const times = await page.locator('.feed .it time').allTextContents();
  expect(times).toEqual(['14:05', '13:44', '13:30']);
  await expect(page.locator('.feed .it').first()).toHaveClass(/new/);
  expect(await page.locator('.feed .it.new').count()).toBe(1);
});

test('M12 「为什么」用 details 原生展开（prototype L121）', async ({ page }) => {
  await mount(page);
  // 倒序渲染下首个带 details 的是 13:44 行（why=规则…）；断言文案属于 13:30 行 → 取 .last()
  const why = page.locator('.feed .it details').last();
  await expect(why.locator('.why')).toBeHidden();
  await why.locator('summary').click();
  await expect(why.locator('.why')).toBeVisible();
  await expect(why.locator('.why')).toContainText('合同允许提前 30 分钟准备');
});

test('M12 追加新条目：旧行不重排、.new 转移（增量约束，DAG M12）', async ({ page }) => {
  await mount(page);
  await page.evaluate((cost) => {
    document.querySelectorAll('.feed .it')[2].setAttribute('data-marker', 'keep'); // 最旧一条
    window.__update({
      signed: true, cost,
      items: [...[
        { t: '13:30', icon: '🔎', text: '研究员 ×3 开始检索', why: '合同允许提前 30 分钟准备' },
        { t: '13:44', icon: '🗂', text: '找到 23 个来源，保留 9 个' },
        { t: '14:05', icon: '✍️', text: '写作者开始合成第 1–5 节' },
      ], { t: '14:30', icon: '🧪', text: '校对员核验引用', why: '验证与写作使用不同模型' }],
    });
  }, COST);
  await expect(page.locator('.feed .it')).toHaveCount(4);
  await expect(page.locator('.feed .it time').first()).toHaveText('14:30');
  expect(await page.locator('.feed .it.new').count()).toBe(1);
  const lastTime = await page.locator('.feed .it').last().locator('time').textContent();
  expect(lastTime).toBe('13:30');
  expect(await page.getAttribute('.feed .it:last-child', 'data-marker')).toBe('keep');
});

test('M12 reduced-motion：新条目无 rise 动画（prototype L119/L185）', async ({ page }) => {
  await mount(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const anim = await page.evaluate(() => getComputedStyle(document.querySelector('.feed .it.new')!).animationName);
  expect(anim).toBe('none');
});
