// M11 边界卡与签约 组件页测试（RED 先行）
// 契约：boundaries.js mount(el, { boundary, sysWont, signed, hash, blockCount, onSign, onRevoke }) → handle.update
//   DOM（prototype L99-106/L296-303/L461-469）：.bound 四 section + .sign 签约区 + 打扰策略脚注
import { test, expect } from '@playwright/test';

const BOUNDARY = {
  will: ['检索公开网页与论文', '写约 3000 字研究报告'],
  wont: ['不发给任何人', '不访问你的邮箱与聊天'],
  needs: ['14:00 前确认目标受众（30 秒）'],
  budget: ['约 40 次模型调用', '全部免费模型 / 本地模型'],
};
const SYS_WONT = '系统禁止：付款下单 · 以你名义发送（除非逐次确认）· 读取凭据 · 删除文件';

async function mount(page: import('@playwright/test').Page, extra: Record<string, unknown> = {}) {
  await page.goto('/component.html?c=boundaries');
  await page.evaluate((patch) => {
    window.__calls = [];
    const props = {
      boundary: BOUNDARY, sysWont: SYS_WONT, signed: false, hash: '', blockCount: 4, ...patch,
    } as Record<string, unknown>;
    props.onSign = () => window.__calls!.push(['sign']);
    props.onRevoke = () => window.__calls!.push(['revoke']);
    window.__mount('boundaries', props);
  }, extra);
}

test('M11 四栏：我会做 / 我不会做 / 需要你 / 花费与上限（prototype L464-465）', async ({ page }) => {
  await mount(page);
  const heads = await page.locator('.bound section h3').allTextContents();
  expect(heads).toEqual(['我会做', '我不会做', '需要你', '花费与上限']);
  await expect(page.locator('.bound section').first()).toContainText('检索公开网页与论文');
  await expect(page.locator('.bound section').nth(3)).toContainText('约 40 次模型调用');
});

test('M11 SYS_WONT 系统默认禁止项在「我不会做」栏且带 .sys 样式、不可被合同覆盖（PRD §8.1）', async ({ page }) => {
  await mount(page, { boundary: { ...BOUNDARY, wont: [] } }); // 即使合同 wont 为空也必须显示
  const sys = page.locator('.bound section:nth-child(2) .sys');
  await expect(sys).toHaveCount(1);
  await expect(sys).toHaveText(SYS_WONT);
});

test('M11 未签约：主按钮文案含块数、点击 onSign（prototype L467）', async ({ page }) => {
  await mount(page, { blockCount: 4 });
  const btn = page.locator('.sign button.primary');
  await expect(btn).toContainText('就这么办');
  await expect(btn).toContainText('4 个块');
  await expect(page.locator('.sign')).toContainText('签的是这份合同本身');
  await btn.click();
  expect(await page.evaluate(() => window.__calls)).toEqual([['sign']]);
});

test('M11 已签约态：已签约 chip + sha256 hash 等宽 + 撤回（prototype L466）', async ({ page }) => {
  await mount(page, { signed: true, hash: 'sha256:a1b2c3d4e5f6…' });
  await expect(page.locator('.sign .chip.hi')).toContainText('已签约');
  await expect(page.locator('.sign .hash')).toContainText('sha256:a1b2c3d4e5f6');
  const mono = await page.evaluate(() => getComputedStyle(document.querySelector('.sign .hash')!).fontFamily);
  expect(mono.toLowerCase()).toContain('mono');
  await page.locator('.sign button.danger').click();
  expect(await page.evaluate(() => window.__calls)).toEqual([['revoke']]);
});

test('M11 打扰策略脚注（prototype L468）', async ({ page }) => {
  await mount(page);
  await expect(page.locator('#host')).toContainText('打扰策略');
});

test('M11 ≤720px 四栏转 2×2（prototype L100，PRD §5.8 移动端）', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1280) > 720, 'mobile-only');
  await mount(page);
  const cols = await page.evaluate(() => getComputedStyle(document.querySelector('.bound')!).gridTemplateColumns.split(' ').length);
  expect(cols).toBe(2);
});
