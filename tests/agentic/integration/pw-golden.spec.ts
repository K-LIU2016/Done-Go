// S2D-W13 · M23 最小 Playwright golden（plan.md §G5 M23；brief §6 门禁 5）。
//
// 范围（「最小 golden spec」）：W5 UI + W1 sync + preview/acceptance/review/delivered，
// 跑在 W13 集成栈（pw-server.mjs：静态 web/ + M13 组合根 + M14 dispatcher +
// W1 createBlockRoutes(context.auth.forBlocks) + M17 health；临时 SQLite、确定性
// 时钟、fixture 登录、127.0.0.1、17701–17709 段）。真实浏览器（Chromium）：
//   1. W1 sync golden —— 真 index.html boot：seed 一条 entry → 登录态
//      （/api/auth/me fixture + tango-session cookie）→ attachBlockSync 真跑：
//      POST /api/blocks/sync 200 上行、tango:block-sync CustomEvent（M20 接缝）
//      携 serverChanges、.bubble 渲染、重载后整备份唯一（幂等）。
//   2. W5 UI golden —— demo.html?speed=8：5 块卡片（说）→ preview 四件套锚点
//      （outline/把握/示意水印）→ 签约 hash → 交付物 evidence（r ready）→
//      要求修改表单开/收（review 入口，零回调取消）→ 接受 → gain + 「已交付」
//      （delivered）→ 交付台 5 泳道在。
// 深链交互（need 弹窗/超时默认/追加修改轮/移动端）归 W5 自有套件
// （tests/agentic/ui/golden.spec.ts），本 spec 不重复——最小=接缝可证。
//
// 运行（全局锁，≤2 PW 进程约定）：
//   flock -w 900 /tmp/donego-s2d-pw.lock npx playwright test -c tests/agentic/integration/playwright.golden.config.ts
import { test, expect, type Page } from '@playwright/test';

const ACCOUNT_ID = 'w13-golden-user';
const ENTRY_ID = 'w13pwfix01';
const DEMO = '/agentic/demo.html';

/** W1 spec 同款 seed：登录态 storage scope 键（app-auth.js 按 user id 改名）。 */
async function seedEntry(page: Page) {
  await page.addInitScript(({ id, account }) => {
    if (window.localStorage.getItem('__s2d_w13_pw_seeded')) return;
    const date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }); // YYYY-MM-DD（同 ymd()）
    const state = {
      v: 1, pv: 5, mode: 'real', name: 'W13', wake: 960, ideal: null, sortBy: 'prio', fw: {}, pal: 0, uid: '',
      entries: [{ id, date, start: '23:00', end: '23:30', title: 'W13 黄金同步事项', kind: 'create', prio: 3, note: '', done: false }],
      trials: [], methods: [], methodUses: [], drafts: [],
    };
    window.localStorage.setItem(`tango-donego.user.${account}.tango-donego.web.v1`, JSON.stringify(state));
    window.localStorage.setItem('__s2d_w13_pw_seeded', '1');
  }, { id: ENTRY_ID, account: ACCOUNT_ID });
}

/** 收集 M20 接缝事件（tango:block-sync CustomEvent）——须在页面脚本前装好。 */
async function captureSyncEvents(page: Page) {
  await page.addInitScript(() => {
    const sink = (window as unknown as { __w13SyncEvents?: unknown[] });
    sink.__w13SyncEvents = [];
    window.addEventListener('tango:block-sync', (event: Event) => {
      sink.__w13SyncEvents?.push((event as CustomEvent).detail);
    });
  });
}

test('W1 sync golden：登录 boot → /api/blocks/sync 上行 200 → tango:block-sync 事件 → today 渲染 → 重载幂等', async ({ page }) => {
  await seedEntry(page);
  await captureSyncEvents(page);

  const posted = page.waitForResponse(r => r.url().includes('/api/blocks/sync') && r.request().method() === 'POST');
  await page.goto('/');
  const response = await posted;
  expect(response.status()).toBe(200);
  const body = response.request().postDataJSON();
  expect(body.changes.map((c: { id: string }) => c.id)).toEqual([ENTRY_ID]);
  expect(body.changes[0].block.source).toBe('web');

  // M20 接缝：宿主页面能观察到同步事件（serverChanges 到达）
  await expect.poll(async () => page.evaluate(() => (window as unknown as { __w13SyncEvents?: { type?: string }[] }).__w13SyncEvents?.some(e => e?.type === 'serverChanges') ?? false)
  ).toBe(true);

  // boot 完成：today 视图渲染 seed 事项
  await expect(page.locator(`.bubble[data-id="${ENTRY_ID}"]`)).toBeVisible({ timeout: 30_000 });

  // 重载：不重复整备份（幂等），块仍渲染
  await page.reload();
  await expect(page.locator(`.bubble[data-id="${ENTRY_ID}"]`)).toBeVisible({ timeout: 30_000 });
  const backupCount = await page.evaluate(() => Object.keys(window.localStorage).filter(k => /^tango-donego\.backup\.\d+$/.test(k)).length);
  expect(backupCount).toBe(1);
});

test('W5 UI golden：说(5块) → preview → 签约 → acceptance(接受/已交付) + review(要求修改入口) → 交付台', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(`${DEMO}?speed=8`);

  // —— 说：5 块卡片 + r 段徽标 ——
  for (const id of ['r', 'c', 'f', 'b', 's']) {
    await expect(page.locator(`button.block[data-b="${id}"]`)).toBeVisible({ timeout: 30_000 });
  }
  await expect(page.locator('button.block[data-b="r"]')).toContainText('14:00–15:00');

  // —— 看/preview：outline + 把握度 + 示意水印（W6 预演投影的 UI 面） ——
  const preview = page.locator('#tab-preview, section[data-tab=preview]');
  await expect(preview).toContainText('AI 教育现状与趋势');
  await expect(preview.locator('.outline li').first()).toBeVisible();
  await expect(preview).toContainText('把握');
  await expect(preview.locator('.gallery .wm').first()).toHaveText('示意');

  // —— 定：签约 → sha256 hash ——
  await page.locator('.tabs button[data-tab=bound], [role=tab][data-tab=bound]').first().click();
  await expect(page.locator('#tab-bound, section[data-tab=bound]')).toBeVisible();
  const signBtn = page.locator('.sign button.primary');
  await expect(signBtn).toContainText('就这么办');
  await signBtn.click();
  await expect(page.locator('.sign .chip.hi')).toContainText('已签约');
  await expect(await page.locator('.sign .hash').textContent()).toMatch(/sha256:[0-9a-f]/);

  // —— 交：r 交付物就绪（14:52 sim · speed=8 ≈ 8s 级，给足预算） ——
  await page.locator('.tabs button[data-tab=art], [role=tab][data-tab=art]').first().click();
  const art = page.locator('#tab-art, section[data-tab=art]');
  await expect(art.locator('.artifact .evidence')).toBeVisible({ timeout: 90_000 });
  await expect(art.locator('.artifact h3')).toContainText('v1');

  // —— review 入口：要求修改 → 意见表单展开 → 取消（零回调收起，不动 ready 态） ——
  await art.locator('[data-rev]').click();
  const opinion = art.locator('.opinion');
  await expect(opinion).toBeVisible();
  await opinion.fill('W13 golden：第 4 节再短一点');
  await art.locator('[data-cancel-revise]').click();
  await expect(opinion).toBeHidden();

  // —— acceptance：接受 → gain 计时收益 → r 已交付（delivered） ——
  await art.locator('[data-acc]').click();
  await expect(art.locator('.gain')).toContainText('计入为你腾出的时间');
  await expect(page.locator('button.block[data-b="r"]')).toContainText('已交付', { timeout: 30_000 });

  // —— 交付台：5 泳道（delivered 后增量渲染未破坏列表） ——
  await expect(page.locator('.lane')).toHaveCount(5);
});
