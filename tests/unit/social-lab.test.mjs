import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// SO·S9实验入口 line: scripts/social-lab.mjs + web/social/lab.html。
// 装配冒烟（本线交付口径）：起/停、端点存在、seed 标记字段、演示鉴权边界。
//
// 硬门槛在此证明：
// - 装配：createSocialLabServer 组合 createTangoServer（scripts/serve-tango.mjs）
//   + createSocialService（scripts/social-service.mjs）+ createSocialStore
//   （scripts/social-store.mjs）+ S2 引擎 matcher，/api/social/* 可用、静态
//   /social/lab.html 可用，close() 干净停机。
// - D4/红线：--seed-demo 的示例用户【必须带标记】（demo- 前缀 id + 化名含
//   「·示例」+ lab/accounts 里 demo:true），且【默认不 seed】——生产路径
//   （serve-tango.mjs / start-local-auth.mjs）源码不含 social-lab 引用。
// - 演示鉴权：只有 lab 注册的示例账号可通过 x-lab-account 切换；未知账号
//   401；访客只能走 guest 路由（preview / 打开传棒链接）。

import {
  createSocialLabServer,
  seedDemoUsers,
  LAB_ACCOUNT_HEADER,
  LAB_DEMO_PREFIX,
  LAB_DEMO_ALIAS_MARK,
} from '../../scripts/social-lab.mjs';
import {
  MATCHES_PER_WEEK,
  validateMatch,
  validateStyleCard,
  validateCircleRankView,
  isSlightlyAhead,
} from '../../web/social/contracts.js';
import { POSTER_FACT_KINDS } from '../../web/social/poster.js';

const here = fileURLToPath(import.meta.url);

async function startLab(options = {}) {
  const lab = createSocialLabServer({ seedDemo: true, ...options });
  await new Promise((resolve) => lab.server.listen(0, '127.0.0.1', resolve));
  const { port } = lab.server.address();
  return { lab, base: 'http://127.0.0.1:' + port };
}

function as(account) {
  return account ? { [LAB_ACCOUNT_HEADER]: account } : {};
}

async function json(res) {
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  return res.json();
}

test('起/停冒烟：lab server 可启动、应答、干净关闭', async () => {
  const { lab, base } = await startLab();
  try {
    const res = await fetch(base + '/api/social/preview');
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.blurred, true);
  } finally {
    await lab.close();
  }
  // 停机后端口不再应答（起/停的“停”侧证据）。
  await assert.rejects(() => fetch(base + '/api/social/preview'), /ECONNREFUSED|fetch failed/);
});

test('端点存在：preview 是访客可用的模糊预览', async () => {
  const { lab, base } = await startLab();
  try {
    const body = await json(await fetch(base + '/api/social/preview'));
    assert.equal(body.styles.length, 6);
    assert.equal(typeof body.inviteText, 'string');
    assert.ok(body.version >= 1);
  } finally { await lab.close(); }
});

test('端点存在：state 无演示账号 401，示例账号 200', async () => {
  const { lab, base } = await startLab();
  try {
    const anonymous = await fetch(base + '/api/social/state');
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).error, 'AUTH_REQUIRED');

    const res = await fetch(base + '/api/social/state', { headers: as('demo-you') });
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.optIn, true);
    assert.ok(body.alias.includes(LAB_DEMO_ALIAS_MARK));
  } finally { await lab.close(); }
});

test('端点存在：matches 输出过契约校验且守住「略多一点」', async () => {
  const { lab, base } = await startLab();
  try {
    const res = await fetch(base + '/api/social/matches', { headers: as('demo-you') });
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.ok(Array.isArray(body.matches));
    assert.ok(body.matches.length >= 1 && body.matches.length <= MATCHES_PER_WEEK);
    for (const rec of body.matches) {
      const valid = validateMatch(rec, { myGraduations: 2 });
      assert.ok(valid, 'match 必须过 validateMatch：' + JSON.stringify(rec));
      assert.ok(isSlightlyAhead(2, rec.theirGraduations), '推荐必须「略多一点」');
    }
  } finally { await lab.close(); }
});

test('端点存在：pairs / circles / 圈主页 / quests / kudos 全部应答', async () => {
  const { lab, base } = await startLab();
  try {
    const pairs = await json(await fetch(base + '/api/social/pairs', { headers: as('demo-you') }));
    assert.equal(pairs.pairs.length, 1);
    assert.equal(pairs.pairs[0].flame, 12);

    const circles = await json(await fetch(base + '/api/social/circles', { headers: as('demo-you') }));
    assert.equal(circles.circles.length, 1);
    const circleId = circles.circles[0].id;
    assert.equal(circles.circles[0].memberCount, 4);

    const home = await json(await fetch(base + '/api/social/circles/' + circleId, { headers: as('demo-you') }));
    assert.ok(Array.isArray(home.wall) && home.wall.length > 0);
    assert.equal(home.rank.top.length <= 3, true);
    assert.ok(validateCircleRankView({ top: home.rank.top, you: home.rank.you }));

    const quests = await json(await fetch(base + '/api/social/quests', { headers: as('demo-you') }));
    assert.equal(quests.quests.length, 3);
    assert.equal(quests.quests[0].progress.done, true);
    assert.equal(quests.quests[1].progress.progress, 30);

    const kudos = await json(await fetch(base + '/api/social/kudos', { headers: as('demo-you') }));
    assert.equal(kudos.kudos.length, 1);
  } finally { await lab.close(); }
});

test('端点存在：lab 专用端点（账号清单 + 流派卡）', async () => {
  const { lab, base } = await startLab();
  try {
    const accounts = await json(await fetch(base + '/api/social/lab/accounts'));
    assert.equal(accounts.demoSeeded, true);
    assert.ok(accounts.accounts.length >= 5);

    const card = await json(await fetch(base + '/api/social/lab/style-card', { headers: as('demo-you') }));
    assert.ok(validateStyleCard(card.styleCard));
    assert.equal(card.styleCard.style, 'night-creator'); // 原型①主视角
    assert.ok(Array.isArray(card.facts) && card.facts.length >= 1);
    for (const fact of card.facts) assert.ok(POSTER_FACT_KINDS.includes(fact.kind));

    const fresh = await json(await fetch(base + '/api/social/lab/style-card', { headers: as('demo-new') }));
    assert.equal(fresh.styleCard, null); // 未开启/无画像 → 不造假卡
  } finally { await lab.close(); }
});

test('端点存在：静态 lab.html 经 createTangoServer 服务', async () => {
  const { lab, base } = await startLab();
  try {
    const res = await fetch(base + '/social/lab.html');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.ok(html.includes('同频') && html.includes('lab'), 'lab.html 内容空缺');
  } finally { await lab.close(); }
});

test('端点存在：传棒发出与访客打开链接', async () => {
  const { lab, base } = await startLab();
  try {
    const sent = await json(await fetch(base + '/api/social/baton', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...as('demo-you') },
      body: JSON.stringify({
        targetKind: 'link',
        targetId: null,
        card: { usageId: 'meeting-notes', scenarioTitle: '会议材料 → 重点和待办', promptTemplate: '请从下面的会议内容里整理：重点、待办、没说清的地方。' },
      }),
    }));
    assert.ok(sent.id);
    assert.equal(sent.card.usageId, 'meeting-notes');

    const opened = await json(await fetch(base + '/api/social/baton/' + sent.id)); // 无鉴权（访客）
    assert.equal(opened.card.usageId, 'meeting-notes');
    assert.ok(Array.isArray(opened.chain) && opened.chain.length <= 5);
    // 隐私红线：链出库即化名（{alias, avatarColor}），原始 account id 不出服务
    for (const hop of opened.chain) {
      assert.equal(typeof hop.alias, 'string');
      assert.ok(/^[#][0-9A-Fa-f]{6}$/.test(hop.avatarColor));
    }
    assert.ok(!JSON.stringify(opened.chain).includes('demo-you'), 'raw demo ids must not leak');
  } finally { await lab.close(); }
});

test('端点存在：kudos 端到端 —— GET /shared-events 化名可见，POST /kudos 新形状入库', async () => {
  const { lab, base } = await startLab();
  try {
    const listed = await json(await fetch(base + '/api/social/shared-events', { headers: as('demo-you') }));
    assert.ok(Array.isArray(listed.events) && listed.events.length >= 1, '搭档/圈友的确认分享事件可见');
    for (const event of listed.events) {
      assert.equal(typeof event.ownerAlias, 'string');
      assert.ok(event.ownerAlias.includes(LAB_DEMO_ALIAS_MARK), '示例账号化名带标记：' + event.ownerAlias);
    }
    assert.ok(!JSON.stringify(listed).match(/"owner"/), '不回原始 account id');
    const peer = listed.events[0];
    const cheer = await fetch(base + '/api/social/kudos', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...as('demo-you') },
      body: JSON.stringify({ eventKind: peer.kind, sharedEventId: peer.id }),
    });
    assert.equal(cheer.status, 200);
  } finally { await lab.close(); }
});

test('lab 静态资产：gzip 压缩 + ETag 304（首屏 JS 门槛按传输字节计）', async () => {
  const { lab, base } = await startLab();
  try {
    const plain = await fetch(base + '/social/home.js', { headers: { 'accept-encoding': 'identity' } }); // fetch 默认会带 gzip，显式 identity 才能拿原始字节
    assert.equal(plain.status, 200);
    assert.match(plain.headers.get('content-type'), /javascript/);
    assert.equal(plain.headers.get('content-encoding'), null, 'identity request must not be gzipped');
    assert.ok(plain.headers.get('etag'));
    const gz = await fetch(base + '/social/home.js', { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(gz.status, 200);
    assert.equal(gz.headers.get('content-encoding'), 'gzip');
    const rawLength = Number(plain.headers.get('content-length'));
    const packedLength = Number(gz.headers.get('content-length'));
    assert.ok(packedLength < rawLength, 'gzip transfer smaller than raw: ' + packedLength + ' < ' + rawLength);
    const etag = gz.headers.get('etag');
    const revalidate = await fetch(base + '/social/home.js', { headers: { 'if-none-match': etag } });
    assert.equal(revalidate.status, 304, 'ETag revalidation returns 304');
    const missing = await fetch(base + '/social/../package.json');
    assert.ok(missing.status === 404 || missing.status === 400, 'path traversal not served');
  } finally { await lab.close(); }
});

test('seed 标记字段：示例用户 id 前缀 demo-、化名带「·示例」、demo:true', async () => {
  const { lab, base } = await startLab();
  try {
    const accounts = await json(await fetch(base + '/api/social/lab/accounts'));
    for (const account of accounts.accounts) {
      assert.ok(account.id.startsWith(LAB_DEMO_PREFIX), 'id 必须带 demo- 前缀：' + account.id);
      assert.equal(account.demo, true, 'demo 标记必须为 true');
      assert.ok(account.alias.includes(LAB_DEMO_ALIAS_MARK), '化名必须含「' + LAB_DEMO_ALIAS_MARK + '」：' + account.alias);
    }
    const seeded = lab.seedState();
    for (const account of seeded.accounts) {
      assert.equal(account.demo, true);
      assert.ok(account.id.startsWith(LAB_DEMO_PREFIX));
    }
  } finally { await lab.close(); }
});

test('seed 关闭：默认不生成任何示例用户（生产纪律）', async () => {
  const lab = createSocialLabServer({}); // 未传 seedDemo
  await new Promise((resolve) => lab.server.listen(0, '127.0.0.1', resolve));
  const { port } = lab.server.address();
  const base = 'http://127.0.0.1:' + port;
  try {
    const body = await json(await fetch(base + '/api/social/lab/accounts'));
    assert.equal(body.demoSeeded, false);
    assert.equal(body.accounts.length, 0);
    assert.equal(lab.store.tableCounts().social_accounts, 0);
  } finally { await lab.close(); }
});

test('生产路径无 seed 分支：serve-tango / start-local-auth 不引用 social-lab', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  for (const file of ['scripts/serve-tango.mjs', 'scripts/start-local-auth.mjs']) {
    const source = await readFile(root + file, 'utf8');
    assert.ok(!source.includes('social-lab'), file + ' 不得引用 social-lab（生产路径无 seed 分支）');
  }
});

test('演示鉴权：未知账号 401；未开启账号 matches 403 后可 opt-in', async () => {
  const { lab, base } = await startLab();
  try {
    const intruder = await fetch(base + '/api/social/state', { headers: as('mallory') });
    assert.equal(intruder.status, 401);

    const gated = await fetch(base + '/api/social/matches', { headers: as('demo-new') });
    assert.equal(gated.status, 403);
    assert.equal((await gated.json()).error, 'SOCIAL_OPT_IN_REQUIRED');

    const direct = await fetch(base + '/api/social/opt-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...as('demo-new') },
      body: JSON.stringify({ enabled: true, minor: false }),
    });
    assert.equal(direct.status, 403, 'PRD §5：未看过「会分享什么」不能开启（ONBOARDING_REQUIRED）');
    const seen = await fetch(base + '/api/social/onboarding-seen', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...as('demo-new') },
      body: JSON.stringify({}),
    });
    assert.equal(seen.status, 200);
    const enabled = await fetch(base + '/api/social/opt-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...as('demo-new') },
      body: JSON.stringify({ enabled: true, minor: false }),
    });
    assert.equal(enabled.status, 200);
    assert.equal((await enabled.json()).optIn, true);
  } finally { await lab.close(); }
});

test('seedDemoUsers 幂等：重复执行不重复造数据', async () => {
  const lab = createSocialLabServer({ seedDemo: true });
  try {
    const before = lab.store.tableCounts();
    const seeded = lab.seedState();
    seedDemoUsers(lab.store, { week: seeded.week });
    const after = lab.store.tableCounts();
    assert.deepEqual(after, before);
  } finally { await lab.close(); }
});
