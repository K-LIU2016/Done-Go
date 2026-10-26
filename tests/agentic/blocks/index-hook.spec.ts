// W1 index-hook e2e（单浏览器上下文；双设备/断网场景归本流 e2e 模块的 tests/agentic/blocks 补充）：
// 真浏览器走真实 boot（fixture 登录）验证 web/index.html 持久化段钩子——
//   1. 动态 import('/agentic/sync.js') 真实可达（serve 静态 web/），登录后 GET /api/blocks + 迁移上行；
//   2. 首次同步前整备份 tango-donego.backup.<ts> 是全局键（window.localStorage 直见，不经账号 scope 改名）；
//   3. save() 成功路径入队：UI 改事项标题 → ed-save → 增量 POST 上行新标题；
//   4. boot 正常完成（today 视图渲染 seed 事项，onboard 未拦截）。
import { test, expect } from '@playwright/test';

const ENTRY_ID = 'e2efix01';

// seed 只在首个页面加载前执行一次（reload 后保留用户编辑，验证持久化语义）
test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ id }) => {
    if (window.localStorage.getItem('__s2d_w1_seeded')) return;
    const date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }); // YYYY-MM-DD（同 ymd()）
    const state = {
      v: 1, pv: 5, mode: 'real', name: 'E2E', wake: 960, ideal: null, sortBy: 'prio', fw: {}, pal: 0, uid: '',
      entries: [{ id, date, start: '23:00', end: '23:30', title: 'E2E 待改事项', kind: 'create', prio: 3, note: '', done: false }],
      trials: [], methods: [], methodUses: [], drafts: [],
    };
    // 登录态下 index.html 的 localStorage=TangoAccountStorage：web.v1 被改名为 user.<id>. 前缀（app-auth.js:97）
    window.localStorage.setItem('tango-donego.user.e2e-user.tango-donego.web.v1', JSON.stringify(state));
    window.localStorage.setItem('__s2d_w1_seeded', '1');
  }, { id: ENTRY_ID });
});

test('登录启动：迁移上行 + 首次整备份为全局键 + 游标落盘 + today 视图正常渲染', async ({ page }) => {
  const posted = page.waitForResponse(response => response.url().includes('/api/blocks/sync') && response.request().method() === 'POST');
  const pulled = page.waitForResponse(response => response.url().includes('/api/blocks') && response.request().method() === 'GET');
  await page.goto('/');
  const [post, get] = await Promise.all([posted, pulled]);
  expect(post.status()).toBe(200);
  expect(get.status()).toBe(200);
  const body = post.request().postDataJSON();
  expect(body.changes.map((change: { id: string }) => change.id)).toEqual([ENTRY_ID]);
  expect(body.changes[0].block.source).toBe('web');

  // 备份/游标/flag 均为全局键：window.localStorage 直见（不匹配 TangoAccountStorage scope 正则）
  const keys = await page.evaluate(() => Object.keys(window.localStorage));
  const backupKeys = keys.filter(key => /^tango-donego\.backup\.\d+$/.test(key));
  expect(backupKeys).toHaveLength(1);
  expect(keys).toContain('tango-donego.blocks.backup.v1:e2e-user');
  expect(keys).toContain('tango-donego.blocks.cursor.v1');
  const backup = await page.evaluate(key => window.localStorage.getItem(key), backupKeys[0]);
  expect(JSON.parse(backup as string).entries[0].id).toBe(ENTRY_ID); // 完整本地数据（导入导出同格式）

  // boot 完成、onboard 未拦截：today 视图渲染 seed 事项
  await expect(page.locator('.bubble[data-id="' + ENTRY_ID + '"]')).toBeVisible();
});

test('save() 成功路径入队：UI 改标题 → 增量 POST 上行新标题；重载后不重复备份', async ({ page }) => {
  await page.goto('/');
  const bubble = page.locator('.bubble[data-id="' + ENTRY_ID + '"]');
  await expect(bubble).toBeVisible();
  await bubble.click();                                        // 选中事项 → 修改 sheet
  const title = page.locator('#ed-title');
  await expect(title).toBeVisible();
  await title.fill('E2E 已改事项');
  const posted = page.waitForResponse(response => response.url().includes('/api/blocks/sync') && response.request().method() === 'POST');
  await page.locator('[data-act="ed-save"]').click();           // save() 成功路径 → notifyBlockSync 入队
  const response = await posted;
  expect(response.status()).toBe(200);
  const body = response.request().postDataJSON();
  const change = body.changes.find((item: { id: string }) => item.id === ENTRY_ID);
  expect(change).toBeTruthy();
  expect(change.block.title).toBe('E2E 已改事项');
  expect(change.baseRevision).toBeGreaterThan(0);               // 首次迁移学到的 revision 作为基准

  // 重载：flag 已持久化 → 不再写新备份；服务端块随 GET 拉回（标题为已上行的新值）
  await page.reload();
  await expect(page.locator('.bubble[data-id="' + ENTRY_ID + '"]')).toBeVisible();
  await expect(page.getByText('E2E 已改事项').first()).toBeVisible();
  const backupCount = await page.evaluate(() => Object.keys(window.localStorage).filter(key => /^tango-donego\.backup\.\d+$/.test(key)).length);
  expect(backupCount).toBe(1);
});
