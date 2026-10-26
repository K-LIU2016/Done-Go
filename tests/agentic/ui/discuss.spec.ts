// M10 讨论框 + 差异高亮 组件页测试（RED 先行）
// 契约：discuss.js mount(el, { examples, note, onSay }) → handle.update
//   DOM（prototype L96-98/L409-412/L452-459/L648）：.discuss > 例句 chips + 输入行(#sayInput + 改) + #patchNote[aria-live=polite]
//   note = { utterance, summary } → patchNote 渲染「已按「…」更新」+ .add/.del/.chg 摘要
import { test, expect } from '@playwright/test';

const EXAMPLES = ['研究只看国内 K12', '课程是给初中老师的 4 课时工作坊'];
const NOTE = {
  utterance: '研究只看国内 K12',
  summary: '新增 课堂实践 / 教师准备度；删除 海外案例；变更 来源范围仅国内（2.4 秒）',
};

async function mount(page: import('@playwright/test').Page, extra: Record<string, unknown> = {}) {
  await page.goto('/component.html?c=discuss');
  await page.evaluate((patch) => {
    window.__calls = [];
    const props = { examples: EXAMPLES, ...patch } as Record<string, unknown>;
    props.onSay = (text: string) => window.__calls!.push(['say', text]);
    window.__mount('discuss', props);
  }, extra);
}

test('M10 例句 chips 渲染且点击触发 onSay（prototype L410）', async ({ page }) => {
  await mount(page);
  await expect(page.locator('.discuss .chip')).toHaveCount(2);
  await page.locator('.discuss .chip').first().click();
  expect(await page.evaluate(() => window.__calls)).toEqual([['say', '研究只看国内 K12']]);
});

test('M10 输入行 Enter 提交 + 「改」按钮提交（prototype L648/L629）', async ({ page }) => {
  await mount(page);
  await page.locator('#sayInput').fill('别读我的邮箱');
  await page.locator('#sayInput').press('Enter');
  await page.locator('#sayBtn').click(); // 第二次提交（按钮路径）
  expect(await page.evaluate(() => window.__calls)).toEqual([['say', '别读我的邮箱'], ['say', '别读我的邮箱']]);
});

test('M10 空输入（含纯空白）忽略，不触发 onSay（DAG M10）', async ({ page }) => {
  await mount(page);
  await page.locator('#sayInput').fill('   ');
  await page.locator('#sayInput').press('Enter');
  await page.locator('#sayBtn').click();
  expect(await page.evaluate(() => window.__calls)).toEqual([]);
});

test('M10 patchNote：已按「…」更新 + add/del/chg 高亮 + aria-live=polite（prototype L458）', async ({ page }) => {
  await mount(page);
  await page.evaluate((note) => window.__update({ note }), NOTE);
  const noteEl = page.locator('#patchNote, .patch-note');
  await expect(noteEl).toHaveAttribute('aria-live', 'polite');
  await expect(noteEl).toContainText('已按「研究只看国内 K12」更新');
  await expect(noteEl.locator('.add')).toContainText('新增');
  await expect(noteEl.locator('.del')).toContainText('删除');
  await expect(noteEl.locator('.chg')).toContainText('变更');
});

test('M10 patchNote 转义用户输入（XSS 基线）', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => {
    window.__update({ note: { utterance: '<img src=x onerror=1>', summary: '新增 A' } });
  });
  expect(await page.evaluate(() => document.querySelectorAll('.discuss img').length)).toBe(0);
  const txt = await page.evaluate(() => document.querySelector('#patchNote, .patch-note')!.textContent);
  expect(txt).toContain('<img src=x onerror=1>');
});

test('M10 更新 patchNote 后输入框不丢焦点（PRD §5.2 末教训）', async ({ page }) => {
  await mount(page);
  await page.locator('#sayInput').focus();
  await page.evaluate((note) => window.__update({ note }), NOTE);
  const focused = await page.evaluate(() => document.activeElement?.id);
  expect(focused).toBe('sayInput');
});
