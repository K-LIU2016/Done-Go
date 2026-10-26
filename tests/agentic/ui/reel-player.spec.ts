// M17 预演片全屏播放器 组件页测试（RED 先行）
// 契约：reel-player.js mount(el, { shots, onClose }) → handle { next(), pause(), resume(), close() }
//   DOM（prototype L165-177/L552-579）：.reel[role=dialog][aria-label=今日预演片] > .stage(16:9)
//     > .prog(3px) + .shot×N（opacity 切换 + .on Ken Burns kb 7s）+ .cap[aria-live=polite](small at + 正文) + .wm 示意
//     + .ctl（暂停/继续、重播、关闭）；Esc 关闭；shots[].body 为外部合成 HTML（W11 接缝）
import { test, expect } from '@playwright/test';

const SHOTS = [
  { at: '13:30 · 研究员 ×3', body: '<img src="assets/illus-lesson.jpg" alt="">', text: '下午一点半，我先派三个研究员分头找资料。' },
  { at: '13:55 · 需要你 30 秒', body: '<div class="cover"></div>', text: '两点前需要你确认一下受众，三十秒就好。' },
  { at: '15:00 · 课程设计接力', body: '<div class="slide"></div>', text: '三点开始做课程设计，直接用研究结论。' },
];

async function mount(page: import('@playwright/test').Page) {
  await page.goto('/component.html?c=reel-player');
  await page.evaluate((shots) => {
    window.__calls = [];
    window.__mount('reel-player', { shots, onClose: () => window.__calls!.push(['close']) });
  }, SHOTS);
}

test('M17 role=dialog + aria-label + 16:9 舞台（prototype L556-557）', async ({ page }) => {
  await mount(page);
  const reel = page.locator('.reel');
  await expect(reel).toBeAttached();
  await expect(reel).toHaveAttribute('role', 'dialog');
  await expect(reel).toHaveAttribute('aria-label', '今日预演片');
  const ar = await page.evaluate(() => getComputedStyle(document.querySelector('.reel .stage')!).aspectRatio);
  expect(ar).toContain('16');
});

test('M17 开场：第一镜 .on、字幕= 首句、进度条已走（prototype L566-569）', async ({ page }) => {
  await mount(page);
  await expect(page.locator('.reel .shot.on')).toHaveCount(1);
  await expect(page.locator('.reel .cap')).toContainText('13:30 · 研究员 ×3');
  await expect(page.locator('.reel .cap')).toContainText(SHOTS[0].text);
  const prog = await page.evaluate(() => parseFloat((document.querySelector('.reel .prog') as HTMLElement).style.width));
  expect(prog).toBeGreaterThan(0);
  await expect(page.locator('.reel .wm')).toContainText('示意');
});

test('M17 handle.next()：切镜换字幕、旧镜失 .on（prototype L562-569）', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => (window.__handle as unknown as { next(): void }).next());
  await expect(page.locator('.reel .shot.on')).toHaveCount(1);
  await expect(page.locator('.reel .cap')).toContainText('13:55 · 需要你 30 秒');
  await expect(page.locator('.reel .cap')).toContainText(SHOTS[1].text);
});

test('M17 Ken Burns 只在 .on 镜头（prototype L171-172）', async ({ page }) => {
  await mount(page);
  const anims = await page.evaluate(() => {
    const pick = (i: number) => {
      const shot = document.querySelectorAll('.reel .shot')[i] as HTMLElement;
      return getComputedStyle(shot.querySelector('img, div') ?? shot).animationName;
    };
    return { on: pick(0), off: pick(1) };
  });
  expect(anims.on).not.toBe('none');
  expect(anims.off).toBe('none');
});

test('M17 reduced-motion：Ken Burns/过渡全降级、直接切镜（prototype L185）', async ({ page }) => {
  await mount(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const anim = await page.evaluate(() => {
    const shot = document.querySelector('.reel .shot.on') as HTMLElement;
    return getComputedStyle(shot.querySelector('img, div') ?? shot).animationName;
  });
  expect(anim).toBe('none');
});

test('M17 暂停/继续按钮文案切换（prototype L623）', async ({ page }) => {
  await mount(page);
  const btn = page.locator('.reel .ctl button').first();
  await expect(btn).toContainText('暂停');
  await btn.click();
  await expect(btn).toContainText('继续');
  await btn.click();
  await expect(btn).toContainText('暂停');
});

test('M17 播完变「重播」，点击从头（prototype L565/L623）', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => {
    const h = window.__handle as unknown as { next(): void };
    h.next(); h.next(); h.next(); // 3 镜全部播完
  });
  const btn = page.locator('.reel .ctl button').first();
  await expect(btn).toContainText('重播');
  await btn.click();
  await expect(page.locator('.reel .cap')).toContainText(SHOTS[0].text);
});

test('M17 关闭按钮与 Esc 都触发 onClose 并移除遮罩（prototype L579/L648）', async ({ page }) => {
  await mount(page);
  await page.locator('.reel .ctl button:has-text("关闭")').click();
  await page.evaluate(() => window.__mount('reel-player', { shots: SHOTS, onClose: () => window.__calls!.push(['close']) }));
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.__calls)).toEqual([['close'], ['close']]);
  expect(await page.locator('.reel').count()).toBe(0);
});

test('M17 字幕区 aria-live=polite（prototype L557）', async ({ page }) => {
  await mount(page);
  await expect(page.locator('.reel .cap')).toHaveAttribute('aria-live', 'polite');
});

test('M17 shots[].body 外部合成 HTML 原样入镜（W11 薄接缝，plan §1.5）', async ({ page }) => {
  await mount(page);
  await expect(page.locator('.reel .shot img')).toHaveAttribute('src', 'assets/illus-lesson.jpg');
});
