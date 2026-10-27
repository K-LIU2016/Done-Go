// W1 blocks-e2e：双浏览器上下文=两台设备同账号（BUILD-PLAN §3 W1-4 e2e、PRD §11.1）三场景：
//   1. A 新增（capture 录入→draft 块上行）→ B 重载全量拉到同一块；
//   2. 双方改同一条 → 冲突上报（POST 响应 conflicts 带服务端块）、双方数据都不丢
//      （B 本地保留自己的标题，服务端保留 A 的标题，不自动覆盖）；
//   3. context.setOffline 断网写（本地先落、不发包）→ 恢复后自动补写上行。
// harness=同目录 server.mjs（真 /api/auth + 自建挂载 createBlockRoutes + 静态 web/，端口 17602）。
// 登录走真邮箱验证码注册（sendEmail 在 harness 内捕获，测试拿到的都是 fixture 账号，无外部调用）。
import { test, expect, type BrowserContext, type APIRequestContext, type Page } from '@playwright/test';

const ORIGIN = process.env.S2D_W1_E2E_PORT ? 'http://127.0.0.1:' + process.env.S2D_W1_E2E_PORT : 'http://127.0.0.1:17602';
const USERNAME = 's2d-w1-e2e';
const EMAIL = USERNAME + '@fixture.test';
const PASSWORD = 's2dw1-e2e'; // 8-15 位（server/auth/service.mjs PASSWORD_MIN/MAX）
const AUTH_HEADERS = { origin: ORIGIN, 'x-tango-client': 'tango-settings/1', 'content-type': 'application/json' };
const CONFLICT_ID = 'e2econf01';

const isBlocks = (url: string) => url.includes('/api/blocks');
const scopedKey = (uid: string) => 'tango-donego.user.' + uid + '.tango-donego.web.v1';
const todayShanghai = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }); // YYYY-MM-DD（同 index.html ymd()）

// 一次性注册真账号（harness /__test/register：send-code（验证码捕获进内存 mailbox）→ register → login，
// 转发 login 的 Set-Cookie）。服务器残留导致已注册时回退 login，保证重跑幂等。
async function ensureAccount(api: APIRequestContext) {
  const registered = await api.post('/__test/register', { data: { username: USERNAME, password: PASSWORD, displayName: 'S2D W1 E2E' } });
  if (registered.ok()) return;
  const login = await api.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD }, headers: AUTH_HEADERS });
  expect(login.ok()).toBeTruthy();
}

// 每台"设备"（BrowserContext）独立登录拿会话 cookie → 同账号两份会话
async function login(ctx: BrowserContext) {
  const response = await ctx.request.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD }, headers: AUTH_HEADERS });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).user as { id: string };
}

// 登录态下本地状态种子的 scoped 键（app-auth.js:97 scope 规则；同 index-hook.spec.ts 的种法）
async function seedEntry(ctx: BrowserContext, uid: string, entry: object) {
  await ctx.addInitScript(({ uid, entry }) => {
    if (window.localStorage.getItem('__s2d_w1_seeded')) return;
    const state = {
      v: 1, pv: 5, mode: 'real', name: 'E2E', wake: 960, ideal: null, sortBy: 'prio', fw: {}, pal: 0, uid: '',
      entries: [entry], trials: [], methods: [], methodUses: [], drafts: [],
    };
    window.localStorage.setItem('tango-donego.user.' + uid + '.tango-donego.web.v1', JSON.stringify(state));
    window.localStorage.setItem('__s2d_w1_seeded', '1');
  }, { uid, entry });
}

// bubble 编辑保存（index-hook.spec.ts 已验证的 UI 路径：点块 → ed-title → ed-save → save()→入队→flush）
async function editTitle(page: Page, id: string, title: string) {
  await page.locator('.bubble[data-id="' + id + '"]').click();
  const field = page.locator('#ed-title');
  await expect(field).toBeVisible();
  await field.fill(title);
  await page.locator('[data-act="ed-save"]').click();
}

test.beforeAll(async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: ORIGIN });
  await ensureAccount(api);
  await api.dispose();
});

test('场景1：设备A新增 → 设备B拉到（同账号跨设备）', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  await login(ctxA);
  const userB = await login(ctxB);
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await pageA.goto('/');
  await expect(pageA.locator('#cap-text')).toBeVisible(); // boot 完成（登录门已过）

  // A 用 capture 录入一条（规则解析→S.drafts→save()→入队 source='draft'→POST 上行）
  const posted = pageA.waitForResponse(r => r.url().includes('/api/blocks/sync') && r.request().method() === 'POST');
  await pageA.fill('#cap-text', '21:00-21:30 写周报');
  await pageA.press('#cap-text', 'Enter');
  const response = await posted;
  expect(response.status()).toBe(200);
  const body = response.request().postDataJSON() as { baseRevision: number; changes: { id: string; baseRevision: number; block: { title: string; date: string; start: string | null; end: string | null; source: string } }[] };
  expect(body.changes).toHaveLength(1);
  const change = body.changes[0];
  expect(change.block.source).toBe('draft');
  expect(change.block.title).toContain('周报');
  expect(change.block.date).toBe(todayShanghai());
  expect(change.block.start).toBe('21:00');
  expect(change.block.end).toBe('21:30');
  expect((await response.json()).applied).toBe(1);

  // B 上线：start() 全量 GET 拉到同一块（wire 级）；引擎 serverChanges 事件并入 S.drafts 并落
  // scoped storage（W1 的 onEvent 无 UI 渲染——提示 UI 是第 3 批 W13，此处按数据层断言）
  const pulled = pageB.waitForResponse(r => isBlocks(r.url()) && r.request().method() === 'GET');
  await pageB.goto('/');
  const get = await pulled;
  expect(get.status()).toBe(200);
  const pulledBody = (await get.json()) as { blocks: { id: string; title: string }[] };
  const pulledBlock = pulledBody.blocks.find(block => block.id === change.id);
  expect(pulledBlock).toBeTruthy();
  expect(pulledBlock!.title).toBe(change.block.title);
  await expect.poll(async () => await pageB.evaluate(({ key, id }) => {
    const state = JSON.parse(window.localStorage.getItem(key) || '{}');
    const draft = (state.drafts || []).find((d: { id: string }) => d.id === id);
    return draft ? draft.title : null;
  }, { key: scopedKey(userB.id), id: change.id }), { timeout: 5000 }).toBe(change.block.title);
  // 刷新后 B 从"浏览器=服务端缓存"渲染出同一条草稿（同 id 同标题）
  await pageB.reload();
  await expect(pageB.locator('.draft[data-id="' + change.id + '"] input[data-f="title"]')).toHaveValue(change.block.title);

  await ctxA.close();
  await ctxB.close();
});

test('场景2：双方改同一条 → 冲突上报、双方数据都不丢', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const userA = await login(ctxA);
  const userB = await login(ctxB);
  expect(userB.id).toBe(userA.id); // 同一账号
  const base = { id: CONFLICT_ID, date: todayShanghai(), start: '23:00', end: '23:30', title: 'E2E 冲突基底', kind: 'create', prio: 3, note: '', done: false };
  await seedEntry(ctxA, userA.id, base);
  await seedEntry(ctxB, userB.id, base);

  // A 先上线：迁移上行基底块（revision 1）
  const pageA = await ctxA.newPage();
  const migrated = pageA.waitForResponse(r => r.url().includes('/api/blocks/sync') && r.request().method() === 'POST');
  await pageA.goto('/');
  const migration = await migrated;
  expect(migration.status()).toBe(200);
  expect((await migration.json()).applied).toBe(1);

  // B 后上线：GET 拉到基底（学到 revision 1，内容一致不再上行）
  const pageB = await ctxB.newPage();
  const pulled = pageB.waitForResponse(r => isBlocks(r.url()) && r.request().method() === 'GET');
  await pageB.goto('/');
  expect((await pulled).status()).toBe(200);
  await expect(pageB.locator('.bubble[data-id="' + CONFLICT_ID + '"]')).toBeVisible();

  // A 改标题（base=1 → applied，服务端 revision 2）；标题用单字，bubble 标签不截断（.bt 短标签）
  const postedA = pageA.waitForResponse(r => r.url().includes('/api/blocks/sync') && r.request().method() === 'POST');
  await editTitle(pageA, CONFLICT_ID, '甲');
  const responseA = await postedA;
  expect(responseA.status()).toBe(200);
  const bodyA = responseA.request().postDataJSON() as { changes: { id: string; baseRevision: number }[] };
  expect(bodyA.changes.find(c => c.id === CONFLICT_ID)?.baseRevision).toBe(1);
  expect((await responseA.json()).applied).toBe(1);

  // B 在不知道 A 修订的情况下改同一条（base=1 ≠ 服务端 2）→ 冲突上报、不自动覆盖
  const postedB = pageB.waitForResponse(r => r.url().includes('/api/blocks/sync') && r.request().method() === 'POST');
  await editTitle(pageB, CONFLICT_ID, '乙');
  const responseB = await postedB;
  expect(responseB.status()).toBe(200);
  const dataB = await responseB.json() as { applied: number; conflicts: { id: string; block: { title: string; revision: number } }[]; serverChanges: { id: string }[] };
  expect(dataB.applied).toBe(0);
  expect(dataB.conflicts).toHaveLength(1);
  expect(dataB.conflicts[0].id).toBe(CONFLICT_ID);
  expect(dataB.conflicts[0].block.title).toBe('甲'); // 冲突上报带服务端当前版本（供前端提示合并）
  expect(dataB.conflicts[0].block.revision).toBe(2);
  expect(dataB.serverChanges.find(block => block.id === CONFLICT_ID)).toBeUndefined(); // 冲突块不下发覆盖本地

  // 不丢数据①：B 本地保留自己的标题（UI bubble 与 scoped storage 都是 B 的版本）
  await expect(pageB.locator('.bubble[data-id="' + CONFLICT_ID + '"] .bt')).toContainText('乙');
  const localB = await pageB.evaluate(key => JSON.parse(window.localStorage.getItem(key) || '{}'), scopedKey(userB.id));
  expect(localB.entries.find((e: { id: string }) => e.id === CONFLICT_ID).title).toBe('乙');
  // 不丢数据②：服务端权威版本仍是 A 的标题（B 的过期写没有覆盖它）
  const serverView = await ctxB.request.get('/api/blocks', { headers: { 'x-tango-client': 'tango-settings/1' } });
  expect(serverView.ok()).toBeTruthy();
  const serverBlocks = (await serverView.json()) as { blocks: { id: string; title: string }[] };
  expect(serverBlocks.blocks.find(block => block.id === CONFLICT_ID)?.title).toBe('甲');

  await ctxA.close();
  await ctxB.close();
});

test('场景3：断网写 → 恢复后自动补写同步', async ({ browser }) => {
  const ctx = await browser.newContext();
  const user = await login(ctx);
  const page = await ctx.newPage();
  const pulled = page.waitForResponse(r => isBlocks(r.url()) && r.request().method() === 'GET');
  await page.goto('/');
  expect((await pulled).status()).toBe(200); // 在线完成首次同步

  const syncPosts: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/blocks/sync') && request.method() === 'POST') syncPosts.push(request.url()); });

  // 断网：本地先写（save() 落 scoped storage），引擎排队、不发包
  await ctx.setOffline(true);
  await page.fill('#cap-text', '22:00-22:30 断网复盘');
  await page.press('#cap-text', 'Enter');
  await page.waitForTimeout(800); // 若引擎误发包，此处给足时间暴露
  expect(syncPosts).toHaveLength(0);
  const local = await page.evaluate(key => JSON.parse(window.localStorage.getItem(key) || '{}'), scopedKey(user.id));
  const offlineDraft = (local.drafts as { id: string; title: string }[]).find(d => d.title.includes('断网复盘'));
  expect(offlineDraft).toBeTruthy();
  const serverWhileOffline = await ctx.request.get('/api/blocks', { headers: { 'x-tango-client': 'tango-settings/1' } });
  const beforeRecovery = (await serverWhileOffline.json()) as { blocks: { id: string }[] };
  expect(beforeRecovery.blocks.find(block => block.id === offlineDraft!.id)).toBeUndefined(); // 服务端确实没有

  // 恢复：online 事件 → setOnline(true) → 自动补写（队列里的那条完整上行）
  const recovered = page.waitForResponse(r => r.url().includes('/api/blocks/sync') && r.request().method() === 'POST');
  await ctx.setOffline(false);
  const response = await recovered;
  expect(response.status()).toBe(200);
  const body = response.request().postDataJSON() as { changes: { id: string; block: { title: string; source: string } }[] };
  expect(body.changes).toHaveLength(1);
  expect(body.changes[0].id).toBe(offlineDraft!.id);
  expect(body.changes[0].block.title).toBe(offlineDraft!.title);
  expect(body.changes[0].block.source).toBe('draft');
  expect((await response.json()).applied).toBe(1);
  const serverAfter = await ctx.request.get('/api/blocks', { headers: { 'x-tango-client': 'tango-settings/1' } });
  const after = (await serverAfter.json()) as { blocks: { id: string; title: string }[] };
  expect(after.blocks.find(block => block.id === offlineDraft!.id)?.title).toBe(offlineDraft!.title);

  await ctx.close();
});
