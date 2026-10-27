// M20 截图五组（规格先行 · BUILD-PLAN §2.4.5：桌面 1280 与手机 390 两宽度，深色各一张，
// reduced-motion 变体；plan.md M20：存 design/schedule-to-delivery/shots/w5/<组>-<宽>-<主题>[-rm].png）
// 五组状态配方（PRD §5 各面 / prototype.html 唯一视觉标准；锚点来自 M03–M18 已冻结实现）：
//   A 预演     demo 默认 r 块 · 预演 tab（骨架 outline + 样张画廊 + 四档 tiers + 分镜 .rail + 旁白入口）
//   B 边界签约 r 块 · 边界 tab（四栏 + SYS_WONT + 「就这么办」未签约态）
//   C 执行可观测 签约 → ×4 跑到 14:3x（交付台泳道 ≥2 段 + nowline）→ 切「进行中」（cost + feed）
//   D 收件箱+拍一下 ×1 签约 → 13:55 n1 弹出立即「全部暂停」→ 切 b 块拍一下等深卡 → 开收件箱
//   E 预演片播放器+场景片卡 c 块：生成场景片到 ready（video 16:9）→ 开预演片（.reel .shot.on + 字幕）
// 截图口径：desktop A/B/C/D fullPage（交付台在折叠线下）；mobile 全部 viewport（固定底抽屉/收件箱
//   以视口为准）；E 双端均 viewport（.reel fixed 全屏遮罩不与 fullPage 拼接）。
// 产物：25 张模板照（5 组 × {1280,390} × {浅,深}）+ 5 张 reduced-motion（1280·浅）+ 4 张 E 补充
//   场景片卡照（e-scene-<宽>-<主题>）＝ 29 文件；清单核对用例对空目录必红（TDD RED 锚）。
// 运行：flock -w 900 /tmp/donego-s2d-pw.lock npx playwright test -c tests/agentic/ui/playwright.config.ts tests/agentic/ui/shots.spec.ts
import { test, expect, type Page } from '@playwright/test';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';

const DEMO = '/demo.html';
const GROUPS = ['a', 'b', 'c', 'd', 'e'] as const;
const THEMES = ['light', 'dark'] as const;
/** 最小体积下限：空图/纯底色 PNG 远小于此（模板照实测均 >40KB） */
const MIN_BYTES = 15_000;

/** 截图目录：tests/agentic/ui/ → 仓库根 design/schedule-to-delivery/shots/w5/（不依赖进程 CWD） */
function shotsDir(): string {
  return path.resolve(path.dirname(test.info().file), '../../../design/schedule-to-delivery/shots/w5');
}
function shotPath(name: string): string {
  return path.join(shotsDir(), `${name}.png`);
}
/** 当前 project 宽度口径（BUILD-PLAN §2.4.5：1280 桌面 / 390 手机） */
function widthOf(): '1280' | '390' {
  return test.info().project.name === 'mobile' ? '390' : '1280';
}

/** 落盘 + 断言工件（PNG 非空且非tiny） */
async function shoot(page: Page, name: string, fullPage: boolean) {
  const p = shotPath(name);
  mkdirSync(path.dirname(p), { recursive: true });
  await page.screenshot({ path: p, fullPage });
  expect(existsSync(p), `${name}.png 应已落盘`).toBe(true);
  expect(statSync(p).size, `${name}.png 应 ≥${MIN_BYTES}B（空图/破图防呆）`).toBeGreaterThan(MIN_BYTES);
}

async function openDemo(page: Page, query: string) {
  await page.goto(`${DEMO}?${query}`);
  await expect(page.locator('button.block[data-b="r"]')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
}

async function showTab(page: Page, tab: string) {
  await page.locator(`.tabs button[data-tab=${tab}]`).first().click();
  await expect(page.locator(`#tab-${tab}`)).toBeVisible();
}

/** 签约（bound tab 「就这么办」→ 已签约 hash；600ms 后 sim 自启） */
async function sign(page: Page) {
  await showTab(page, 'bound');
  await page.locator('.sign button.primary').click();
  await expect(page.locator('.sign .chip.hi')).toContainText('已签约');
}

/** 各组状态配方：驱动 demo 到目标态并断言关键面已在场（防「截到破图」静默通过） */
type Recipe = (page: Page, theme: string) => Promise<{ fullPage: boolean }>;

const RECIPES: Record<(typeof GROUPS)[number], Recipe> = {
  // A 预演：r 块默认预演 tab（stage=see）
  a: async (page, theme) => {
    await openDemo(page, `theme=${theme}`);
    const pv = page.locator('#tab-preview');
    await expect(pv.locator('.outline li').first()).toBeVisible();
    await expect(pv.locator('.tiers')).toBeVisible();
    await expect(pv.locator('.gallery figure.samp').first()).toBeVisible();
    await expect(pv.locator('.rail .ev').first()).toBeVisible();
    await page.waitForTimeout(400); // 字体/画廊首帧安定
    return { fullPage: widthOf() === '1280' };
  },
  // B 边界签约：四栏 + SYS_WONT + 未签约按钮（决定论态，不触发 600ms 自跑竞态）
  b: async (page, theme) => {
    await openDemo(page, `theme=${theme}`);
    await showTab(page, 'bound');
    await expect(page.locator('.bound section h3')).toHaveCount(4);
    await expect(page.locator('.bound .sys').first()).toBeVisible();
    await expect(page.locator('.sign button.primary')).toContainText('就这么办');
    await page.waitForTimeout(300);
    return { fullPage: widthOf() === '1280' };
  },
  // C 执行可观测：签约 ×4 → 交付台 ≥2 段 + nowline → 「进行中」cost/feed
  c: async (page, theme) => {
    await openDemo(page, `speed=4&theme=${theme}`);
    await sign(page);
    await expect(page.locator('.lane[data-lane="r"] .track .seg').first()).toBeVisible({ timeout: 60_000 });
    await expect.poll(
      async () => (await page.locator('[data-region="clock"]').textContent()) ?? '',
      { timeout: 30_000 },
    ).toMatch(/14:[3-5][0-9]/); // 14:3x：检索+写作+核验 三段在场、nowline 窗中
    await expect(page.locator('.lane[data-lane="r"] .track .seg')).toHaveCount(3);
    await expect(page.locator('.nowline').first()).toBeVisible();
    await showTab(page, 'live');
    await expect(page.locator('.cost')).toContainText('模型调用');
    await expect(page.locator('.feed').first()).toContainText('研究员');
    await page.waitForTimeout(400);
    return { fullPage: widthOf() === '1280' };
  },
  // D 收件箱+拍一下：×1 签约 → 13:55 n1 挂起即暂停（need 不超时）→ b 块拍一下深卡 → 开收件箱
  d: async (page, theme) => {
    test.setTimeout(150_000); // ×1 下 13:10→13:55 = 45 拍 × 600ms ≈ 27s
    await openDemo(page, `speed=1&theme=${theme}`);
    await sign(page);
    await expect(page.locator('.bell b:not(.hidden)')).toBeVisible({ timeout: 60_000 }); // n1 挂起
    // 立即暂停：n1 到期(14:00=×1 下 3s 后)前冻结。dispatchEvent——mobile 上交付台在固定底抽屉
    // 之下（z60 遮挡）不可点，走同一容器级委托处理器驱动状态（截图主体是收件箱/拍一下卡）。
    await page.locator('[data-board-pause]').dispatchEvent('click');
    await expect(page.locator('[data-board-pause]')).toContainText('继续');
    await page.locator('button.block[data-b="b"]').click();
    await showTab(page, 'preview');
    await page.locator('button[data-capture]').click(); // 拍一下 → 快卡
    await expect(page.locator('.capcard')).toBeVisible();
    await page.locator('.bell').first().click(); // 开收件箱（fixed 面板）
    await expect(page.locator('.card.inbox')).toBeVisible();
    const need = page.locator('.card.inbox .need').first();
    await expect(need).toBeVisible();
    await expect(need).not.toContainText('已处理'); // 必须是「等你拍板」的挂起态
    await expect(page.locator('.capcard.deep')).toBeVisible({ timeout: 10_000 }); // 4.5s 升深卡
    await page.waitForTimeout(300);
    return { fullPage: widthOf() === '1280' };
  },
  // E 预演片播放器+场景片卡：c 块场景片生成到 ready（video）→ 补充照 → 开预演片
  e: async (page, theme) => {
    await openDemo(page, `block=c&theme=${theme}`);
    const pv = page.locator('#tab-preview');
    await expect(pv.locator('.tiers [data-scene]')).toBeVisible();
    await pv.locator('.tiers [data-scene]').click(); // 真 · 生成场景片
    await expect(pv.locator('.scenebox .frame video')).toBeVisible({ timeout: 20_000 }); // ready
    await page.waitForTimeout(400);
    await shoot(page, `e-scene-${widthOf()}-${theme}`, widthOf() === '1280'); // E 补充：场景片卡照
    await pv.locator('.tiers [data-reel]').click(); // 动 ▶ 预演片 42s
    const reel = page.locator('.reel[role=dialog]');
    await expect(reel).toBeVisible();
    await expect(reel.locator('.shot.on').first()).toBeVisible();
    await expect(reel.locator('.cap')).not.toBeEmpty();
    await page.waitForTimeout(500); // 首镜图片解码
    return { fullPage: false };
  },
};

// ---------- 生成用例：5 组 × {1280,390} × {浅,深} ----------
for (const g of GROUPS) {
  for (const theme of THEMES) {
    test(`M20 ${g.toUpperCase()} · ${theme}（模板照）`, async ({ page }) => {
      const { fullPage } = await RECIPES[g](page, theme);
      await shoot(page, `${g}-${widthOf()}-${theme}`, fullPage);
    });
  }
}

// ---------- reduced-motion 变体：每组一张（1280 · 浅；§2.4.5「reduced-motion 下无动画」） ----------
for (const g of GROUPS) {
  test(`M20 ${g.toUpperCase()} · reduced-motion 变体`, async ({ page }) => {
    test.skip(test.info().project.name !== 'desktop', 'rm 变体按 plan 每组一张，取 1280·浅口径');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const { fullPage } = await RECIPES[g](page, 'light');
    await shoot(page, `${g}-1280-light-rm`, fullPage);
  });
}

// ---------- 清单核对（TDD RED 锚）：29 个工件全部在库且非空 ----------
// 挂 mobile project（config 顺序第二）：全量双 project 单命令跑时最后执行，desktop 10+5 已落盘；
// 单独核对空目录必红：--project=mobile --grep 清单。
test('M20 §2.4.5 截图清单完整（25 模板 + 5 rm + 4 场景片补充 = 29 文件）', () => {
  test.skip(test.info().project.name !== 'mobile', '清单核对挂第二 project（mobile）收尾跑一次');
  const names: string[] = [];
  for (const g of GROUPS) for (const w of ['1280', '390'] as const) for (const th of THEMES) names.push(`${g}-${w}-${th}`);
  for (const g of GROUPS) names.push(`${g}-1280-light-rm`);
  for (const w of ['1280', '390'] as const) for (const th of THEMES) names.push(`e-scene-${w}-${th}`);
  expect(names, '模板 20 + rm 5 + 补充 4').toHaveLength(29);
  const missing = names.filter((n) => !existsSync(shotPath(n)));
  expect(missing, `缺失工件：${missing.join(', ')}`).toEqual([]);
  for (const n of names) {
    expect(statSync(shotPath(n)).size, `${n}.png ≥${MIN_BYTES}B`).toBeGreaterThan(MIN_BYTES);
  }
});
