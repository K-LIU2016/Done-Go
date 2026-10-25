// scripts/social-lab.mjs — 同频（社交游戏化）S9 实验入口（lab）。
// PRD design/social-sync/PRD.md §7（serve-tango 集成属二期；本期 lab 独立装配）。
//
// 交付（本线任务书）：
//   1. import createTangoServer（scripts/serve-tango.mjs）并把 /api/social/*
//      挂到同一端口 —— lab wrapper 先截获 lab 专用端点，其余 /api/social/*
//      交给 createSocialService（scripts/social-service.mjs），非 social 请求
//      原样转发给 tango（静态 web/ 服务由此而来，/social/lab.html 可直接打开）。
//   2. 演示鉴权：多个示例账号经 x-lab-account 切换，只有 lab 注册的账号可用，
//      未知账号一律 401（service AUTH_REQUIRED）。
//   3. --seed-demo 生成【标记为示例】的用户 —— 仅 lab 启动参数；生产代码路径
//      （serve-tango.mjs / start-local-auth.mjs）不 import 本文件，也没有任何
//      分支会调用 seedDemoUsers（unit 静态 + 行为双证明，红线 D4）。
//      标记三件套：id 前缀 `demo-`、化名含「·示例」、账号清单 demo:true。
//   4. matcher 桥：service 的候选记录接入 S2 引擎（scripts/social-features.mjs
//      findMatches）——「略多一点」+ 相似度 + 同频理由全部由引擎产生，lab
//      不自造推荐。
//
// 纪律：
// - 默认数据库 :memory:（演示不落盘）；--db=<path> 才用文件库（store 自己
//   chmod 600）。lab 绑定 127.0.0.1，不对外。
// - 本文件不改任何其他线的文件；shapes 一律来自 web/social/contracts.js。
// - lab 专用端点只有两个只读视图：GET /api/social/lab/accounts（guest，示例
//   账号清单）、GET /api/social/lab/style-card（鉴权后取本周流派卡 + 海报
//   facts）；其余全部走 service 的正式路由与门禁。

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve, normalize, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { createTangoServer } from './serve-tango.mjs';
import { createSocialStore } from './social-store.mjs';
import { createSocialService, questPlan } from './social-service.mjs';
import { buildStyleCard, findMatches } from './social-features.mjs';
import { STYLES, FREED_TO_KEYS } from '../web/social/contracts.js';

export var LAB_ACCOUNT_HEADER = 'x-lab-account'; // 演示鉴权头：示例账号 id
export var LAB_DEMO_PREFIX = 'demo-';            // 示例账号 id 前缀（标记①）
export var LAB_DEMO_ALIAS_MARK = '·示例';         // 示例账号化名后缀（标记②）
export var LAB_DEMO_ACCOUNTS_FLAG = 'demo';       // 账号清单标记键（标记③，恒 true）

const LAB_DEMO_CIRCLE_ID = 'ci-demo-main';
const LAB_DEMO_CIRCLE_CODE = 'DEMO2026';
const LAB_DEMO_PAIR_ID = 'pr-demo-1';
const LAB_DEMO_BATON_PAIR = 'bs-demo-pair';
const LAB_DEMO_BATON_CIRCLE = 'bs-demo-circle';
const LAB_DEFAULT_PORT = 17560; // 任务书：临时实例端口 17560–17569

// 与 service defaultCurrentWeek 同口径的 ISO 周（UTC，周四定年）。
function isoWeekOf(time) {
  const date = new Date(time);
  const weekday = (date.getUTCDay() + 6) % 7;
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() - weekday + 3);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = 1 + Math.round((thursday.getTime() - yearStart.getTime()) / 604800000);
  return thursday.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}

// 确定性 rng（演示数据可重复；service 生成化名/邀请码共用同一个）。
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// 示例用户定义 — 每人锚定一种流派（判定见 social-features STYLE_THRESHOLD_
// DEFAULTS；determineStyle 按 STYLE_IDS 顺序取第一个 strong）。graduations
// 故意铺在「略多一点」窗口内（demo-you=2 → 对方 ∈ [2,6]），让 matches 有
// 真实推荐。所有账号 id 带 demo- 前缀、化名带「·示例」——标记不可剥离。
// ---------------------------------------------------------------------------
const STYLE_COLOR = new Map(STYLES.map((style) => [style.id, style.color]));

function demoProfile(week, over) {
  return { week, rating: { much: 1, little: 0, none: 0 }, freedMinutesConfirmed: 120, ...over };
}

export const DEMO_USERS = [
  {
    id: 'demo-you', alias: '今晚的风·示例', label: '主视角 · 深夜创作派', style: 'night-creator',
    profile: demoProfile('W', {
      kindMix: { necessary: 0.2, create: 0.45, connect: 0.05, explore: 0.2, restore: 0.05, stillness: 0.05 },
      rhythm: { dawn: 0, morning: 0.05, afternoon: 0.05, evening: 0.3, night: 0.6 },
      usages: ['meeting-notes', 'paper-read', 'abstract-en', 'notes-condense'],
      relays: 9, graduations: 2,
      rating: { much: 2, little: 1, none: 0 },
      freedTo: { family: 0.1, exercise: 0.45, study: 0.2, rest: 0.15, hobby: 0.05, other: 0.05 },
      freedMinutesConfirmed: 180,
    }),
  },
  {
    id: 'demo-lake', alias: '安静的湖·示例', label: '同频人 · 深夜创作派', style: 'night-creator',
    profile: demoProfile('W', {
      kindMix: { necessary: 0.25, create: 0.4, connect: 0.05, explore: 0.15, restore: 0.1, stillness: 0.05 },
      rhythm: { dawn: 0, morning: 0.05, afternoon: 0.1, evening: 0.35, night: 0.5 },
      usages: ['paper-read', 'abstract-en', 'notes-condense'],
      relays: 7, graduations: 3,
      rating: { much: 3, little: 1, none: 0 },
      freedTo: { family: 0.05, exercise: 0.5, study: 0.25, rest: 0.1, hobby: 0.05, other: 0.05 },
      freedMinutesConfirmed: 150,
    }),
  },
  {
    id: 'demo-pine', alias: '远山的松·示例', label: '圈友 · 学术攀登派', style: 'academic-climber',
    profile: demoProfile('W', {
      kindMix: { necessary: 0.15, create: 0.1, connect: 0.05, explore: 0.5, restore: 0.1, stillness: 0.1 },
      rhythm: { dawn: 0, morning: 0.45, afternoon: 0.4, evening: 0.1, night: 0.05 },
      usages: ['paper-read', 'survey-read', 'long-doc', 'refs-format'],
      relays: 6, graduations: 4,
      rating: { much: 4, little: 2, none: 1 },
      freedTo: { family: 0.05, exercise: 0.05, study: 0.6, rest: 0.15, hobby: 0.1, other: 0.05 },
      freedMinutesConfirmed: 200,
    }),
  },
  {
    id: 'demo-dawn', alias: '晨跑的鹿·示例', label: '圈友 · 晨光整理派', style: 'morning-sorter',
    profile: demoProfile('W', {
      kindMix: { necessary: 0.5, create: 0.1, connect: 0.05, explore: 0.15, restore: 0.1, stillness: 0.1 },
      rhythm: { dawn: 0.2, morning: 0.55, afternoon: 0.15, evening: 0.08, night: 0.02 },
      usages: ['meeting-notes', 'notes-condense', 'wrong-questions', 'homework-plan'],
      relays: 5, graduations: 2,
      rating: { much: 1, little: 2, none: 1 },
      freedTo: { family: 0.4, exercise: 0.2, study: 0.2, rest: 0.1, hobby: 0.05, other: 0.05 },
      freedMinutesConfirmed: 120,
    }),
  },
  {
    id: 'demo-mom', alias: '温暖的月·示例', label: '圈外 · 生活慢行派（传给长辈）', style: 'slow-liver',
    profile: demoProfile('W', {
      kindMix: { necessary: 0.4, create: 0.05, connect: 0.2, explore: 0.1, restore: 0.15, stillness: 0.1 },
      rhythm: { dawn: 0.05, morning: 0.6, afternoon: 0.25, evening: 0.1, night: 0 },
      usages: ['ask-doctor', 'recipe-plan', 'med-schedule'],
      relays: 3, graduations: 2,
      rating: { much: 1, little: 0, none: 2 },
      freedTo: { family: 0.5, exercise: 0.1, study: 0.05, rest: 0.3, hobby: 0.05, other: 0 },
      freedMinutesConfirmed: 300,
    }),
  },
  {
    id: 'demo-relay', alias: '认真的溪·示例', label: '圈外 · 接力达人派', style: 'relay-ace',
    profile: demoProfile('W', {
      kindMix: { necessary: 0.3, create: 0.2, connect: 0.1, explore: 0.25, restore: 0.1, stillness: 0.05 },
      rhythm: { dawn: 0.05, morning: 0.3, afternoon: 0.35, evening: 0.2, night: 0.1 },
      usages: ['quiz-10', 'grade-analysis', 'email-work', 'meeting-prep', 'data-summary'],
      relays: 12, graduations: 5,
      rating: { much: 5, little: 3, none: 0 },
      freedTo: { family: 0.15, exercise: 0.25, study: 0.35, rest: 0.15, hobby: 0.05, other: 0.05 },
      freedMinutesConfirmed: 240,
    }),
  },
  {
    id: 'demo-new', alias: '刚来的杉·示例', label: '新用户 · 未开启同频（演示 opt-in 门禁）', style: null,
    profile: null, // 不 optIn、无画像：演示 SOCIAL_OPT_IN_REQUIRED 与首次引导
  },
];

// ---------------------------------------------------------------------------
// seedDemoUsers(store, {week}) — 幂等。只由 --seed-demo / options.seedDemo
// 分支调用；生产路径不存在调用点（红线 D4）。
// ---------------------------------------------------------------------------
export function seedDemoUsers(store, options = {}) {
  if (!store || typeof store.optIn !== 'function') throw new TypeError('seedDemoUsers(store, {week}) 需要一个 social store');
  const week = options.week || isoWeekOf(Date.now());
  const now = options.now || (() => new Date().toISOString());
  const accounts = [];

  for (const user of DEMO_USERS) {
    if (!user.profile) continue; // demo-new 不落库（保持“未开启”的真实状态）
    const state = store.getState(user.id);
    const input = {
      enabled: true,
      minor: false,
      alias: user.alias,
      avatarColor: STYLE_COLOR.get(user.style) || STYLE_COLOR.get('night-creator'),
    };
    store.optIn(user.id, state && state.alias ? { enabled: true, minor: false } : input);
    store.saveProfile(user.id, { ...user.profile, week });
  }

  // 示例圈（邀请码固定，方便口口相传进入演示）：主视角 + 3 位圈友。
  if (!store.getCircle(LAB_DEMO_CIRCLE_ID)) {
    store.createCircle({ id: LAB_DEMO_CIRCLE_ID, name: '示例课题组（演示）', inviteCode: LAB_DEMO_CIRCLE_CODE, owner: 'demo-you' });
  }
  for (const member of ['demo-lake', 'demo-pine', 'demo-dawn']) store.joinCircle(LAB_DEMO_CIRCLE_ID, member);

  // 示例搭档：demo-you × demo-lake，火苗 12（原型 ③）。
  if (store.listPairs('demo-you').length === 0) {
    store.createPair({ id: LAB_DEMO_PAIR_ID, a: 'demo-you', b: 'demo-lake', startedWeek: week, flame: 12, freezesUsed: 0 });
  }

  // 示例传棒 ×2：pair 途（主视角→搭档）+ circle 途（圈友→圈）。
  if (!store.getBatonShare(LAB_DEMO_BATON_PAIR)) {
    store.createBatonShare({
      id: LAB_DEMO_BATON_PAIR, usageId: 'meeting-notes', fromAccount: 'demo-you',
      targetKind: 'pair', targetId: 'demo-lake', // service 语义：pair 途 targetId = 接收者账号
      card: { usageId: 'meeting-notes', scenarioTitle: '会议材料 → 重点和待办', promptTemplate: '把会议内容交给 AI，先要「重点、待办、没说清的地方」。' },
    });
    for (const [kind, by] of [['sent', 'demo-you'], ['opened', 'demo-lake'], ['relay-completed', 'demo-lake']]) {
      store.addBatonEvent({ id: 'be-' + LAB_DEMO_BATON_PAIR + '-' + kind, batonId: LAB_DEMO_BATON_PAIR, kind, at: now(), byAccount: by });
    }
  }
  if (!store.getBatonShare(LAB_DEMO_BATON_CIRCLE)) {
    store.createBatonShare({
      id: LAB_DEMO_BATON_CIRCLE, usageId: 'paper-read', fromAccount: 'demo-pine',
      targetKind: 'circle', targetId: LAB_DEMO_CIRCLE_ID,
      card: { usageId: 'paper-read', scenarioTitle: '论文 → 5 个要点', promptTemplate: '把这篇论文提炼成 5 个要点，每条一句话，最后指出局限。' },
    });
    for (const [kind, by] of [['sent', 'demo-pine'], ['relay-completed', 'demo-dawn']]) {
      store.addBatonEvent({ id: 'be-' + LAB_DEMO_BATON_CIRCLE + '-' + kind, batonId: LAB_DEMO_BATON_CIRCLE, kind, at: now(), byAccount: by });
    }
  }

  // 周挑战：service 同一套确定性 questPlan 落库（进度才有处可写），并给主视角
  // 铺两条真实进度（第 1 条已完成、第 2 条进行到 30/60）。
  for (const quest of questPlan(week)) {
    if (!store.quest(quest.id)) store.addQuest(quest, { circleId: quest.scope === 'circle' ? LAB_DEMO_CIRCLE_ID : null });
  }
  const plan = questPlan(week);
  if (!store.getQuestProgress(plan[0].id, 'demo-you')) {
    store.setQuestProgress({ questId: plan[0].id, scope: plan[0].scope, owner: 'demo-you', progress: plan[0].target, done: true });
  }
  if (!store.getQuestProgress(plan[1].id, 'demo-you')) {
    store.setQuestProgress({ questId: plan[1].id, scope: plan[1].scope, owner: 'demo-you', progress: 30, done: false });
  }

  // 示例分享事件（PRD §4.3「事件只在本人确认分享后出现」）：给示例用户各铺
  // 一条已确认分享的事件，① 屏「加油」端到端可用（GET /shared-events →
  // POST /kudos）。demo-lake 的由下面示例加油顺带创建，不重复铺。
  const DEMO_SHARED_KINDS = {
    'demo-you': 'usage-learned', 'demo-pine': 'self-kept', 'demo-dawn': 'time-given',
    'demo-mom': 'time-given', 'demo-relay': 'self-kept',
  };
  for (const [userId, kind] of Object.entries(DEMO_SHARED_KINDS)) {
    if ((store.listSharedEvents ? store.listSharedEvents(userId) : []).length === 0) store.recordSharedEvent(userId, kind);
  }

  // 示例加油：demo-lake 分享「学会了一个用法」，并给主视角加油一次。
  if (store.listKudos('demo-you').length === 0) {
    const shared = store.recordSharedEvent('demo-lake', 'usage-learned');
    store.addKudos({ from: 'demo-lake', to: 'demo-you', eventKind: 'usage-learned', sharedEventId: shared.id });
  }

  for (const user of DEMO_USERS) {
    const state = store.getState(user.id);
    accounts.push({
      id: user.id,
      alias: (state && state.alias) || user.alias,
      label: user.label,
      [LAB_DEMO_ACCOUNTS_FLAG]: true, // 标记③：清单里恒为 true
      optIn: !!(state && state.optIn),
    });
  }
  return { week, accounts, circleId: LAB_DEMO_CIRCLE_ID, pairId: LAB_DEMO_PAIR_ID };
}

// ---------------------------------------------------------------------------
// 演示鉴权 — 只有 lab 注册（--seed-demo 或显式 options.accounts）的账号能通过
// x-lab-account 切换；其余一律 throw → service 401 AUTH_REQUIRED。
// ---------------------------------------------------------------------------
export function createLabAuth(entries) {
  const known = new Map((Array.isArray(entries) ? entries : []).map((entry) => [entry.id, entry]));
  return {
    authenticate(req) {
      const raw = req && req.headers ? req.headers[LAB_ACCOUNT_HEADER] : undefined;
      const id = String(Array.isArray(raw) ? raw[0] : (raw || '')).trim();
      const entry = known.get(id);
      if (!entry) throw new Error('LAB_ACCOUNT_UNKNOWN');
      return { id: entry.id, [LAB_DEMO_ACCOUNTS_FLAG]: true };
    },
    knows(id) { return known.has(id); },
    size() { return known.size; },
  };
}

// lab/style-card 的 facts（poster ④ 同源）：relays / self-kept / freed 全部来自
// 本人画像的聚合计数。个人传棒数 store 无查询面 —— 不编造，缺省不放该条。
export function labStyleCard(store, account, week) {
  const features = store.getProfile(account, week);
  const card = features ? buildStyleCard(features) : null; // 不过判定 → null，不造假卡
  const facts = [];
  if (features) {
    facts.push({ kind: 'relays', value: features.relays || 0 });
    const rating = features.rating || {};
    facts.push({ kind: 'self-kept', value: (rating.much || 0) + (rating.little || 0) });
    if (features.freedMinutesConfirmed > 0 && features.freedTo) {
      let top = FREED_TO_KEYS[0];
      for (const key of FREED_TO_KEYS) if ((features.freedTo[key] || 0) > (features.freedTo[top] || 0)) top = key;
      facts.push({ kind: 'freed', value: features.freedMinutesConfirmed, freedTo: top });
    }
  }
  return { week, styleCard: card, facts, graduations: features ? features.graduations || 0 : 0 };
}

// ---------------------------------------------------------------------------
// 装配 — lab wrapper。
// ---------------------------------------------------------------------------
export function createSocialLabServer(options = {}) {
  const week = options.week || isoWeekOf(Date.now());
  const ownedStore = !options.store;
  const store = options.store || createSocialStore({ databaseFile: options.databaseFile || ':memory:' });
  const rng = options.rng || mulberry32(20261025);

  let labAccounts = [];
  let seedInfo = { week, accounts: [], circleId: null, demoSeeded: false };
  if (options.seedDemo === true) { // 唯一 seed 入口：显式开启（CLI --seed-demo）
    const seeded = seedDemoUsers(store, { week, rng });
    labAccounts = seeded.accounts;
    seedInfo = { ...seeded, demoSeeded: true };
  } else if (Array.isArray(options.accounts)) {
    labAccounts = options.accounts.filter((entry) => entry && entry.id);
  }

  const auth = options.auth || createLabAuth(labAccounts);
  const matcher = options.matcher || (async ({ account, week: at, allowPublicPool }) => {
    const myProfile = store.getProfile(account, at);
    if (!myProfile) return [];
    const pool = allowPublicPool ? store.poolCandidates(at, { allowMinors: false }) : [];
    const peers = store.circlePeerCandidates(account, at) || [];
    // 屏蔽对一次载入（blocksInvolving）：万级候选下逐候选 blockedBetween 的
    // 1 万次往返是 /matches 最大成本项，O(1) Set 过滤后整段 <1ms。
    const blocked = store.blocksInvolving ? store.blocksInvolving(account) : new Set();
    const seen = new Set([account]);
    const candidates = [];
    for (const hit of [...pool, ...peers]) {
      if (!hit || seen.has(hit.account) || !hit.record) continue;
      seen.add(hit.account);
      if (blocked.has(hit.account)) continue;
      candidates.push({ account: hit.account, alias: hit.record.alias, avatarColor: hit.record.avatarColor, features: hit.record.features });
    }
    return findMatches(myProfile, candidates, { myAccount: account }); // S2 引擎：略多一点 + 相似度 + 理由
  });

  const social = createSocialService({
    store,
    auth,
    matcher,
    rng,
    currentWeek: () => week,
    rateLimits: { write: 240, read: 600, preview: 60, windowMs: 60000 }, // 演示放宽，门禁不变
  });

  const tango = createTangoServer(options.tango || {});
  const tangoHandler = tango.listeners('request')[0]; // createTangoServer 的 request handler（静态 web/ 服务）

  // lab 静态资产（/social/* 与 social 前端的依赖 /relay/*）：lab 在 tango 之前
  // 接手 —— gzip + ETag/304。首屏 JS 门槛（≤60KB）按传输字节计；gzip 后
  // lab-app+home+contracts ≈ 26KB。no-cache（每次带 ETag 重验证）保证换版本
  // 不取陈货，304 时零正文。
  const WEB_ROOT = resolve(fileURLToPath(import.meta.url), '../../web');
  const STATIC_PREFIXES = { '/social/': 'social', '/relay/': 'relay' };
  const SOCIAL_STATIC_TYPES = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };
  const staticCache = new Map(); // path -> { body, gz, etag, type }

  async function serveSocialStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const prefix = Object.keys(STATIC_PREFIXES).find((name) => pathname.startsWith(name));
    if (!prefix || pathname.endsWith('/')) return false;
    const rel = normalize(pathname.slice(prefix.length)).split(sep).join('/');
    if (!rel || rel.startsWith('..') || rel.includes('../')) return false;
    const dirRoot = resolve(WEB_ROOT, STATIC_PREFIXES[prefix]);
    const file = resolve(dirRoot, rel);
    if (!file.startsWith(dirRoot + sep)) return false;
    let entry = staticCache.get(pathname);
    if (!entry) {
      let body;
      try { body = await readFile(file); } catch { return false; }
      const type = SOCIAL_STATIC_TYPES[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream';
      entry = { body, gz: gzipSync(body), etag: '"' + createHash('sha1').update(body).digest('hex').slice(0, 20) + '"', type };
      staticCache.set(pathname, entry);
    }
    if (req.headers['if-none-match'] === entry.etag) {
      res.writeHead(304, { ETag: entry.etag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' });
      res.end();
      return true;
    }
    const canGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    const headers = { 'Content-Type': entry.type, 'Cache-Control': 'no-cache', ETag: entry.etag, Vary: 'Accept-Encoding' };
    if (canGzip) { headers['Content-Encoding'] = 'gzip'; headers['Content-Length'] = entry.gz.length; res.writeHead(200, headers); res.end(req.method === 'HEAD' ? undefined : entry.gz); }
    else { headers['Content-Length'] = entry.body.length; res.writeHead(200, headers); res.end(req.method === 'HEAD' ? undefined : entry.body); }
    return true;
  }

  function accountsView() {
    return {
      lab: true,
      week,
      demoSeeded: seedInfo.demoSeeded,
      header: LAB_ACCOUNT_HEADER,
      accounts: labAccounts.map((entry) => {
        const state = store.getState(entry.id);
        return {
          id: entry.id,
          alias: (state && state.alias) || entry.alias,
          label: entry.label || '',
          [LAB_DEMO_ACCOUNTS_FLAG]: true,
          optIn: !!(state && state.optIn),
        };
      }),
    };
  }

  function sendJson(res, status, value) {
    if (res.destroyed) return;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      .end(JSON.stringify(value));
  }

  // lab 专用只读端点（其余 /api/social/* 一律走 service 正式路由）。
  function labRoute(req, res, pathname, url) {
    if (pathname === '/api/social/lab/accounts' && req.method === 'GET') {
      sendJson(res, 200, accountsView());
      return true;
    }
    if (pathname === '/api/social/lab/style-card' && req.method === 'GET') {
      let actor = null;
      try { actor = auth.authenticate(req); } catch { actor = null; }
      if (!actor) { sendJson(res, 401, { error: 'AUTH_REQUIRED' }); return true; }
      const asked = url.searchParams.get('week') || week;
      sendJson(res, 200, labStyleCard(store, actor.id, asked));
      return true;
    }
    return false;
  }

  const server = createServer((req, res) => {
    (async () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.startsWith('/api/social/')) {
        if (labRoute(req, res, pathname, url)) return;
        await social.handle(req, res, req.url); // req.url 保留 query（service 自行解析）
        return;
      }
      if (await serveSocialStatic(req, res, pathname)) return; // lab 自有资产：gzip + ETag
      if (typeof tangoHandler === 'function') await tangoHandler(req, res); // 静态 web/ 与既有 tango 行为
      else tango.emit('request', req, res);
    })().catch(() => {
      if (!res.destroyed) res.writeHead(400).end();
    });
  });

  return {
    server,
    store,
    social,
    auth,
    accounts: accountsView,
    seedState: () => seedInfo,
    close() {
      return new Promise((done) => {
        server.closeIdleConnections?.();
        server.close(() => {
          if (ownedStore) social.close(); // 注入的 store 归调用方管理
          done();
        });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// CLI — node scripts/social-lab.mjs [--seed-demo] [--port=17560] [--db=:memory:]
// 绑定 127.0.0.1；不 seed 时是一个空的（和生产同构的）social 服务。
// ---------------------------------------------------------------------------
function usage() {
  process.stdout.write([
    '用法：node scripts/social-lab.mjs [--seed-demo] [--port=17560] [--db=:memory:]',
    '  --seed-demo   生成标记为示例的用户（demo- 前缀 + 化名·示例）；仅本 lab 参数',
    '  --port=N      监听端口（默认 ' + LAB_DEFAULT_PORT + '，实验端口段 17560–17569）',
    '  --db=PATH     social.sqlite 路径；默认 :memory:（演示不落盘）',
    '打开 http://127.0.0.1:<port>/social/lab.html 查看四屏演示。',
    '',
  ].join('\n'));
}

function main(argv) {
  let port = LAB_DEFAULT_PORT;
  let seedDemo = false;
  let databaseFile = ':memory:';
  for (const arg of argv) {
    if (arg === '--seed-demo') seedDemo = true;
    else if (arg === '--help' || arg === '-h') { usage(); return; }
    else if (arg.startsWith('--port=')) port = Number(arg.slice(7));
    else if (arg.startsWith('--db=')) databaseFile = arg.slice(5);
    else { process.stderr.write('未知参数：' + arg + '\n'); usage(); process.exitCode = 2; return; }
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) { process.stderr.write('--port 必须是 0–65535\n'); process.exitCode = 2; return; }
  const lab = createSocialLabServer({ seedDemo, databaseFile });
  lab.server.on('error', (error) => {
    process.stderr.write('lab 启动失败：' + error.code + '（端口被占用可换 --port=1756x）\n');
    process.exit(1);
  });
  lab.server.listen(port, '127.0.0.1', () => {
    const bound = lab.server.address().port;
    process.stdout.write('同频 lab: http://127.0.0.1:' + bound + '/social/lab.html\n');
    const view = lab.accounts();
    process.stdout.write('  第 ' + view.week + ' 周 · ' + (view.demoSeeded ? '已 seed 示例用户（全部标记 demo-*/·示例）' : '未 seed（加 --seed-demo 生成示例用户）') + '\n');
    for (const account of view.accounts) {
      process.stdout.write('  - ' + account.id + '（' + account.alias + ' · ' + account.label + (account.optIn ? '' : ' · 未开启') + '）\n');
    }
    if (seedDemo) process.stdout.write('  示例圈邀请码：' + LAB_DEMO_CIRCLE_CODE + '\n');
  });
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main(process.argv.slice(2));
