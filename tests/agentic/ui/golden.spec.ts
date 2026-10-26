// M19 e2e 黄金场景（RED 先行 · 依赖 M18 web/agentic/demo.html + ui/app.js）
// 契约：demo.html 引 agentic 全组件走完 PRD §3.2 时刻表（prototype.html L241-651 唯一交互标准）：
//   说（5 块卡片）→ 看（预演：骨架/样张/四档/分镜/旁白入口）→ 讨论（补丁 → 差异高亮 3 秒级）
//   → 定（签约 → sha256 hash）→ 交（feed 推进 / 交付台泳道 / need 弹出并作答 / 超时按默认
//   / 接受计入时间收益 / 要求修改带意见）。
// URL 参数（plan.md M18）：?speed=（模拟倍速）?theme= ?block=；
// 组件 DOM 锚点全部来自 M03–M17 已冻结实现（block-card/drawer/discuss/boundaries/inbox/
// acceptance/board/activity-feed/tiers/gallery/storyboard）。
// 双 project：desktop 1280×900 + mobile 390×844（playwright.config.ts）；flock 全局锁外层保证。
import { test, expect, type Page } from '@playwright/test';

const DEMO = '/demo.html';

/** 打开 demo（默认 r 块、×4 倍速参数；demo 未识别参数时由 ensureSpeed 兜底切 ×4） */
async function openDemo(page: Page, query = 'speed=4') {
  await page.goto(`${DEMO}?${query}`);
  await expect(page.locator('button.block[data-b="r"]')).toBeVisible({ timeout: 30_000 });
}

/** 交付台速度按钮归一到 ×4（prototype L639：×1↔×4 切换；签约前点不启动 sim） */
async function ensureSpeed4(page: Page) {
  const btn = page.locator('[data-board-speed]');
  if ((await btn.count()) === 0) return; // demo 未提供速度钮：依赖 ?speed= 参数（×1 亦在超时预算内）
  const label = (await btn.textContent()) ?? '';
  if (!label.includes('×4') && !label.toLowerCase().includes('x4')) await btn.click();
}

/** 铃铛 → 收件箱面板可见（已开则不动） */
async function openInbox(page: Page) {
  const panel = page.locator('.card.inbox, [aria-label="需要你"].inbox');
  if (!(await panel.first().isVisible().catch(() => false))) {
    await page.locator('button.bell, [aria-label="需要你"].bell').first().click();
  }
  await expect(panel.first()).toBeVisible();
}

/** 切到抽屉某标签并等面板可见 */
async function showTab(page: Page, tab: string) {
  await page.locator(`.tabs button[data-tab=${tab}], [role=tab][data-tab=${tab}]`).first().click();
  await expect(page.locator(`#tab-${tab}, section[data-tab=${tab}]`)).toBeVisible();
}

test('M19 黄金场景 · 说：5 块卡片 + 交付徽标（PRD §3.2 13:10 行，prototype L249-255）', async ({ page }) => {
  await openDemo(page);
  for (const id of ['r', 'c', 'f', 'b', 's']) {
    await expect(page.locator(`button.block[data-b="${id}"]`)).toBeVisible();
  }
  // +3s 扫描行：可交付度徽标 + 「需要你 N」角标（PRD §5.1 交付徽标）
  const r = page.locator('button.block[data-b="r"]');
  await expect(r).toContainText('14:00–15:00');
  await expect(r).toContainText('可交付度 高');
  await expect(page.locator('button.block[data-b="c"]')).toContainText('需要你 2');
  await expect(page.locator('button.block[data-b="s"]')).toContainText('零打扰');
  // 阶段条初始：①说 done ②看 on（prototype L258 stage='see'）
  await expect(page.locator('.stepper [data-s=say]')).toHaveClass(/done/);
  await expect(page.locator('.stepper [data-s=see]')).toHaveClass(/on/);
});

test('M19 黄金场景 · 看：r 预演四件套（骨架/样张画廊+示意/四档进度/分镜+旁白入口）', async ({ page }) => {
  await openDemo(page);
  // 骨架：未讨论态标题 + outline（prototype L263/271-275）
  const preview = page.locator('#tab-preview, section[data-tab=preview]');
  await expect(preview).toContainText('AI 教育现状与趋势');
  await expect(preview.locator('.outline li').first()).toBeVisible();
  await expect(preview).toContainText('把握');
  // 样张画廊：figure.samp + 统一「示意」水印（PRD §5.2.1 规则）
  await expect(preview.locator('.gallery figure.samp').first()).toBeVisible();
  await expect(preview.locator('.gallery .wm').first()).toHaveText('示意');
  // 四档进度：形 ✓ / 样 ✓ / 动 ▶ 预演片入口（prototype L376）
  await expect(preview.locator('.tiers')).toBeVisible();
  await expect(preview.locator('[data-reel]').first()).toContainText('预演片');
  // 分镜轴 + 旁白入口（prototype L407-408）
  await expect(preview.locator('.rail .ev').first()).toBeVisible();
  await expect(preview.locator('.narr button, .narr [aria-pressed]').first()).toContainText('听旁白');
});

test('M19 黄金场景 · 讨论：例句补丁 → 差异高亮 + 可交付度联动（PRD §3.2 讨论行，prototype L452-459）', async ({ page }) => {
  await openDemo(page);
  await page.locator('.discuss [data-say]').first().click();
  // patchNote 播报「已按「…」更新」+ 新增/删除/变更（.add/.del/.chg）
  const note = page.locator('#patchNote');
  await expect(note).toContainText('已按「');
  await expect(note).toContainText('新增');
  await expect(note).toContainText('删除');
  await expect(note).toContainText('变更');
  await expect(note.locator('.add, .del, .chg').first()).toBeVisible();
  // 预演 3 秒内更新：outline 出差异类（新增绿/删除线/变更黄，prototype L264-269）
  await expect(page.locator('.outline li.add, .outline li.del, .outline li.chg').first()).toBeVisible({ timeout: 5_000 });
  // 联动：课程块可交付度 中 → 高（prototype L456）
  await expect(page.locator('button.block[data-b="c"]')).toContainText('可交付度 高');
});

test('M19 黄金场景 · 全链：签约 hash → 执行可观测 → need 作答/超时默认 → 接受/要求修改', async ({ page }) => {
  test.setTimeout(360_000); // ×1 倍速兜底预算（×4 实测 ≈60s/端）
  await openDemo(page);

  // ---- 定：边界四栏 + SYS_WONT + 签约 → sha256 hash（PRD §3.2 签约行，prototype L461-467/631-635）
  await showTab(page, 'bound');
  const heads = await page.locator('.bound section h3').allTextContents();
  expect(heads).toEqual(['我会做', '我不会做', '需要你', '花费与上限']);
  await expect(page.locator('.bound .sys').first()).toBeVisible(); // 系统默认禁止项不可覆盖（PRD §8.1）
  const signBtn = page.locator('.sign button.primary');
  await expect(signBtn).toContainText('就这么办');
  await signBtn.click();
  await expect(page.locator('.sign .chip.hi')).toContainText('已签约');
  const hashText = await page.locator('.sign .hash').textContent();
  expect(hashText ?? '').toMatch(/sha256:[0-9a-f]/); // 按钮签的就是这份合同的 hash（V3-17）
  await expect(page.locator('.stepper [data-s=sign]')).toHaveClass(/done/);
  await expect(page.locator('.stepper [data-s=run]')).toHaveClass(/on/);

  await ensureSpeed4(page); // 签约后 sim 启动（prototype L635 startSim）

  // ---- 交 · 可观测：交付台泳道出现 r 段 + nowline（PRD §5.4，prototype L507-513）
  await expect(page.locator('.lane[data-lane="r"] .track .seg').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.nowline').first()).toBeVisible();

  // ---- 交 · 故事层：活动流推进 + 「为什么」可展开（PRD §5.4，prototype L471-476）
  await showTab(page, 'live');
  await expect(page.locator('.cost')).toContainText('模型调用', { timeout: 60_000 });
  await expect(page.locator('.feed').first()).toContainText('研究员', { timeout: 90_000 });
  const summary = page.locator('.feed details summary').first();
  if (await summary.isVisible().catch(() => false)) {
    await summary.click();
    await expect(page.locator('.feed .why').first()).toContainText('为什么');
  }

  // ---- 交 · 验收 r：ready → 接受 → 计入时间收益（PRD §3.2 15:00 行 / §5.6，prototype L484-488）
  await showTab(page, 'art');
  await expect(page.locator('.artifact .evidence')).toBeVisible({ timeout: 200_000 });
  await expect(page.locator('.artifact h3')).toContainText('v1');
  await page.locator('.artifact [data-acc]').click();
  await expect(page.locator('.gain')).toContainText('计入为你腾出的时间');
  await expect(page.locator('button.block[data-b="r"]')).toContainText('已交付', { timeout: 30_000 });

  // ---- 交 · need 作答：收件箱弹出 → 当场回答（PRD §3.2 15:30 行，prototype L640）
  await openInbox(page);
  const firstOpt = page.locator('.need .acts [data-ans]').first();
  await expect(firstOpt).toBeVisible({ timeout: 150_000 });
  const firstNeed = page.locator('.need').filter({ has: firstOpt });
  const needTitle = ((await firstNeed.locator('b').first().textContent()) ?? '').trim();
  expect(needTitle).not.toBe('');
  await firstOpt.click();
  await expect(firstNeed).toContainText('已处理：你选了「', { timeout: 15_000 });

  // ---- 交 · 要求修改 c：意见 → 新一轮 Run（保留旧版本语义，PRD §5.6，prototype L642）
  await page.locator('button.block[data-b="c"]').click();
  await showTab(page, 'art');
  await expect(page.locator('.artifact .evidence')).toBeVisible({ timeout: 240_000 });
  await page.locator('.artifact [data-rev]').click();
  const opinion = page.locator('.opinion');
  await expect(opinion).toBeVisible();
  await opinion.fill('第 4 节再短一点');
  await page.locator('[data-confirm-revise]').click();
  await showTab(page, 'live');
  await expect(page.locator('.feed').first()).toContainText('修改', { timeout: 60_000 });

  // ---- 交 · 超时默认：未作答的 need 到期按默认继续（PRD §3.2 13:30-17:00 行 / §5.5，prototype L607）
  await openInbox(page);
  await expect(page.locator('.need', { hasText: '已处理：超时 ·' }).first())
    .toBeVisible({ timeout: 240_000 });

  // 终态 Sanity：r 仍已交付、5 泳道在（增量渲染未破坏列表）
  await expect(page.locator('button.block[data-b="r"]')).toContainText('已交付');
  await expect(page.locator('.lane')).toHaveCount(5);
});
