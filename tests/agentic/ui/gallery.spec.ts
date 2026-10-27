// M08 样张画廊 组件页测试（RED 先行）
// 契约：gallery.js mount(el, { samples }) → handle.update({ samples })
//   DOM（prototype L141-161/L366-372）：.gallery > figure.samp > (.frame 4:3 + 内含模板 + span.wm 示意) + figcaption
//   四模板 kind：cover（.cover .meta/.nums）/ slide（.slide .txt+.pic）/ img（<img>）/ route（.route .line）
import { test, expect } from '@playwright/test';

const SAMPLES = [
  { kind: 'cover', cap: '报告封面与首页 · 代码排版 + 配图' },
  { kind: 'slide', cap: '第 2 课时首页 · 文字由代码排版' },
  { kind: 'img', src: 'assets/slide-qwen.jpg', cap: '整页由 qwen-image-2.0 生成' },
  { kind: 'route', cap: '行前简报卡 · 路线与出发时刻' },
];

async function mount(page: import('@playwright/test').Page, samples = SAMPLES) {
  await page.goto('/component.html?c=gallery');
  await page.evaluate((s) => { window.__mount('gallery', { samples: s }); }, samples);
}

test('M08 每样张 figure.samp + .frame(4:3) + figcaption + 统一「示意」水印（PRD §5.2.1 示意标注）', async ({ page }) => {
  await mount(page);
  await expect(page.locator('figure.samp')).toHaveCount(4);
  await expect(page.locator('figure.samp figcaption')).toHaveCount(4);
  await expect(page.locator('.frame .wm')).toHaveCount(4);
  for (const wm of await page.locator('.frame .wm').all()) await expect(wm).toContainText('示意');
  const ar = await page.evaluate(() => getComputedStyle(document.querySelector('.frame')!).aspectRatio);
  expect(ar).toContain('4');
  expect(ar).toContain('3');
});

test('M08 cover 模板：meta 标题 + nums 数字行（prototype L153-157）', async ({ page }) => {
  await mount(page, [SAMPLES[0]]);
  await expect(page.locator('.frame .cover .meta b')).toBeAttached();
  await expect(page.locator('.frame .cover .meta .nums')).toBeAttached();
});

test('M08 slide 模板：txt 双栏排版 + pic 配图（prototype L147-152）', async ({ page }) => {
  await mount(page, [SAMPLES[1]]);
  await expect(page.locator('.frame .slide .txt')).toBeAttached();
  await expect(page.locator('.frame .slide .pic')).toBeAttached();
});

test('M08 img 模板：图片仅 ui/assets/ 白名单（plan.md §1.7）', async ({ page }) => {
  await mount(page, [SAMPLES[2]]);
  await expect(page.locator('.frame img')).toHaveAttribute('src', 'assets/slide-qwen.jpg');
  const srcs = await page.evaluate(() => Array.from(document.querySelectorAll('.frame img')).map((i) => i.getAttribute('src') ?? ''));
  for (const src of srcs) expect(src.startsWith('assets/')).toBeTruthy();
});

test('M08 route 模板：.route + .line 条目（prototype L159-161）', async ({ page }) => {
  await mount(page, [SAMPLES[3]]);
  await expect(page.locator('.frame .route')).toBeAttached();
  expect(await page.locator('.frame .route .line').count()).toBeGreaterThanOrEqual(2);
});

test('M08 代码排版 vs 整页生成并列（c 块 slide+img 同廊，PRD §5.2.1 对照）', async ({ page }) => {
  await mount(page, [SAMPLES[1], SAMPLES[2]]);
  await expect(page.locator('.frame .slide')).toHaveCount(1);
  await expect(page.locator('.frame img')).toHaveCount(1);
});

test('M08 update 同集合不重绘节点、换集合正确换卡（增量约束，DAG M08）', async ({ page }) => {
  await mount(page);
  await page.evaluate((s) => {
    document.querySelectorAll('figure.samp')[0].setAttribute('data-marker', 'keep');
    window.__update({ samples: JSON.parse(JSON.stringify(s)) }); // 同内容再 update：节点必须保留
  }, SAMPLES);
  expect(await page.getAttribute('figure.samp', 'data-marker')).toBe('keep');
  await expect(page.locator('figure.samp')).toHaveCount(4);
  await page.evaluate(() => { window.__update({ samples: [{ kind: 'route', cap: '新路线卡' }] }); });
  await expect(page.locator('figure.samp')).toHaveCount(1);
  await expect(page.locator('figure.samp figcaption')).toContainText('新路线卡');
});
