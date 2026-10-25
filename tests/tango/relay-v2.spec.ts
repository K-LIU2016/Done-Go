// tests/tango/relay-v2.spec.ts — AI 接力 v2 验收（SPEC design/relay-v2/SPEC.md）。
//
// 桌面 + 手机双 project 下，访客（不登录，D5）走完主路径：
//   开始 → 场景卡 → 匹配 → 流式结果 → 编辑 → 自评 → 接力棒复制 → 我做到了
//   → 我的用法里能看到；
// 外加五类失败态（§4⑧：unconfigured/timeout/ratelimit/upstream/format，每类
// 都必须带接力棒，D4）与停止按钮（§4③）。
//
// 上游：本地 stub 网关 127.0.0.1:17549（零费用），app 临时实例 17540 经
// TANGO_AI_URL 指向它。timeout/upstream/format/正常流/route 升级走真实全链
// 路（浏览器 → serve-tango → ai-assistant → stub）；unconfigured 与 ratelimit
// 是 app 层前置拒绝（aiGuard/配置检查发生在调上游之前，且 app 会把一切上游
// HTTP 失败归一为 ai-upstream-failed，stub 无法触达这两类），按 serve-tango
// aiFailure 的线上 wire 形状在 /api 边界回放（与 v1 ai-relay.spec.ts 的
// config mock 同一惯例）。行为标记（STUB_*）随材料原样进入上游 prompt。
//
// 运行（worktree 根）：
//   stub: node /tmp/rv2-accept/stub-gateway.mjs   （17549）
//   TANGO_PORT=17540 TANGO_AI_PROVIDER=openai \
//   TANGO_AI_URL=http://127.0.0.1:17549/v1/chat/completions \
//   TANGO_AI_MODEL=stub-relay-model TANGO_AI_KEY=stub-local-key \
//   TANGO_AI_TIMEOUT_MS=8000 TANGO_AI_VISITOR_DAILY_LIMIT=200 \
//   TANGO_REUSE_SERVER=1 npx playwright test --config playwright.tango.config.ts \
//   --workers=1 tests/tango/relay-v2.spec.ts
import { test, expect } from '@playwright/test';

// 全部用例都是访客：不带登录 cookie / 账号 storage（D5）。
test.use({ storageState: { cookies: [], origins: [] } });
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const MATERIAL = '讨论了本周上线安排，张三负责测试，周五前反馈。';
const MATERIAL_SLOW = '会议内容 STUB_SLOW：讨论了本周上线安排，张三负责测试。';
const MATERIAL_TIMEOUT = '会议内容 STUB_TIMEOUT：讨论了本周上线安排。';
const MATERIAL_UPSTREAM = '会议内容 STUB_UPSTREAM：讨论了本周上线安排。';
const MATERIAL_FORMAT = '会议内容 STUB_FORMAT：讨论了本周上线安排。';

async function openStart(page: import('@playwright/test').Page) {
  await page.route('https://**', route => route.abort()); // 绝不触网：接力棒只验证到 window.open 调用
  await page.goto('/#/start');
  await expect(page.locator('#relay-home-input')).toBeVisible();
}

async function enterViaSceneCard(page: import('@playwright/test').Page) {
  await page.locator('.scene[data-scene="meeting-notes"]').click();
  await expect(page.locator('#relay-flow-match')).toBeVisible();
}

// §4⑧ 公共断言：失败标题 + 不是你的问题 + 内容还在 + 接力棒（D4）。
async function expectFailShell(page: import('@playwright/test').Page, reason: string, timeout = 5000) {
  const fail = page.locator('#relay-flow-fail');
  await expect(fail).toBeVisible({ timeout }); // 超时用例要等满 app 侧 8s 预算，由调用方放宽
  await expect(fail.locator('h2')).toHaveText('AI 这次没接上');
  await expect(fail.locator('.lead')).toContainText(reason);
  await expect(fail.locator('.lead')).toContainText('不是你的问题');
  await expect(fail.locator('.keep')).toContainText('你填的内容都还在');
  await expect(fail.locator('[data-flow-baton]')).toBeVisible();
  await expect(fail.locator('[data-flow-baton] [data-flow-copy-open]')).toContainText('复制并打开豆包');
}

test('guest full relay: scene card → match → stream → edit → rate → baton copy → graduate → passport', async ({ page }) => {
  await openStart(page);
  // 访客身份徽标（§2）与首屏要件
  await expect(page.locator('.guest[data-badge-kind="guest"]')).toHaveText('访客');
  await expect(page.locator('#rv2-start h1')).toContainText('今天要做什么？');
  await expect(page.locator('#rv2-start .grid .scene')).toHaveCount(6);
  await expect(page.locator('#rv2-start .empty')).toContainText('完成第一次接力');

  await enterViaSceneCard(page);
  const match = page.locator('#relay-flow-match');
  await expect(match.locator('h2')).toHaveText('整理会议纪要');
  await expect(match.locator('.evt')).toContainText('整理组会纪要');
  await expect(match.locator('.does span').first()).toContainText('列出重点');
  await expect(match.locator('.privacy')).toContainText('发给 AI 处理');
  await expect(page.locator('[data-flow-submit]')).toBeDisabled(); // 空材料置灰（§4②）
  await page.locator('[data-flow-material]').fill(MATERIAL);
  await expect(page.locator('[data-flow-submit]')).toBeEnabled();
  await page.locator('[data-flow-submit]').click();

  // 流式（§4③）：计时 + 停止按钮 + 首帧边收边渲染（.out 出现时仍在 running）
  await expect(page.locator('#relay-flow-running')).toBeVisible();
  await expect(page.locator('[data-flow-timer]')).toContainText('已用');
  await expect(page.locator('[data-flow-stop]')).toBeVisible();
  await expect(page.locator('#relay-flow-running .out')).toBeVisible();
  await expect(page.locator('#relay-flow-running')).toBeVisible();

  // 结果页（§4④）
  const result = page.locator('#relay-flow-result');
  await expect(result).toBeVisible({ timeout: 8000 });
  await expect(result.locator('.ai-tag')).toHaveText('AI 生成 · 请你核对');
  await expect(result.locator('[data-flow-result-text]')).toContainText('会议重点');
  await expect(result.locator('[data-flow-result-text]')).toContainText('张三负责测试');
  await expect(result.locator('[data-flow-result-text]')).toContainText('没说清的地方');
  await expect(result.locator('.learned b')).toContainText('把会议材料交给 AI');
  await expect(result.locator('.tweak .chip')).toHaveCount(3);
  // D3：结果页不出现任何分钟数
  await expect(result).not.toContainText('分钟');
  // 访客提示条（§4④ D5）
  await expect(page.locator('[data-flow-nudge]')).toContainText('已存到这台设备');
  await expect(page.locator('[data-flow-login]')).toBeVisible();

  // 编辑（contenteditable，编辑结果参与保存）
  await page.locator('[data-flow-edit]').click();
  await page.keyboard.type('补充：已同步老板。');

  // 自评：三档之一（§1.5）
  await page.locator('[data-flow-rate="much"]').click();
  await expect(page.locator('[data-flow-rate="much"]')).toHaveClass(/on/);

  // 接力棒：默认豆包 → 切 DeepSeek → 复制并打开（先复制，再新标签打开）
  await expect(page.locator('[data-flow-copy-open]')).toContainText('复制并打开豆包');
  await page.locator('[data-flow-app="deepseek"]').click();
  await expect(page.locator('[data-flow-copy-open]')).toContainText('复制并打开DeepSeek');
  await page.evaluate(() => {
    const w = window as unknown as { __opened: string[]; open: (...args: unknown[]) => Window | null };
    w.__opened = [];
    const original = w.open.bind(window);
    w.open = (...args: unknown[]) => { w.__opened.push(String(args[0])); return original(...args); };
  });
  await page.locator('[data-flow-copy-open]').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('请把下面的会议内容整理成三部分');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened))
    .toEqual(['https://chat.deepseek.com/']);

  // 我做到了（毕业）→ #/me 高亮该用法
  await page.locator('[data-flow-graduate]').click();
  await expect(page).toHaveURL(/#\/me/);
  const skill = page.locator('#relay-skill-meeting-notes');
  await expect(skill).toBeVisible();
  await expect(skill).toHaveClass(/hl/);
  await expect(skill.locator('b')).toHaveText('整理会议纪要');
  const statValues = page.locator('#rv2-me .stats .stat b');
  await expect(statValues).toHaveText(['1', '1', '1']); // 学会 1 / 接力 1 / 自己做到 1
  const row = page.locator('.row[data-record-id]').first();
  await expect(row.locator('.e')).toHaveText('😀');
  await expect(row).toContainText('整理组会纪要');
  await expect(row.locator('.grad')).toHaveText('自己做到');

  // 点开记录：只读 + 编辑后的结果可复制（§4⑤）
  await row.click();
  const detail = page.locator('#rv2-me .card');
  await expect(detail.locator('.evt')).toContainText('只读');
  await expect(detail.locator('.out')).toContainText('补充：已同步老板。');
  await expect(detail.locator('[data-copy-result]')).toBeVisible();

  // 本机落盘（§5.4）：v2 库、guest 裸键、无 estimatedSavedMinutes（D3）
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('tango-donego.relay.v2') || 'null'));
  expect(saved?.v).toBe(2);
  expect(saved?.records).toHaveLength(1);
  const record = saved?.records[0];
  expect(record).toMatchObject({
    event: '整理组会纪要', usageId: 'meeting-notes', rating: 'much',
    graduated: true, graduatedApp: 'deepseek', failed: null, // 毕业记录跟随所选 app（本用例先切到 DeepSeek）
  });
  expect(String(record.result)).toContain('补充：已同步老板。');
  expect(JSON.stringify(saved)).not.toContain('estimatedSavedMinutes');
});

test('keyword match from the start input lands on the right usage with alternatives', async ({ page }) => {
  await openStart(page);
  await page.locator('#relay-home-input').fill('帮我整理今天的会议纪要');
  await page.locator('#relay-home-go').click();
  const match = page.locator('#relay-flow-match');
  await expect(match).toBeVisible();
  await expect(match.locator('h2')).toHaveText('整理会议纪要'); // 本地关键词匹配（matcher.js，置信度 0.73 不升 route）
  await expect(match.locator('.evt')).toContainText('帮我整理今天的会议纪要');
  await expect(page.locator('[data-flow-alt="paper-read"]')).toBeVisible();
  await expect(page.locator('[data-flow-alt="advisor-mail"]')).toBeVisible();
  await page.locator('[data-flow-alt="paper-read"]').click(); // 换成备选用法（§4②）
  await expect(match.locator('h2')).toHaveText('读懂一篇论文');
  await page.locator('[data-flow-back]').click(); // ‹ 换一件事
  await expect(page.locator('#relay-home-input')).toBeVisible();
});

test('low-confidence event escalates to mode:route and adopts the routed usage', async ({ page }) => {
  await openStart(page);
  await page.locator('#relay-home-input').fill('帮我把这个搞定'); // 无关键词命中 → 升级 route（D7）
  await page.locator('#relay-home-go').click();
  const match = page.locator('#relay-flow-match');
  await expect(match).toBeVisible();
  // stub 的 route 答案是 advisor-mail（本地 top1 是 paper-read）：标题证明走了 route
  await expect(match.locator('h2')).toHaveText('给导师写邮件');
  await expect(match.locator('.evt')).toContainText('帮我把这个搞定');
  await expect(page.locator('[data-flow-alt="meeting-notes"]')).toBeVisible();
  await expect(page.locator('[data-flow-alt="paper-read"]')).toBeVisible();
});

test('stop button aborts the stream and keeps the material', async ({ page }) => {
  await openStart(page);
  await enterViaSceneCard(page);
  await page.locator('[data-flow-material]').fill(MATERIAL_SLOW);
  await page.locator('[data-flow-submit]').click();
  await expect(page.locator('#relay-flow-running')).toBeVisible();
  await expect(page.locator('#relay-flow-running .out')).toBeVisible(); // 已见首帧再停
  await page.locator('[data-flow-stop]').click();
  const match = page.locator('#relay-flow-match');
  await expect(match).toBeVisible(); // 回到 ②，材料保留（§4③）
  await expect(match.locator('[data-flow-material]')).toHaveValue(MATERIAL_SLOW);
  await expect(match.locator('[data-flow-material]')).toBeFocused();
  await expect(page.locator('#relay-flow-running')).toHaveCount(0);
});

test('failure: timeout shows the 60s copy, retry and baton', async ({ page }) => {
  await openStart(page);
  await enterViaSceneCard(page);
  await page.locator('[data-flow-material]').fill(MATERIAL_TIMEOUT);
  await page.locator('[data-flow-submit]').click();
  await expect(page.locator('#relay-flow-running .skel').first()).toBeVisible(); // 一帧未到（骨架两行，取其一）
  await expectFailShell(page, '它想得太久了（超过 60 秒）', 12000); // app 侧 8s 预算触发 ai-timeout
  await expect(page.locator('[data-flow-retry]')).toBeVisible();
});

test('failure: upstream error shows busy copy, retry and baton', async ({ page }) => {
  await openStart(page);
  await enterViaSceneCard(page);
  await page.locator('[data-flow-material]').fill(MATERIAL_UPSTREAM);
  await page.locator('[data-flow-submit]').click();
  await expectFailShell(page, 'AI 服务这会儿忙');
  await expect(page.locator('[data-flow-retry]')).toBeVisible();
});

test('failure: unparseable stream shows format copy and retry re-runs', async ({ page }) => {
  await openStart(page);
  await enterViaSceneCard(page);
  await page.locator('[data-flow-material]').fill(MATERIAL_FORMAT);
  await page.locator('[data-flow-submit]').click();
  await expectFailShell(page, 'AI 回答乱了，再试一次'); // 末帧 sanitizeRelayResult 校验失败（D6）
  await page.locator('[data-flow-retry]').click();
  await expect(page.locator('#relay-flow-running')).toBeVisible();
  await expectFailShell(page, 'AI 回答乱了，再试一次'); // 同一材料仍乱文：再次失败仍是该态
});

test('failure: assistant not configured shows unconfigured copy and baton', async ({ page }) => {
  await openStart(page);
  // /api 边界回放真实 wire 形状（serve-tango aiFailure / configuration()）：
  // 配置不可用时 GET /api/assistant/config → {available:false,...}
  await page.route('**/api/assistant/config', route => route.fulfill({
    json: { available: false, provider: null, model: null, destination: null },
  }));
  await enterViaSceneCard(page);
  await page.locator('[data-flow-material]').fill(MATERIAL);
  await page.locator('[data-flow-submit]').click();
  await expectFailShell(page, 'AI 暂时没开，先自己接力试试');
  await expect(page.locator('[data-flow-retry]')).toBeVisible();
});

test('failure: rate limit shows daily copy, no retry button, baton stays', async ({ page }) => {
  await openStart(page);
  // /api 边界回放真实 wire 形状：aiGuard TANGO_AI_RATE_LIMITED → 429 {error:'ai-rate-limited'}
  await page.route('**/api/assistant/chat', route => route.fulfill({
    status: 429,
    json: { error: 'ai-rate-limited', message: '访问过于频繁，请稍后再试' },
  }));
  await enterViaSceneCard(page);
  await page.locator('[data-flow-material]').fill(MATERIAL);
  await page.locator('[data-flow-submit]').click();
  await expectFailShell(page, '今天的体验次数用完了，明天再来');
  await expect(page.locator('[data-flow-retry]')).toHaveCount(0); // 限流不显示再试一次（§4⑧）
});
