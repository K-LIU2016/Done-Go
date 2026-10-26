// M19 a11y 规格（RED 先行 · 依赖 M18 demo.html；BUILD-PLAN §3 W5.3 硬性要求 + PRD §5.8）
// 覆盖（plan.md M19）：键盘走查（Tab/方向键/Enter/Esc）、焦点可见、aria-live 四处
// （subtitle / patchNote / capcard / needs）、reduced-motion 无动画、深色两路
// （[data-theme] + prefers-color-scheme）、拍一下快→深升级（原地）、reel Esc。
// 锚点来自已冻结组件实现：storyboard(.subtitle[aria-live])/discuss(#patchNote)/
// capture-card(.capcard[aria-live][role=status])/inbox(.needs[aria-live])/
// reel-player(.reel[role=dialog] .cap[aria-live])/drawer(.tabs roving)/boundaries/inbox bell。
import { test, expect, type Page, type Locator } from '@playwright/test';

const DEMO = '/demo.html';

async function openDemo(page: Page, query = '') {
  await page.goto(query ? `${DEMO}?${query}` : DEMO);
  await expect(page.locator('button.block[data-b="r"]')).toBeVisible({ timeout: 30_000 });
}

/** 从 body 起连按 Tab 直到 activeElement 命中 sel（键盘序列导航 → 触发 :focus-visible） */
async function tabTo(page: Page, sel: string, max = 40): Promise<Locator> {
  const target = page.locator(sel).first();
  for (let i = 0; i < max; i++) {
    const hit = await page.evaluate((s) => {
      const el = document.activeElement;
      return !!el && el.matches(s);
    }, sel);
    if (hit) return target;
    await page.keyboard.press('Tab');
  }
  throw new Error(`tabTo: 40 次 Tab 未到达 ${sel}`);
}

/** activeElement 的焦点描边（:focus-visible 命中时应非 none——UA 默认环或组件显式 outline） */
async function focusRing(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth };
  });
}

test('M19 a11y · 键盘走查：Tab 可达块卡，Enter 选中开抽屉（BUILD-PLAN §3 W5.3 键盘可达）', async ({ page }) => {
  await openDemo(page);
  const block = await tabTo(page, 'button.block[data-b="r"]');
  await expect(block).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.ag-drawer, [data-block="r"].ag-drawer').first()).toBeVisible();
  await expect(page.locator('.ag-drawer').first()).toHaveAttribute('data-block', 'r');
  await expect(page.locator('button.block[data-b="r"]')).toHaveClass(/sel/);
});

test('M19 a11y · tablist 方向键左右切换 + 焦点不逃出（prototype L533-536，roving tabindex）', async ({ page }) => {
  await openDemo(page);
  const firstTab = await tabTo(page, '.tabs button[data-tab=preview], [role=tab][data-tab=preview]');
  await expect(firstTab).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.tabs button[data-tab=bound], [role=tab][data-tab=bound]').first())
    .toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.tabs button[data-tab=live], [role=tab][data-tab=live]').first())
    .toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.tabs button[data-tab=bound], [role=tab][data-tab=bound]').first())
    .toHaveAttribute('aria-selected', 'true');
  // 焦点仍在 tablist 内（roving）
  const inTablist = await page.evaluate(() => {
    const el = document.activeElement;
    return !!el && !!el.closest('.tabs, [role=tablist]');
  });
  expect(inTablist).toBe(true);
});

test('M19 a11y · 讨论输入 Enter 提交（prototype L648：Enter=applySay）', async ({ page }) => {
  await openDemo(page);
  const input = page.locator('#sayInput, input[aria-label=讨论]').first();
  await input.click();
  await input.fill('课程是给初中老师的 4 课时工作坊');
  await page.keyboard.press('Enter');
  await expect(page.locator('#patchNote')).toContainText('已按「课程是给初中老师的 4 课时工作坊」更新', { timeout: 10_000 });
});

test('M19 a11y · 焦点可见：键盘焦点元素带描边（铃铛/标签/讨论按钮，:focus-visible）', async ({ page }) => {
  await openDemo(page);
  for (const sel of ['button.bell, [aria-label="需要你"].bell', '.tabs button[data-tab=preview], [role=tab][data-tab=preview]']) {
    await tabTo(page, sel);
    const ring = await focusRing(page);
    expect(ring, sel).not.toBeNull();
    expect(ring!.outlineStyle !== 'none' || ring!.outlineWidth !== '0px', `${sel} 键盘焦点应有可见描边`).toBe(true);
  }
});

test('M19 a11y · aria-live 四处：subtitle / patchNote / capcard / needs（BUILD-PLAN §3 W5.3）', async ({ page }) => {
  await openDemo(page);
  // ① 旁白字幕：aria-live=polite 且播放后内容变化（storyboard.js 契约）
  const subtitle = page.locator('.subtitle[aria-live=polite]').first();
  await expect(subtitle).toBeVisible();
  await expect(subtitle).toHaveAttribute('aria-live', 'polite');
  const before = (await subtitle.textContent()) ?? '';
  await page.locator('.narr button, .narr [aria-pressed]').first().click();
  await expect
    .poll(async () => (await subtitle.textContent()) ?? '', { timeout: 8_000 })
    .not.toBe(before);
  // ② 讨论补丁播报
  const note = page.locator('#patchNote');
  await expect(note).toHaveAttribute('aria-live', 'polite');
  await page.locator('.discuss [data-say]').first().click();
  await expect(note).toContainText('已按「');
  // ③ 拍一下建议卡（b 块，PRD §6.8.2 快感知）
  await page.locator('button.block[data-b="b"]').click();
  await page.locator('[data-capture]').first().click();
  const cap = page.locator('.capcard');
  await expect(cap.first()).toBeVisible({ timeout: 10_000 });
  await expect(cap.first()).toHaveAttribute('aria-live', 'polite');
  await expect(cap.first()).toHaveAttribute('role', 'status');
  // ④ 收件箱 needs 容器
  const panel = page.locator('.card.inbox, [aria-label="需要你"].inbox').first();
  if (!(await panel.isVisible().catch(() => false))) {
    await page.locator('button.bell, [aria-label="需要你"].bell').first().click();
  }
  await expect(panel).toBeVisible();
  await expect(panel.locator('.needs').first()).toHaveAttribute('aria-live', 'polite');
});

test('M19 a11y · reduced-motion：reel Ken Burns 与 capcard 升级动画全禁（PRD §5.8）', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openDemo(page);
  // reel：.on 镜头动画名 none（reel-player REEL_CSS rm 段）
  await page.locator('[data-reel]').first().click();
  const reel = page.locator('.reel[role=dialog]');
  const reelShot = page.locator('.reel .shot.on').first();
  await expect(reelShot).toBeVisible({ timeout: 10_000 });
  const shotAnim = await page.evaluate(() => {
    const el = document.querySelector('.reel .shot.on img, .reel .shot.on');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { name: cs.animationName, dur: cs.transitionDuration };
  });
  expect(shotAnim).not.toBeNull();
  expect(shotAnim!.name).toBe('none');
  await page.keyboard.press('Escape'); // 关播放器再走拍一下（全屏遮罩会拦截后续点击）
  await expect(reel).toHaveCount(0);
  // capcard：快→深升级 capup 动画禁（capture-card rm 段 + 内联 motionApply）
  await page.locator('button.block[data-b="b"]').click();
  await page.locator('[data-capture]').first().click();
  await expect(page.locator('.capcard.deep')).toBeVisible({ timeout: 15_000 });
  const capAnim = await page.evaluate(() => {
    const el = document.querySelector('.capcard');
    if (!el) return null;
    return getComputedStyle(el).animationName;
  });
  expect(capAnim).toBe('none');
});

test('M19 a11y · 深色两路：?theme=dark 参数路 + prefers-color-scheme 媒体路（plan.md M01/M18 深色双路）', async ({ page }) => {
  // 深色 token 挂在 .ag-app（APP_CSS :root[data-theme=dark] .ag-app 作用域），探测该容器底色
  const bgOf = () => page.evaluate(() => {
    const el = document.querySelector('.ag-app');
    return el ? getComputedStyle(el).backgroundColor : '';
  });
  // 基准浅色
  await openDemo(page);
  const light = await bgOf();
  // 路一：[data-theme] 参数（demo.html?theme=dark 契约）
  await openDemo(page, 'theme=dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const darkParam = await bgOf();
  expect(darkParam !== light, '深色参数路应改变底色').toBe(true);
  // 路二：媒体查询（无参数，仅 emulateMedia；:root:not([data-theme=light]) 媒体段）
  await page.emulateMedia({ colorScheme: 'dark' });
  await openDemo(page);
  const darkMedia = await bgOf();
  expect(darkMedia !== light, 'prefers-color-scheme 深色路应改变底色').toBe(true);
  expect(darkMedia).toBe(darkParam); // 两路收敛到同一套深色 token
});

test('M19 a11y · 拍一下快→深：原地升级同一张卡 + 动作反馈（PRD §6.8.2，prototype L586-589/626）', async ({ page }) => {
  await openDemo(page);
  await page.locator('button.block[data-b="b"]').click();
  await page.locator('[data-capture]').first().click();
  const cap = page.locator('.capcard');
  await expect(cap.first()).toBeVisible({ timeout: 10_000 });
  await expect(cap.first()).toContainText('即时'); // 快卡 1.5s：一句话看到了什么
  // 原地升级：节点保活（增量约束——标记不因升级丢失）
  await cap.first().evaluate((el) => el.setAttribute('data-marker', 'keep'));
  await expect(page.locator('.capcard.deep')).toBeVisible({ timeout: 15_000 }); // 深感知 6s：具体建议
  await expect(cap.first()).toContainText('已升级');
  await expect(cap.first()).toContainText('建议');
  await expect(cap.first()).toHaveAttribute('data-marker', 'keep');
  // 动作组反馈：记下来 → ✓ 前缀（prototype L626）
  await page.locator('[data-capact=note]').first().click();
  await expect(page.locator('.cap-note').first()).toContainText('✓', { timeout: 10_000 });
});

test('M19 a11y · reel：role=dialog 打开、首镜字幕即达、Esc 关闭（prototype L552-579/648）', async ({ page }) => {
  await openDemo(page);
  await page.locator('[data-reel]').first().click();
  const reel = page.locator('.reel[role=dialog]');
  await expect(reel).toBeVisible({ timeout: 10_000 });
  await expect(reel).toHaveAttribute('aria-label', '今日预演片');
  await expect(reel.locator('.shot.on')).toHaveCount(1);
  await expect(reel.locator('.cap')).not.toBeEmpty(); // 首镜字幕同步入（aria-live 常驻）
  await expect(reel.locator('.wm').first()).toHaveText('示意'); // 示意水印（PRD §5.2.1；镜身样张亦各自带 .wm）
  await page.keyboard.press('Escape');
  await expect(reel).toHaveCount(0);
});
