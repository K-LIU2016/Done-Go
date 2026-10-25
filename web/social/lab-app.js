// web/social/lab-app.js — 同频 lab 四屏演示的装配层（原 lab.html 内联模块外移）。
//
// 首屏 JS 纪律（「首屏 JS ≤60KB」按传输字节计）：
// - 静态 import 只有 ① 屏需要的 home.js + contracts.js；② baton、④ poster、
//   引导 onboarding 一律 dynamic import()（IntersectionObserver 懒加载，
//   不可见时也可以从交互直接触发），配合 social-lab 的 gzip + ETag 静态服务。
// - 修复记录：gate「开启同频」此前直发 POST opt-in 绕过引导三屏 —— 现在一律
//   先走 onboarding（服务端另有 ONBOARDING_REQUIRED 硬门禁）；① 屏「加油」
//   此前只做本地标记 —— 现在 GET /shared-events → POST /kudos 真实入库；
//   ③ 屏加圈有了邀请码输入框；传棒链接可用接收方视图打开（PRD §4.8）。

import { createSocialHome } from './home.js';
import { STYLES, FREED_TO_KEYS, aliasBadgeChar, KUDOS_EVENT_LABELS } from './contracts.js';

// ---- 演示词典（场景库标题；用法卡上的标题是场景名，不是任何人的事项标题） ----
const USAGE_TITLES = {
  'meeting-notes': '会议材料 → 重点和待办', 'paper-read': '论文 → 5 个要点',
  'abstract-en': '摘要翻成英文', 'notes-condense': '笔记 → 一页纸',
  'wrong-questions': '错题本整理', 'homework-plan': '作业计划',
  'survey-read': '综述精读', 'long-doc': '长文档速读', 'refs-format': '参考文献格式',
  'ask-doctor': '看懂体检单', 'recipe-plan': '一周菜谱', 'med-schedule': '服药提醒表',
  'quiz-10': '出 10 道题', 'grade-analysis': '成绩分析', 'email-work': '工作邮件',
  'meeting-prep': '会前准备', 'data-summary': '数据清洗小结',
};
const FREED_LABELS = { family: '家人', exercise: '运动', study: '学新东西', rest: '休息', hobby: '爱好', other: '其他' };
const FREED_COLORS = { family: '#E8B04B', exercise: '#3E7B5B', study: '#615CED', rest: '#C9CBC1', hobby: '#C7701F', other: '#8E9086' };

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const badge = (alias) => aliasBadgeChar(alias) || String(alias || '你').slice(-1) || '你';

let currentAccount = null;
let accountMap = new Map();   // id -> {id, alias, label, optIn}
let homeController = null;
const baton = { state: null, targets: [] };

// ---- 懒加载模块（首屏只装 ①；②④和引导按需） ----
const lazy = { baton: null, poster: null, onboarding: null };
const loadBaton = async () => (lazy.baton || (lazy.baton = await import('./baton.js')));
const loadPoster = async () => (lazy.poster || (lazy.poster = await import('./poster.js')));
const loadOnboarding = async () => (lazy.onboarding || (lazy.onboarding = await import('./onboarding.js')));

function log(method, path, status, note) {
  const item = document.createElement('li');
  item.innerHTML = '<span class="' + (status >= 400 ? 'bad' : 'ok') + '">' + status + '</span> ' + esc(method + ' ' + path) + (note ? ' — ' + esc(note) : '');
  const list = $('lab-log-list');
  list.insertBefore(item, list.firstChild);
  while (list.children.length > 40) list.removeChild(list.lastChild);
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (currentAccount) headers['x-lab-account'] = currentAccount;
  const started = performance.now();
  const res = await fetch(path, { ...options, headers });
  log(options.method || 'GET', path, res.status, Math.round(performance.now() - started) + 'ms');
  return res;
}
async function apiJson(path, options = {}) {
  const res = await api(path, options);
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { res, body };
}
const post = (path, payload) => apiJson(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload || {}),
});

const aliasOf = (id) => (accountMap.get(id) && accountMap.get(id).alias) || id;
const colorOf = (id) => {
  const entry = accountMap.get(id);
  if (entry) {
    const state = entry.state;
    if (state && state.avatarColor) return state.avatarColor;
  }
  let hash = 0;
  for (const ch of String(id)) hash = ((hash * 31) + ch.charCodeAt(0)) >>> 0;
  return STYLES[hash % STYLES.length].color;
};

// ===========================================================================
// ① 同频首页
// ===========================================================================
async function giveKudos(view) {
  // PRD §4.3：只能对【本人确认分享后】的事件加油 —— 从可加油面找 TA 的分享。
  const { res, body } = await apiJson('/api/social/shared-events');
  const events = (res.status === 200 && body && body.events) || [];
  const mine = events.filter((event) => event.ownerAlias === view.alias);
  if (!mine.length) {
    log('♥', '同频加油', 404, view.alias + ' 还没有确认分享的事件（隐私设计：事件只在本人确认分享后出现）');
    return;
  }
  const target = mine[0];
  const { res: sent, body: out } = await post('/api/social/kudos', { eventKind: target.kind, sharedEventId: target.id });
  log('♥', 'POST /api/social/kudos', sent.status, sent.status === 200
    ? '给 ' + view.alias + ' 的「' + ((body && body.kinds && body.kinds[target.kind]) || KUDOS_EVENT_LABELS[target.kind] || target.kind) + '」加油'
    : (out && out.error) || '');
  refresh3();
}

function mountHome() {
  homeController = createSocialHome({
    usageTitles: USAGE_TITLES,
    onKudos: (view) => { giveKudos(view); },
    onPair: async (view) => {
      const target = [...accountMap.entries()].find(([, entry]) => entry.alias === view.alias);
      if (!target) { log('✗', '结为搭档', 404, '示例账号清单里没有 ' + view.alias); return; }
      const { res, body } = await post('/api/social/pairs', { with: target[0] });
      if (res.status === 200) refresh3();
      else log('✗', 'POST /api/social/pairs', res.status, body && body.error);
    },
    onShare: () => { $('p4-redraw').scrollIntoView({ behavior: 'smooth', block: 'center' }); draw4(); },
    onInvite: () => log('✉', '邀请同学加入，一起找同频', 200, '冷启动不造假人（D4）'),
  });
  homeController.mount($('p1'));
}

function openOnboarding() {
  // 「开启同频」唯一入口：引导三屏（PRD §5 —— 开启前一屏讲清楚会分享什么）。
  const host = $('lab-onb-host');
  loadOnboarding().then(({ createOnboarding }) => {
    const onboarding = createOnboarding({
      storage: null,
      onOptIn: async () => {
        if (currentAccount) {
          await post('/api/social/onboarding-seen');
          const { res, body } = await post('/api/social/opt-in', { enabled: true, minor: false });
          log('◇', '引导完成 → opt-in', res.status, res.status === 200 ? '' : (body && body.error));
          if (res.status === 200) refresh();
        }
        host.classList.remove('show');
      },
      onDone: (payload) => {
        // 看过「会分享什么」之后再退出才标记 seen（与 onboarding.js 同口径）。
        if (currentAccount && payload && payload.stepId && payload.stepId !== 'what') post('/api/social/onboarding-seen');
        host.classList.remove('show');
      },
    });
    onboarding.reset();
    onboarding.mount(host);
    host.classList.add('show');
    host.onclick = (event) => { if (event.target === host) host.classList.remove('show'); };
    log('◇', '首次引导 3 屏（S8）', 200, '开启前先讲清楚会分享什么');
  });
}

async function refresh1(state, card, matches, pairsCount) {
  if (!state || !state.optIn) {
    const alias = currentAccount ? aliasOf(currentAccount) : '';
    homeController.update({
      me: { alias },
      styleCard: null,
      matches: [],
      myGraduations: 0,
      pairsCount: 0,
    });
    const gate = document.createElement('div');
    gate.className = 'pending';
    gate.style.marginTop = '14px';
    gate.innerHTML = '同频还未开启。开启前会先看「会分享什么」引导，'
      + '然后 <button type="button" class="share" id="p1-optin" style="margin-top:10px">开启同频</button>';
    $('p1').appendChild(gate);
    gate.querySelector('#p1-optin').addEventListener('click', openOnboarding);
    return;
  }
  homeController.update({
    me: { alias: state.alias || '' },
    styleCard: card && card.styleCard,
    matches: matches || [],
    myGraduations: card ? card.graduations : 0,
    pairsCount,
    usageTitles: USAGE_TITLES,
  });
}

// ===========================================================================
// ② 传棒（弹层只在手机屏内 absolute；可关闭，点用法卡重开；链接可打开接收方视图）
// ===========================================================================
const DEMO_USAGE = {
  usageId: 'meeting-notes',
  scenarioTitle: USAGE_TITLES['meeting-notes'],
  promptTemplate: '把会议内容交给 AI，先要「重点、待办、没说清的地方」。附带提示词，不含你的任何内容。',
};

function renderUsageBackground() {
  $('p2-usage').innerHTML = '<h1>我的用法</h1>'
    + Object.entries(USAGE_TITLES).slice(0, 6).map(([id, title]) => '<div class="u" data-open-sheet="' + esc(id) + '"><b>' + esc(title) + '</b><small>#' + esc(id) + ' · 点这里「传给 TA」</small></div>').join('');
}

let p2Seen = false; // ② 屏首次可见才装载 baton 模块并绘弹层（首屏 JS 纪律）

async function paintBatonSheet() {
  const { sendSheetView, initialSendState } = await loadBaton();
  if (!baton.state) baton.state = initialSendState(baton.targets);
  $('p2-sheet').innerHTML = sendSheetView(baton.state, {
    card: { usageId: DEMO_USAGE.usageId, scenarioTitle: DEMO_USAGE.scenarioTitle, promptTemplate: DEMO_USAGE.promptTemplate },
    chain: ['demo-you', 'demo-lake'].map((id) => ({ alias: aliasOf(id), avatarColor: colorOf(id) })),
    targets: baton.targets,
  });
}

function closeBatonSheet() {
  baton.state = null; // 下次重开时按目标清单重置
  $('p2-sheet').innerHTML = '';
}

async function openReceiver(batonId) {
  // PRD §4.8 邀请增长环：打开即试用、材料只进本机提示词、试完再引导注册。
  const { res, body } = await apiJson('/api/social/baton/' + batonId);
  if (res.status !== 200 || !body || !body.card) { log('✗', 'GET /api/social/baton/' + batonId, res.status, body && body.error); return; }
  const { mountReceiver } = await loadBaton();
  closeBatonSheet();
  mountReceiver($('p2-sheet'), {
    card: body.card,
    chain: body.chain || [],
    batonId,
    viewerAccount: currentAccount || null,
    onOpened: () => log('◉', '接收方打开传棒链接', 200, 'opened 事件已由 GET 路由记录'),
    onRelayComplete: async () => {
      const { res: done, body: out } = await post('/api/social/baton/' + batonId + '/event', { kind: 'relay-completed' });
      log('✓', 'POST relay-completed', done.status, done.status === 200 ? '完成接力（发送者传棒 +1）' : (out && out.error));
      refresh3();
    },
    onRegister: () => log('✉', '试好了？登录后保存你学会的用法', 200, '增长环（PRD §4.8）'),
  });
  log('◉', '接收方视图（baton.js mountReceiver）', 200, '访客可用，材料只进本机');
}

function renderBatonSheet(pairs, circles) {
  const targets = [];
  for (const pair of pairs || []) {
    const other = pair.a === currentAccount ? pair.b : pair.a;
    targets.push({ id: other, kind: 'pair', alias: aliasOf(other), avatarColor: colorOf(other) });
  }
  for (const circle of circles || []) targets.push({ id: circle.id, kind: 'circle', alias: circle.name, avatarColor: '#3E7B5B' });
  baton.targets = targets;
  baton.state = null; // 目标变了，重置选择
  if (p2Seen) paintBatonSheet(); // ② 还不可见时先不装载模块，等 IntersectionObserver
}

$('p2-usage').addEventListener('click', (event) => {
  const node = event.target.closest('[data-open-sheet]');
  if (!node) return;
  p2Seen = true; // 交互即装载（点击本身说明 ② 已可见）
  paintBatonSheet(); // 点用法卡重开发送弹层
});

$('p2-sheet').addEventListener('click', async (event) => {
  const node = event.target.closest('[data-target],[data-link],[data-send],[data-close],[data-relay-done],[data-try-copy],[data-register]');
  if (!node) return;
  const { selectSendTarget, selectSendLink, sendButtonLabel } = await loadBaton();
  if (node.dataset.close != null) { closeBatonSheet(); return; }
  if (node.dataset.target) { baton.state = selectSendTarget(baton.state, node.dataset.target, baton.targets); paintBatonSheet(); return; }
  if (node.dataset.link != null) { baton.state = selectSendLink(baton.state); paintBatonSheet(); return; }
  if (node.dataset.send != null) {
    const card = { usageId: DEMO_USAGE.usageId, scenarioTitle: DEMO_USAGE.scenarioTitle, promptTemplate: DEMO_USAGE.promptTemplate };
    const payload = baton.state.linkMode || !baton.state.targetId
      ? { targetKind: 'link', targetId: null, card }
      : (() => {
        const target = baton.targets.find((t) => t.id === baton.state.targetId);
        return { targetKind: target ? target.kind : 'link', targetId: target ? target.id : null, card };
      })();
    const { res, body } = await post('/api/social/baton', payload);
    const result = $('p2-result');
    result.hidden = false;
    if (res.status === 200) {
      const label = sendButtonLabel(baton.state, baton.targets);
      result.innerHTML = '✓ 已发出（' + esc(label) + '）。用法卡 id <code>' + esc(body.id) + '</code>';
      if (payload.targetKind === 'link') {
        result.innerHTML += ' <button type="button" class="p2-open" data-receiver="' + esc(body.id) + '">打开接收方视图（PRD §4.8）</button>';
      }
      const opened = await apiJson('/api/social/baton/' + body.id);
      if (opened.res.status === 200) {
        result.innerHTML += '<br>传递链（≤5 跳，D6；出库即化名）：'
          + (opened.body.chain || []).map((hop) => esc(hop.alias)).join(' → ');
      }
    } else {
      result.innerHTML = '✗ 发出失败：' + esc(body && body.error || res.status) + '（未开启同频会返回 SOCIAL_OPT_IN_REQUIRED）';
    }
  }
});

$('p2-result').addEventListener('click', (event) => {
  const node = event.target.closest('[data-receiver]');
  if (node) openReceiver(node.dataset.receiver);
});

// ===========================================================================
// ③ 搭档 / 圈 / 挑战
// ===========================================================================
function render3(pairs, circles, circleHome, quests, kudos) {
  let html = '<div class="sec"><h3>接力搭档</h3><span>每天各接力 1 次 · 最多 5 位</span></div>';
  if (!pairs || !pairs.length) {
    html += '<p class="sub">还没有搭档——在 ① 的推荐卡上点「结为搭档」。</p>';
  } else {
    for (const pair of pairs) {
      const other = pair.a === currentAccount ? pair.b : pair.a;
      const cold = pair.flame === 0;
      html += '<div class="pairrow"><span class="av" style="background:' + colorOf(other) + '">' + esc(badge(aliasOf(other))) + '</span>'
        + '<div><b>' + esc(aliasOf(other)) + '</b><div class="st">火苗 ' + pair.flame + ' · 本周冻结 ' + pair.freezesUsed + '/1 · <u>提醒一下</u></div></div>'
        + '<span class="flame' + (cold ? ' cold' : '') + '"><i></i>' + pair.flame + '</span></div>';
    }
  }
  html += '<div class="sec"><h3>我的圈</h3><span>邀请码加入</span></div>';
  if (!circles || !circles.length) {
    html += '<div class="circlejoin"><input id="p3-invite" placeholder="输入邀请码（示例圈 DEMO2026）" autocomplete="off">'
      + '<button type="button" id="p3-join">加入</button></div>';
  } else {
    const circle = circles[0];
    html += '<div class="circlecard"><h4>' + esc(circle.name) + ' <span>' + (circle.memberCount || 0) + ' 人 · ' + esc(aliasOf(circle.owner)) + ' 的圈</span></h4>';
    if (circleHome) {
      html += '<div class="wall">' + (circleHome.wall || []).map((w) => '<span>' + esc(USAGE_TITLES[w.usageId] || w.usageId) + ' ×' + w.count + '</span>').join('') + '</div>';
      if (circleHome.freedTo) {
        html += '<div class="freed"><p style="font-size:12.5px;font-weight:600;margin:12px 0 6px">大家空出来的时间去了哪（只显示占比）</p><div class="bar">'
          + FREED_TO_KEYS.filter((k) => circleHome.freedTo[k] > 0).map((k) => '<i style="flex:' + Math.round(circleHome.freedTo[k] * 100) + ';background:' + FREED_COLORS[k] + '"></i>').join('')
          + '</div><div class="lg">' + FREED_TO_KEYS.filter((k) => circleHome.freedTo[k] > 0).map((k) => '<span><i style="background:' + FREED_COLORS[k] + '"></i>' + FREED_LABELS[k] + ' ' + Math.round(circleHome.freedTo[k] * 100) + '%</span>').join('') + '</div></div>';
      }
      if (circleHome.chain && circleHome.chain.length) {
        html += '<div class="chainline">' + circleHome.chain.map((hop) => '<span class="av s" style="background:' + esc(hop.avatarColor || colorOf(hop.alias)) + '">' + esc(badge(hop.alias)) + '</span>').join('<span class="arr">→</span>') + '<span>传棒经过了 ' + circleHome.chain.length + ' 个人</span></div>';
      }
      if (circleHome.rank) {
        html += '<div class="rank">'
          + circleHome.rank.top.map((entry) => '<div><b>' + entry.rank + '</b>' + esc(entry.alias) + '<em>传棒 ' + entry.batons + '</em></div>').join('');
        if (circleHome.rank.you) html += '<div class="you"><b>' + circleHome.rank.you.rank + '</b>你<em>传棒 ' + circleHome.rank.you.batons + '</em></div>';
        html += '</div>';
      }
    }
    html += '</div>';
  }
  html += '<div class="sec"><h3>本周挑战</h3><span>每周 3 个</span></div>';
  for (const item of quests || []) {
    const quest = item.quest; const progress = item.progress;
    const pct = Math.min(100, Math.round((progress.progress / quest.target) * 100));
    html += '<div class="questrow">' + esc(quest.title)
      + '<div class="prog"><i style="width:' + pct + '%"></i></div>'
      + (progress.done ? '✓' : progress.progress + '/' + quest.target)
      + '<button type="button" data-too-much="' + esc(quest.id) + '" style="font-size:11px;color:#8E9086;text-decoration:underline;background:none;border:0;cursor:pointer">太多了</button>'
      + '</div>';
  }
  html += '<p class="kudosline">收到的加油：' + ((kudos && kudos.kudos) || []).length + ' 次（只统计本人确认分享的事件）</p>';
  $('p3').innerHTML = html;
  $('p3').querySelectorAll('[data-too-much]').forEach((button) => {
    button.addEventListener('click', async () => {
      const { res, body } = await post('/api/social/quests/' + button.dataset.tooMuch + '/feedback', { type: 'too-much' });
      log('☺', 'POST /api/social/quests/…/feedback', res.status, body && body.error);
    });
  });
  const join = $('p3-join');
  if (join) join.addEventListener('click', async () => {
    const code = ($('p3-invite').value || '').trim();
    if (!code) return;
    const { res, body } = await post('/api/social/circles/join', { inviteCode: code });
    log('◉', 'POST /api/social/circles/join', res.status, res.status === 200 ? '已加入 ' + (body && body.circle && body.circle.name) : (body && body.error));
    if (res.status === 200) refresh();
  });
}

async function refresh3() {
  if (!currentAccount) return;
  const pairsQ = apiJson('/api/social/pairs');
  const circlesQ = apiJson('/api/social/circles');
  const questsQ = apiJson('/api/social/quests');
  const kudosQ = apiJson('/api/social/kudos');
  const [pairsR, circlesR, questsR, kudosR] = await Promise.all([pairsQ, circlesQ, questsQ, kudosQ]);
  let circleHome = null;
  if (circlesR.res.status === 200 && circlesR.body.circles && circlesR.body.circles.length) {
    const id = circlesR.body.circles[0].id;
    const home = await apiJson('/api/social/circles/' + id);
    if (home.res.status === 200) circleHome = home.body;
  }
  const gated = pairsR.res.status === 403 || circlesR.res.status === 403;
  if (gated) {
    render3([], [], null, [], { kudos: [] });
    $('p3').insertAdjacentHTML('afterbegin', '<p class="pending">同频未开启——搭档、圈与挑战都需要先 opt-in（见 ①）。</p>');
    return;
  }
  render3(
    pairsR.res.status === 200 ? pairsR.body.pairs : [],
    circlesR.res.status === 200 ? circlesR.body.circles : [],
    circleHome,
    questsR.res.status === 200 ? questsR.body.quests : [],
    kudosR.res.status === 200 ? kudosR.body : { kudos: [] },
  );
  renderBatonSheet(pairsR.body ? pairsR.body.pairs : [], circlesR.body ? circlesR.body.circles : []);
}

// ===========================================================================
// ④ 分享图（poster.js 懒加载：首次可见才装）
// ===========================================================================
let posterData = null;
let posterSeen = false;
let posterPending = false;

async function draw4() {
  if (!posterSeen) { posterPending = true; return; }
  const canvas = $('p4-canvas');
  if (!posterData || !posterData.styleCard) {
    canvas.hidden = true;
    $('p4-empty').hidden = false;
    $('p4-download').style.display = 'none';
    return;
  }
  const { drawPoster, exportPosterDataURL } = await loadPoster();
  canvas.hidden = false;
  $('p4-empty').hidden = true;
  $('p4-download').style.display = '';
  const ok = drawPoster(canvas, { styleCard: posterData.styleCard, facts: posterData.facts });
  if (ok) {
    const url = exportPosterDataURL(canvas);
    if (url) $('p4-download').href = url;
  }
  log('🖼', 'drawPoster', ok ? 200 : 500, '1080×1920 PNG');
}
$('p4-redraw').addEventListener('click', draw4);

function posterBecameVisible() {
  if (posterSeen) return;
  posterSeen = true;
  if (posterPending) { posterPending = false; draw4(); }
}

// ===========================================================================
// 账号切换 + 总刷新 + 启动
// ===========================================================================
async function refresh() {
  if (!currentAccount) return;
  const stateQ = apiJson('/api/social/state');
  const cardQ = apiJson('/api/social/lab/style-card');
  const matchesQ = apiJson('/api/social/matches');
  const [stateR, cardR, matchesR] = await Promise.all([stateQ, cardQ, matchesQ]);
  const state = stateR.res.status === 200 ? stateR.body : null;
  const card = cardR.res.status === 200 ? cardR.body : null;
  const matches = matchesR.res.status === 200 ? matchesR.body : { matches: [] };
  posterData = card;
  $('p4-brand').textContent = '探戈 Done&Go · 第 ' + ((card && card.week) || '').replace(/^\d{4}-W/, '') + ' 周';

  let pairsCount = 0;
  if (state && state.optIn) {
    const pairs = await apiJson('/api/social/pairs');
    if (pairs.res.status === 200) pairsCount = pairs.body.pairs.length;
  }
  refresh1(state, card, matches.matches || [], pairsCount);
  refresh3();
  draw4();
}

async function loadAccounts() {
  const { res, body } = await apiJson('/api/social/lab/accounts');
  if (res.status !== 200) { log('✗', 'GET /api/social/lab/accounts', res.status); return; }
  $('lab-week').textContent = '第 ' + body.week.replace(/^\d{4}-W/, '') + ' 周 · ' + body.week
    + (body.demoSeeded ? ' · 示例用户已标记「·示例」' : ' · 未 seed（启动加 --seed-demo）');
  accountMap = new Map(body.accounts.map((entry) => [entry.id, entry]));
  const select = $('lab-account');
  select.innerHTML = body.accounts.map((entry) => '<option value="' + esc(entry.id) + '">' + esc(entry.alias) + '（' + esc(entry.id) + (entry.optIn ? '' : ' · 未开启') + '）</option>').join('')
    || '<option value="">（无示例账号）</option>';
  const saved = localStorage.getItem('lab-account');
  if (saved && accountMap.has(saved)) select.value = saved;
  currentAccount = accountMap.has(select.value) ? select.value : body.accounts.length ? body.accounts[0].id : null;
  if (currentAccount) select.value = currentAccount;
}

$('lab-account').addEventListener('change', (event) => {
  currentAccount = event.target.value || null;
  if (currentAccount) localStorage.setItem('lab-account', currentAccount);
  refresh();
});

// 首次引导 3 屏（onboarding.js 懒加载；内存态，不写 storage）
$('lab-onb').addEventListener('click', openOnboarding);

// ===========================================================================
// 启动：① 立即装；②③④ 按可见性懒加载（IntersectionObserver，无 IO 则立即装）
// ===========================================================================
mountHome();
renderUsageBackground();
loadAccounts().then(refresh);

function observeVisible(id, onShown) {
  const node = $(id);
  if (!node) return;
  if (typeof IntersectionObserver !== 'function') { onShown(); return; }
  const io = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) { io.disconnect(); onShown(); }
  }, { rootMargin: '0px' }); // 不预载视口外的屏（首屏 JS 门槛按传输字节计）
  io.observe(node);
}
observeVisible('p2-sheet', () => { p2Seen = true; paintBatonSheet(); });
observeVisible('p4-canvas', posterBecameVisible);

// 传棒深链：#/social/baton/<id> 直接进接收方视图（PRD §4.8 增长环）。
const deep = /^#\/social\/baton\/([\w-]+)$/.exec(location.hash || '');
if (deep) openReceiver(deep[1]);
