// tests/social/social-lab.spec.ts — 同频（社交游戏化）第一期验收 E2E（SO验收工）。
//
// 【收敛令】验收只保留主路径与失败态；删除级联断言保留（D2 隐私硬门槛验收）。
// 周挑战进度（questPlan/「太多了」反馈）不在本验收范围（unit 已覆盖），已删。
//
// 验收对象：scripts/social-lab.mjs 装配的 lab（--seed-demo 示例账号，端口段
// 17560–17569）+ web/social/lab.html 四屏 + /api/social/*（social-service）。
//
// 主路径（任务书原文顺序，桌面+手机双 project 各走一遍）：
//   开启(opt-in) → 流派卡 → 同频推荐 → 加油 → 结为搭档 → A 传棒给 B →
//   B 完成接力 → A 传棒数+1 → B 入圈（邀请码） →
//   【删除我的数据】并断言级联清零与随后接口不可见。
//
// 账号映射（lab 示例账号，全部带 demo- 前缀 + 化名「·示例」标记，红线 D4）：
//   A = demo-you（今晚的风·示例 · 深夜创作派 · 示例圈圈主）
//   B = demo-relay（认真的溪·示例 · 接力达人派 · 圈外，graduations=5 落在
//       A 的「略多一点」窗口 [2, 2×2+2]=[2,6] 内，相似度实测 0.5186 排第 2）
//   旁观校验：demo-lake（安静的湖·示例，A 的种子搭档 + 圈友）。
//
// 「开启(opt-in)」走法说明：PRD §5 允许随时关闭 —— 第 1 步先用正式接口把 A
// 关闭（POST /opt-in {enabled:false}），再从 ① 屏门禁完整走「首次引导 3 屏」
// 重新开启（onboarding-seen → opt-in，服务端另有 ONBOARDING_REQUIRED 硬门禁）。
// 这是 lab 里唯一能用【带画像】账号真实走完 opt-in 路径并继续走到流派卡/
// 推荐的方式（demo-new 无画像，开启后到不了流派卡与推荐）。
//
// 传棒两步的走法说明（对 lab 懒加载设计的适配，见 so-accept 证据「发现」节）：
// - ② 屏弹层由 IntersectionObserver 首次可见时绘制（首屏 JS 纪律），且
//   #p2-sheet（absolute inset:0）永远盖住用法卡 —— 「点用法卡重开」在 lab
//   外壳里点不到。统一用 scrollIntoViewIfNeeded 让 ② 进入视口触发 observer。
// - 「A 传棒给 B」走 pair 途（chips 直选 demo-relay）；「B 完成接力」用
//   PRD §4.4 三途中的「生成链接」+ §4.8 接收方视图：A 发链接棒 → 切换到
//   B → 从 A 会话残留的结果面板打开接收方视图（此时 currentAccount=B 已
//   确定性就位，viewerAccount=B）。深链 #/social/baton/* 在冷加载存在
//   currentAccount 竞态与懒加载重绘覆盖两个问题（证据「发现」节记录，
//   待 CTO 裁决是否修 lab-app.js），故走页内入口。
//
// 运行：flock -w 1800 /home/jc/.local/share/argus/heavy.lock nice -n 19 \
//   npx playwright test --config tests/social/social.config.ts --workers=1
// （desktop 17560 / mobile 17561 两个独立 seed 实例）。本文件被默认
// playwright.config.ts 收录时，因 serve-tango 未挂载 /api/social/*（二期集成）
// 会在 beforeEach 探针处自动 skip，不拖垮其他套件。

import { test, expect, type Page } from '@playwright/test';

const A = 'demo-you';
const B = 'demo-relay';
const LAKE = 'demo-lake';
const ALIAS_A = '今晚的风·示例';
const ALIAS_B = '认真的溪·示例';
const ALIAS_LAKE = '安静的湖·示例';
const DEMO_INVITE_CODE = 'DEMO2026'; // scripts/social-lab.mjs LAB_DEMO_CIRCLE_CODE（示例圈固定邀请码）

// 跨测试串联状态（describe.serial；每个 project 独立实例，测试 0 重置）
let batonId = '';        // A → B 的 pair 途传棒（测试 6）
let circleId = '';
let aBatonsBefore = -1;

async function getJson(page: Page, path: string, account?: string) {
  const res = await page.request.get(path, { headers: account ? { 'x-lab-account': account } : {} });
  let body: any = null;
  try { body = await res.json(); } catch { /* 空响应体 */ }
  return { status: res.status(), body };
}

async function postJson(page: Page, path: string, account: string | null, data?: object) {
  const res = await page.request.post(path, { headers: account ? { 'x-lab-account': account } : {}, data: data ?? {} });
  let body: any = null;
  try { body = await res.json(); } catch { /* 空响应体 */ }
  return { status: res.status(), body };
}

async function switchAccount(page: Page, id: string) {
  await page.locator('#lab-account').selectOption(id);
  await expect(page.locator('#lab-account')).toHaveValue(id);
}

// ② 屏发送弹层：滚动让 ② 进入视口触发 IntersectionObserver 绘制（首屏 JS
// 纪律：不可见不装载 baton.js）。#p2-sheet 盖住用法卡，不能点 .u 唤起。
async function openSendSheet(page: Page) {
  await page.locator('#p2-sheet').scrollIntoViewIfNeeded();
  const sheet = page.locator('[data-baton-sheet]');
  await expect(sheet).toBeVisible();
  return sheet;
}

async function openLab(page: Page, hash = '') {
  await page.goto('/social/lab.html' + hash);
  // lab 的「API 调用日志」是 fixed 定位的调试浮层（右下 320×260，z-30），
  // 在 390px 手机视口会盖住 ①②③ 屏的按钮、拦截 pointer events。它是 lab 的
  // 调试 chrome 而非被测功能面 —— 验收时隐藏，不改变任何 /api/social/* 行为。
  await page.evaluate(() => { const log = document.getElementById('lab-log'); if (log) log.style.display = 'none'; });
}

test.describe.serial('同频 lab 双账号全流程验收（开启→流派卡→推荐→加油→搭档→传棒→接力→入圈→删除）', () => {
  test.beforeEach(async ({ request }) => {
    // 本 spec 只对挂载了 /api/social/* 的 lab 实例有意义；默认 serve-tango
    // （social 集成属二期）上自动 skip。
    const probe = await request.get('/api/social/lab/accounts');
    test.skip(probe.status() !== 200, `同频 lab API 未挂载（HTTP ${probe.status()}）——用 npx playwright test --config tests/social/social.config.ts 运行`);
  });

  test('0 lab 就绪：示例账号标记三件套（D4）+ 演示鉴权 401', async ({ page }) => {
    batonId = '';
    circleId = '';
    aBatonsBefore = -1; // 每个 project 独立实例，重置串联状态
    const { status, body } = await getJson(page, '/api/social/lab/accounts');
    expect(status).toBe(200);
    expect(String(body.week)).toMatch(/^\d{4}-W\d{2}$/);
    expect(Array.isArray(body.accounts)).toBe(true);
    expect(body.accounts.length).toBeGreaterThan(0);
    for (const account of body.accounts) {
      expect(account.id, '标记① id 前缀 demo-').toMatch(/^demo-/);
      expect(account.alias, '标记② 化名后缀 ·示例').toContain('·示例');
      expect(account.demo, '标记③ 账号清单 demo:true').toBe(true);
    }
    const optInFlags = new Map(body.accounts.map((entry: any) => [entry.id, entry.optIn]));
    expect(optInFlags.get(A)).toBe(true); // 种子已开启（有画像）
    expect(optInFlags.get('demo-new')).toBe(false); // 新用户保持未开启（真实冷启动）
    // 演示鉴权：lab 未注册账号一律 401，不回显任何内容
    const stranger = await getJson(page, '/api/social/state', 'not-a-demo-account');
    expect(stranger.status).toBe(401);
    expect(stranger.body).toEqual({ error: 'AUTH_REQUIRED' });
    await openLab(page);
    await expect(page.locator('#lab-week')).toContainText('周');
  });

  test('1 开启(opt-in)：A 关闭后经「首次引导 3 屏」重新开启', async ({ page }) => {
    const off = await postJson(page, '/api/social/opt-in', A, { enabled: false, minor: false });
    expect(off.status).toBe(200);
    expect(off.body.optIn).toBe(false);

    await openLab(page);
    await expect(page.locator('#p1-optin')).toBeVisible(); // ① 屏出现开启门禁
    await page.locator('#p1-optin').click();
    const overlay = page.locator('#lab-onb-host');
    await expect(overlay).toHaveClass(/show/);
    await expect(overlay.locator('.soc-onb-title')).toHaveText('同频是什么'); // 1/3
    await overlay.locator('#soc-onb-primary').click();
    await expect(overlay.locator('.soc-onb-title')).toHaveText('会分享什么'); // 2/3 白名单可视化
    await expect(overlay.locator('.soc-onb-list')).toContainText('永远不会上传：事项标题、材料、AI 结果、具体时间、地点');
    await overlay.locator('#soc-onb-primary').click();
    await expect(overlay.locator('.soc-onb-title')).toHaveText('开启同频'); // 3/3
    await overlay.locator('#soc-onb-primary').click();
    await expect(overlay).not.toHaveClass(/show/);
    // 开启完成：① 屏流派卡出现（画像仍在、未重置），门禁消失
    await expect(page.locator('#p1 .arch h2')).toHaveText('深夜创作派');
    await expect(page.locator('#p1-optin')).toHaveCount(0);
    const state = await getJson(page, '/api/social/state', A);
    expect(state.status).toBe(200);
    expect(state.body.optIn).toBe(true);
  });

  test('2 流派卡：深夜创作派 + 三条本周证据', async ({ page }) => {
    await openLab(page);
    const arch = page.locator('#p1 .arch');
    await expect(arch.locator('h2')).toHaveText('深夜创作派');
    await expect(arch.locator('p')).toContainText('灯熄了，你的想法才刚开始。');
    const evidence = arch.locator('ul li');
    await expect(evidence).toHaveCount(3); // PRD §3.2 每种流派三条证据
    for (let i = 0; i < 3; i += 1) {
      const text = (await evidence.nth(i).textContent()) || '';
      expect(text.trim().length, `证据 ${i + 1} 是可读文本`).toBeGreaterThan(3);
    }
    // API 同源核对：lab/style-card 端点同一张卡（不过判定 → null，不造假卡）
    const card = await getJson(page, '/api/social/lab/style-card', A);
    expect(card.status).toBe(200);
    expect(card.body.styleCard.style).toBe('night-creator');
    expect(card.body.styleCard.evidence).toHaveLength(3);
  });

  test('3 同频推荐：3 张卡（略多一点），B 在列且理由/用法来自真实特征', async ({ page }) => {
    await openLab(page);
    const cards = page.locator('#p1 .match');
    await expect(cards).toHaveCount(3);
    // API 同源核对 + D4 硬边界：对方 graduations ∈ [A 的 2, 2×2+2=6]
    const matches = await getJson(page, '/api/social/matches', A);
    expect(matches.status).toBe(200);
    expect(matches.body.matches).toHaveLength(3);
    for (const match of matches.body.matches) {
      expect(match.theirGraduations).toBeGreaterThanOrEqual(2);
      expect(match.theirGraduations).toBeLessThanOrEqual(6);
      expect(match.reasons.length).toBeGreaterThanOrEqual(1);
      expect(match.reasons.length).toBeLessThanOrEqual(2); // PRD §3.3 最多 2 条
    }
    const bApi = matches.body.matches.find((match: any) => match.alias === ALIAS_B);
    expect(bApi, 'B（认真的溪·示例）必须在 A 的本周推荐里').toBeTruthy();
    expect(bApi.style).toBe('relay-ace');
    const bCard = cards.filter({ hasText: ALIAS_B });
    await expect(bCard).toHaveCount(1);
    await expect(bCard.locator('small')).toContainText('接力达人派');
    await expect(bCard.locator('small')).toContainText('自己做到 5 次');
    await expect(bCard.locator('.sim')).toHaveText(`同频 ${Math.round(bApi.similarity * 100)}%`);
    await expect(bCard.locator('.ahead')).toContainText('TA 比你多做到 3 次'); // 5-2=3
    await expect(bCard.locator('.why b').first()).toBeVisible(); // 同频理由（真实特征生成）
    await expect(bCard.locator('.uses span')).toHaveCount(2); // TA 最近学会的 2 个用法
    await expect(bCard.locator('.uses span').first()).toHaveText('出 10 道题');
    await expect(bCard.locator('[data-kudos]')).toBeEnabled();
    await expect(bCard.locator('[data-pair]')).toBeEnabled();
  });

  test('4 加油：一键真实入库（A → 种子搭档/圈友「安静的湖」）', async ({ page }) => {
    // PRD §4.3：只能对【搭档或圈友】确认分享过的事件加油 —— 结为搭档之前的
    // B（圈外）事件按隐私设计不可加油，故此步打给 A 现有搭档 demo-lake。
    await openLab(page);
    await page.locator(`[data-kudos="${ALIAS_LAKE}"]`).click();
    await expect(page.locator('#p1 .soc-note')).toContainText(`已给 ${ALIAS_LAKE} 加油`);
    await expect(async () => {
      const kudos = await getJson(page, '/api/social/kudos', LAKE);
      expect(kudos.status).toBe(200);
      expect(kudos.body.kudos.some((row: any) => row.fromAlias === ALIAS_A && row.eventKind === 'usage-learned')).toBe(true);
    }).toPass();
  });

  test('5 结为搭档：A × B 真实入库（第 2 位搭档）+ 圈/传棒数基线', async ({ page }) => {
    await openLab(page);
    await page.locator(`[data-pair="${ALIAS_B}"]`).click();
    const row = page.locator('#p3 .pairrow').filter({ hasText: ALIAS_B });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('火苗 0');
    const pairs = await getJson(page, '/api/social/pairs', A);
    expect(pairs.status).toBe(200);
    expect(pairs.body.pairs).toHaveLength(2); // 种子搭档 demo-lake + 新搭档 B
    expect(pairs.body.pairs.some((pair: any) => (pair.a === A && pair.b === B) || (pair.a === B && pair.b === A))).toBe(true);
    const circles = await getJson(page, '/api/social/circles', A);
    expect(circles.status).toBe(200);
    circleId = circles.body.circles[0].id;
    expect(circles.body.circles[0].owner).toBe(A); // A 是示例圈圈主（删除步骤验证继承）
    expect(circles.body.circles[0].memberCount).toBe(4); // you/lake/pine/dawn
    // 传棒数基线：种子棒 bs-demo-pair（demo-you→demo-lake）已被完成接力 → 1
    const home = await getJson(page, `/api/social/circles/${circleId}`, A);
    expect(home.status).toBe(200);
    const aRow = [...(home.body.rank?.top || []), home.body.rank?.you].filter((row: any) => row && row.alias === ALIAS_A);
    expect(aRow).toHaveLength(1);
    aBatonsBefore = aRow[0].batons;
    expect(aBatonsBefore).toBe(1);
  });

  test('6 A 传棒给 B（pair 途）：发送弹层、三字段白名单（D6）、真实 bs 落库', async ({ page }) => {
    await openLab(page);
    const sheet = await openSendSheet(page);
    await expect(sheet).toContainText('会议材料 → 重点和待办'); // 场景标题（场景库，非个人事项）
    await expect(sheet).toContainText('对方只看到用法和提示词'); // 隐私说明
    await sheet.locator(`.pk[data-target="${B}"]`).click(); // 直接传给搭档 B
    await sheet.locator('[data-send]').click();
    const result = page.locator('#p2-result');
    await expect(result).toBeVisible();
    await expect(result).toContainText('已发出');
    const code = await result.locator('code').textContent();
    batonId = ((code || '').trim().match(/bs-[\w-]+/) || [''])[0];
    expect(batonId).toMatch(/^bs-/);
    // D6 白名单：卡恰好 {usageId, scenarioTitle, promptTemplate} 三键
    const opened = await getJson(page, `/api/social/baton/${batonId}`);
    expect(opened.status).toBe(200);
    expect(Object.keys(opened.body.card).sort()).toEqual(['promptTemplate', 'scenarioTitle', 'usageId']);
    expect(opened.body.card.usageId).toBe('meeting-notes');
    // 链出库即化名：含发送者 A 的化名
    expect(opened.body.chain.map((hop: any) => hop.alias)).toContain(ALIAS_A);
    // 失败态：发送者不能自证完成接力（北极星口径：被完成才计数）
    const selfConfirm = await postJson(page, `/api/social/baton/${batonId}/event`, A, { kind: 'relay-completed' });
    expect(selfConfirm.status).toBe(403);
    expect(selfConfirm.body).toEqual({ error: 'BATON_SENDER_CANNOT_CONFIRM' });
    // 失败态：pair 途接收者是 B —— 圈外第三人（demo-mom）不能代确认
    const stranger = await postJson(page, `/api/social/baton/${batonId}/event`, 'demo-mom', { kind: 'relay-completed' });
    expect(stranger.status).toBe(403);
    expect(stranger.body).toEqual({ error: 'BATON_NOT_RECEIVER' });
  });

  test('7 B 完成接力 → A 传棒数 +1（北极星口径：被完成才计数）', async ({ page }) => {
    await openLab(page);
    // A 以「生成链接」途发棒（PRD §4.4 三途之一；§4.8 链接接收方 = 任何
    // 登录同频用户，服务端授权：发送者除外）
    const sheet = await openSendSheet(page);
    await sheet.locator('[data-link]').click();
    await sheet.locator('[data-send]').click();
    const result = page.locator('#p2-result');
    await expect(result).toBeVisible();
    await expect(result).toContainText('已发出');
    const code = await result.locator('code').textContent();
    const linkBatonId = ((code || '').trim().match(/bs-[\w-]+/) || [''])[0];
    expect(linkBatonId).toMatch(/^bs-/);
    await expect(result.locator('[data-receiver]')).toBeVisible(); // 打开接收方视图入口
    // 切到 B；等切换触发的 ② 屏重绘落地（弹层目标变成 B 的搭档 = A），
    // 之后打开接收方视图不会再被发送弹层重绘覆盖
    await switchAccount(page, B);
    const sheetAfterSwitch = page.locator('[data-baton-sheet]');
    await expect(sheetAfterSwitch.locator(`.pk[data-target="${A}"]`)).toBeVisible();
    // B 以接收方视图打开（viewerAccount=B 确定性就位；深链冷加载竞态见证据「发现」节）
    await page.locator('[data-receiver]').click();
    const receive = page.locator('[data-baton-receive]');
    await expect(receive).toBeVisible();
    // 隐藏 A 会话残留的发送结果浮层（z-7 会遮挡 B 的接收方视图；B 的设备上
    // 本就不存在这块浮层 —— 只动 lab 调试外壳，不动 /api/social/* 行为）
    await page.evaluate(() => { const node = document.getElementById('p2-result'); if (node) node.hidden = true; });
    await expect(receive).toContainText('有人传给你一个用法');
    await expect(receive).toContainText('会议材料 → 重点和待办'); // 场景库标题，非个人事项
    await receive.locator('[data-try-copy]').click(); // 打开即试用（PRD §4.8）
    await expect(receive.locator('[data-relay-done]')).toBeVisible(); // 试过之后才出现完成入口
    await receive.locator('[data-relay-done]').click();
    await expect(page.locator('#lab-log')).toContainText('完成接力');
    // 化名链上出现 B（opened + relay-completed 事件）
    const opened = await getJson(page, `/api/social/baton/${linkBatonId}`);
    expect(opened.status).toBe(200);
    expect(opened.body.chain.map((hop: any) => hop.alias)).toContain(ALIAS_B);
    // A 的圈内传棒数 +1（圈内排名只按传棒/毕业，D5）
    const home = await getJson(page, `/api/social/circles/${circleId}`, A);
    const aRow = [...(home.body.rank?.top || []), home.body.rank?.you].filter((row: any) => row && row.alias === ALIAS_A);
    expect(aRow[0].batons).toBe(aBatonsBefore + 1);
    // UI：切回 A，③ 屏圈内排名显示「传棒 2」
    await switchAccount(page, A);
    await expect(page.locator('#p3 .rank')).toContainText('传棒 2');
  });

  test('8 B 入圈（邀请码）', async ({ page }) => {
    await openLab(page);
    await switchAccount(page, B);
    const input = page.locator('#p3-invite');
    await expect(input).toBeVisible();
    await input.fill(DEMO_INVITE_CODE);
    await page.locator('#p3-join').click();
    const circleCard = page.locator('#p3 .circlecard');
    await expect(circleCard).toContainText('示例课题组');
    await expect(circleCard).toContainText('5 人');
    const circles = await getJson(page, '/api/social/circles', B);
    expect(circles.status).toBe(200);
    expect(circles.body.circles).toHaveLength(1);
    expect(circles.body.circles[0].id).toBe(circleId);
    expect(circles.body.circles[0].memberCount).toBe(5);
  });

  test('9 【删除我的数据】A：级联清零 + 随后所有接口不可见（D2 硬门槛）', async ({ page }) => {
    // 删除前的可见基线
    const pairsBefore = await getJson(page, '/api/social/pairs', B);
    expect(pairsBefore.status).toBe(200);
    expect(pairsBefore.body.pairs).toHaveLength(1); // B 只有与 A 的搭档
    const kudosBefore = await getJson(page, '/api/social/kudos', LAKE);
    expect(kudosBefore.body.kudos).toHaveLength(1); // A 的加油还在
    // 删除
    const del = await postJson(page, '/api/social/delete-me', A, {});
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ deleted: true });
    // A 自己：状态清零（画像/化名全删），同频功能随即 403
    const state = await getJson(page, '/api/social/state', A);
    expect(state.body).toMatchObject({ optIn: false, alias: null });
    const card = await getJson(page, '/api/social/lab/style-card', A);
    expect(card.body.styleCard).toBe(null);
    for (const path of ['/api/social/pairs', '/api/social/circles', '/api/social/quests', '/api/social/matches']) {
      const gated = await getJson(page, path, A);
      expect(gated.status, path).toBe(403);
      expect(gated.body).toEqual({ error: 'SOCIAL_OPT_IN_REQUIRED' });
    }
    // B 视角：搭档关系消失、圈人数回落、推荐与响应全文都没有 A
    const pairsAfter = await getJson(page, '/api/social/pairs', B);
    expect(pairsAfter.body.pairs).toHaveLength(0);
    const circlesB = await getJson(page, '/api/social/circles', B);
    expect(circlesB.status).toBe(200);
    expect(circlesB.body.circles[0].memberCount).toBe(4);
    const matchesB = await getJson(page, '/api/social/matches', B);
    expect(matchesB.status).toBe(200);
    expect(JSON.stringify(matchesB.body)).not.toContain(ALIAS_A);
    expect(JSON.stringify(matchesB.body)).not.toContain('demo-you'); // 原始 account id 永不出服务
    // 旁观者（安静的湖）：A 的加油被级联删除；圈内不再有 A；圈主位继承
    const kudosAfter = await getJson(page, '/api/social/kudos', LAKE);
    expect(kudosAfter.body.kudos).toHaveLength(0);
    const homeLake = await getJson(page, `/api/social/circles/${circleId}`, LAKE);
    expect(homeLake.status).toBe(200);
    expect(JSON.stringify(homeLake.body)).not.toContain(ALIAS_A);
    expect(homeLake.body.circle.owner).toBe(LAKE); // 圈主继承给最早加入的成员
    // A 发出的传棒整体不可见
    const baton = await getJson(page, `/api/social/baton/${batonId}`);
    expect(baton.status).toBe(404);
    expect(baton.body).toEqual({ error: 'BATON_NOT_FOUND' });
  });

  test('10 【删除我的数据】B：级联清零收尾', async ({ page }) => {
    const del = await postJson(page, '/api/social/delete-me', B, {});
    expect(del.status).toBe(200);
    const state = await getJson(page, '/api/social/state', B);
    expect(state.body).toMatchObject({ optIn: false, alias: null });
    const gated = await getJson(page, '/api/social/circles', B);
    expect(gated.status).toBe(403);
    const lakeCircles = await getJson(page, '/api/social/circles', LAKE);
    expect(lakeCircles.status).toBe(200);
    expect(lakeCircles.body.circles[0].memberCount).toBe(3); // 4 - B
    const homeLake = await getJson(page, `/api/social/circles/${circleId}`, LAKE);
    expect(JSON.stringify(homeLake.body)).not.toContain(ALIAS_B);
  });
});
