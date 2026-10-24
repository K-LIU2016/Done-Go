// scripts/social-service.mjs — 同频（社交游戏化）REST 服务 /api/social/*
// (PRD design/social-sync/PRD.md §7, 红线 D2/D4/D5/D6)。
//
// 挂载（二期，serve-tango 集成节点）：与 collaboration-service 同形 ——
//   const social = createSocialService({ store, auth: collaboration.auth, ... });
//   if (await social.handle(req, res, pathname)) return;
//
// 所有数据形状一律来自 web/social/contracts.js（单一事实源），本文件绝不
// 重新定义键/上限/枚举。硬性规则：
// - D2 上传一律过契约白名单校验，未知字段【拒绝】（UPLOAD_FIELDS_REJECTED），
//   绝不静默剥离；错误响应只回 path/message，永不回显被拒值。
// - D2 本服务不写任何含上传内容的日志（事实上完全没有 payload 日志）。
// - D4 匹配服务端强制「略多一点」（isSlightlyAhead），matcher 给多少越界
//   候选都会被过滤；冷启动不足不造假人（fallback:'invite'）。
// - D5 圈主页排名/汇总输出前重过 validateCircleRankView /
//   validateFreedToSummary，工时字段直接 SOCIAL_DATA_INVALID。
// - D6 传棒卡只含 {usageId, scenarioTitle, promptTemplate}，链视图
//   clipBatonChain 封顶 5 跳。
// - 隐私控制（block/report/delete-me/opt-in 开关）不要求同频已开启 —— 用户
//   关闭同频后仍必须能删数据、举报、屏蔽。
// - 未成年人（opt-in 时自报 minor）：matches 永不查询公开池
//   （allowPublicPool:false），入圈只认邀请码（MINOR_INVITE_CODE_REQUIRED）。
//
// Store 接口（由 S1 线 scripts/social-store.mjs 实现；测试注入内存 stub，
// 形状必须一致）：
//   getState(account) -> { optIn, minor, alias, avatarColor } | null
//   optIn(account, { enabled, minor, alias, avatarColor }) -> 同上（首次开启时落服务端生成的化名）
//   setAlias(account, { alias, avatarColor }) -> 同上
//   saveProfile(account, features) -> void            // features 已过白名单
//   getProfile(account, week) -> features | null
//   poolCandidates(week, { allowMinors }) -> [{ account, graduations, record }]
//   circlePeerCandidates(account, week) -> [{ account, graduations, record }]
//   recordSharedEvent(account, kind) -> { id, kind, owner }
//   getSharedEvent(owner, eventId) -> { id, kind, owner } | null
//   addKudos(entry) / listKudos(account)
//   createBatonShare(share) / getBatonShare(id) / addBatonEvent(event) / batonChain(id)
//   listPairs(account) / pairCount(account) / createPair(pair) / getPair(id) /
//   deletePair(id) / freezePair(id)
//   listCircles(account) / createCircle({ id, name, inviteCode, owner }) /
//   findCircleByInvite(code) / getCircle(id) / circleMemberCount(id) /
//   joinCircle(id, account) / leaveCircle(id, account) / isCircleMember(id, account) /
//   circleOwner(id) / removeCircleMember(id, member) /
//   circleHome(id, week) -> { wall, chain, freedTo, rankView }
//   block(a, b) / unblock(a, b) / listBlocks(a) / blockedBetween(a, b)
//   report(entry) / recordQuestFeedback(entry)
//   purgeAccount(account) -> void                      // D2 级联彻底删除

import { randomUUID } from 'node:crypto';
import {
  SOCIAL_CONTRACTS_VERSION,
  ACCOUNT_ID_MAX, ALIAS_MAX,
  validateFeaturesUpload,
  validateAlias, isAvatarColor, validateMatch,
  MATCHES_PER_WEEK, KUDOS_EVENT_KINDS, validateKudos,
  validateBatonCard, validateBatonShare, validateBatonEvent,
  BATON_TARGET_KINDS, clipBatonChain,
  MAX_PAIRS, PAIR_FREEZES_PER_WEEK, validatePair,
  CIRCLE_NAME_MAX, CIRCLE_MAX_MEMBERS, validateCircle,
  validateCircleRankView, validateFreedToSummary,
  QUEST_FEEDBACK_TYPES, validateQuest, validateQuestProgress,
  STYLES, isIsoWeek,
} from '../web/social/contracts.js';

const BODY_MAX_BYTES = 128 * 1024;
const REPORT_REASON_MAX = 200;

// 化名 = 形容词 + 自然物（服务端生成，PRD §5 化名系统）。
const ALIAS_ADJECTIVES = ['安静的', '远山的', '晨跑的', '晚风的', '山间的', '温暖的', '认真的', '轻盈的', '明亮的', '慢慢来的'];
const ALIAS_NATURES = ['湖', '松', '鹿', '溪', '杉', '月', '风', '石', '鸥', '麦'];
const AVATAR_COLORS = STYLES.map(style => style.color);
// 邀请码字母表去掉易混淆的 I/O/0/1（长度 8，满足 ^[A-Z0-9]{6,12}$）。
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const INVITE_LENGTH = 8;

// 周挑战模板（PRD §4.7 例子；确定性按 week 挑选，不依赖 AI/随机）。
const QUEST_PERSONAL_POOL = [
  { title: '用 AI 完成 3 件生活小事', target: 3, unit: '件' },
  { title: '把空出来的 1 小时给家人并确认', target: 60, unit: '分钟' },
  { title: '给 1 个人传棒', target: 1, unit: '次' },
  { title: '学会 2 个新用法', target: 2, unit: '个' },
];
const QUEST_CIRCLE_POOL = [
  { title: '圈内互相加油 5 次', target: 5, unit: '次' },
  { title: '全圈学会 3 个新用法', target: 3, unit: '个' },
  { title: '给圈友传棒 2 次', target: 2, unit: '次' },
];

export function socialError(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}

function need(ok, code = 'INVALID_INPUT', status = 400) {
  if (!ok) throw socialError(code, status);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// 白名单外的字段一律拒绝（D2 精神也适用于小 body：不静默剥离）。
function exactKeys(value, fields) {
  return isPlainObject(value) && fields.every(field => field in value) &&
    Object.keys(value).every(key => fields.includes(key));
}

function accountId(value) {
  return typeof value === 'string' && value.trim() && value.trim().length <= ACCOUNT_ID_MAX ? value.trim() : null;
}

function textMax(value, max) {
  const out = typeof value === 'string' ? value.trim() : '';
  return out && out.length <= max ? out : null;
}

function pick(rng, list) {
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
}

function genAlias(rng) {
  return pick(rng, ALIAS_ADJECTIVES) + pick(rng, ALIAS_NATURES);
}

function genInviteCode(rng) {
  let code = '';
  for (let i = 0; i < INVITE_LENGTH; i += 1) code += pick(rng, [...INVITE_ALPHABET]);
  return code;
}

function defaultCurrentWeek(time) {
  const date = new Date(time);
  const weekday = (date.getUTCDay() + 6) % 7; // 周一=0
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() - weekday + 3); // ISO 周以周四定年
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = 1 + Math.round((thursday.getTime() - yearStart.getTime()) / 604800000);
  return thursday.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}

export function questPlan(week) {
  const seed = [...week].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const first = seed % QUEST_PERSONAL_POOL.length;
  const second = (first + 1 + ((seed >>> 8) % (QUEST_PERSONAL_POOL.length - 1))) % QUEST_PERSONAL_POOL.length;
  const circle = (seed >>> 16) % QUEST_CIRCLE_POOL.length;
  const mk = (n, scope, def) => ({ id: `q-${week}-${scope[0]}${n}`, week, scope, title: def.title, target: def.target, unit: def.unit });
  const quests = [
    mk(0, 'personal', QUEST_PERSONAL_POOL[first]),
    mk(1, 'personal', QUEST_PERSONAL_POOL[second]),
    mk(0, 'circle', QUEST_CIRCLE_POOL[circle]),
  ];
  for (const quest of quests) need(validateQuest(quest), 'SOCIAL_DATA_INVALID', 500);
  return quests;
}

async function readBody(req) {
  need(/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''), 'JSON_REQUIRED', 415);
  let size = 0;
  const chunks = [];
  for await (const part of req) {
    size += part.length;
    if (size > BODY_MAX_BYTES) throw socialError('BODY_TOO_LARGE', 413);
    chunks.push(part);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw socialError('INVALID_JSON', 400); }
  need(isPlainObject(body), 'INVALID_INPUT', 400);
  return body;
}

export function createSocialService(options = {}) {
  const store = options.store;
  need(store, 'SOCIAL_STORE_REQUIRED', 503);
  const auth = options.auth;
  need(auth, 'SOCIAL_AUTH_REQUIRED', 503);
  const now = options.now || Date.now;
  const currentWeek = options.currentWeek || (() => defaultCurrentWeek(now()));
  const rng = options.rng || Math.random;
  const limits = { write: 30, read: 240, preview: 12, windowMs: 60000, ...(options.rateLimits || {}) };
  // 默认 matcher：公开池（排除未成年人与未开启者 —— store 侧执行）+ 所在圈
  // 成员（PRD §3.3 冷启动）。屏蔽过滤在这里做（service 层只有化名记录）。
  const matcher = options.matcher || (async ({ account, week, allowPublicPool }) => {
    const pool = allowPublicPool ? (store.poolCandidates(week, { allowMinors: false }) || []) : [];
    const peers = store.circlePeerCandidates ? (store.circlePeerCandidates(account, week) || []) : [];
    return [...pool, ...peers]
      .filter(candidate => candidate.record && !store.blockedBetween(account, candidate.account))
      .map(candidate => candidate.record);
  });

  const buckets = new Map();
  function hit(key, limit) {
    if (!(limit > 0)) return;
    const window = Math.floor(now() / limits.windowMs);
    let slot = buckets.get(key);
    if (!slot || slot.window !== window) {
      if (buckets.size > 4096) for (const [name, value] of buckets) if (value.window !== window) buckets.delete(name);
      slot = { window, count: 1 };
      buckets.set(key, slot);
      return;
    }
    if (slot.count >= limit) throw socialError('RATE_LIMITED', 429);
    slot.count += 1;
  }

  function tryAuthenticate(req) {
    try { return auth.authenticate(req); } catch { return null; }
  }

  function publicState(state) {
    return {
      optIn: !!(state && state.optIn),
      minor: !!(state && state.minor),
      alias: (state && state.alias) || null,
      avatarColor: (state && state.avatarColor) || null,
    };
  }

  function sharedEvent(actor, body) {
    need(exactKeys(body, ['kind']), 'INVALID_INPUT', 400);
    need(KUDOS_EVENT_KINDS.includes(body.kind), 'INVALID_INPUT', 400);
    return store.recordSharedEvent(actor.id, body.kind);
  }

  function weekParam(query) {
    const week = query.get('week') || currentWeek();
    need(isIsoWeek(week), 'INVALID_INPUT', 400);
    return week;
  }

  // -----------------------------------------------------------------------
  // 路由表：先具体后参数化（join 先于 :id）；guest 路由只有 preview 和
  // 打开传棒链接（PRD §4.8）。kind 决定限流桶。
  // -----------------------------------------------------------------------
  const routes = [];
  const on = (method, pattern, kind, handler, extra = {}) => routes.push({ method, pattern, kind, handler, ...extra });

  on('GET', /^\/api\/social\/preview$/, 'preview', () => ({
    blurred: true,
    styles: STYLES.map(({ id, label, motto, color }) => ({ id, label, motto, color })),
    inviteText: '邀请 1 个同学，一起开启同频',
    version: SOCIAL_CONTRACTS_VERSION,
  }), { guest: true });

  on('GET', /^\/api\/social\/state$/, 'read', (actor, _body, ctx) => publicState(ctx.state));

  on('POST', /^\/api\/social\/opt-in$/, 'write', (actor, body, ctx) => {
    need(exactKeys(body, ['enabled', 'minor']), 'INVALID_INPUT', 400);
    need(typeof body.enabled === 'boolean' && typeof body.minor === 'boolean', 'INVALID_INPUT', 400);
    const existing = ctx.state;
    const alias = body.enabled && !(existing && existing.alias) ? validateAlias(genAlias(rng)) : null;
    const avatarColor = body.enabled && !(existing && existing.avatarColor) ? pick(rng, AVATAR_COLORS) : null;
    return publicState(store.optIn(actor.id, { enabled: body.enabled, minor: body.minor, alias, avatarColor }));
  });

  on('POST', /^\/api\/social\/alias$/, 'write', (actor, body) => {
    need(exactKeys(body, ['alias', 'avatarColor']), 'INVALID_INPUT', 400);
    const alias = validateAlias(body.alias);
    need(alias && alias.length <= ALIAS_MAX && isAvatarColor(body.avatarColor), 'INVALID_ALIAS', 400);
    return publicState(store.setAlias(actor.id, { alias, avatarColor: body.avatarColor }));
  });

  on('POST', /^\/api\/social\/profile$/, 'write', (actor, body) => {
    const result = validateFeaturesUpload(body); // D2 白名单：未知字段拒绝
    if (!result.ok) throw socialError('UPLOAD_FIELDS_REJECTED', 400);
    store.saveProfile(actor.id, result.value);
    return { ok: true, week: result.value.week };
  }, { optIn: true });

  on('GET', /^\/api\/social\/matches$/, 'write', async (actor, _body, ctx) => {
    const week = weekParam(ctx.query);
    const profile = store.getProfile(actor.id, week);
    const myGraduations = profile && typeof profile.graduations === 'number' ? profile.graduations : 0;
    const allowPublicPool = ctx.state.minor !== true; // 未成年人不进公开同频池（PRD §5）
    const records = (await matcher({ store, account: actor.id, week, allowPublicPool, myGraduations })) || [];
    const matches = [];
    for (const rec of records) {
      const valid = validateMatch(rec, { myGraduations }); // 含「略多一点」硬边界（D4）
      if (!valid) continue;
      matches.push(valid);
      if (matches.length >= MATCHES_PER_WEEK) break;
    }
    return { week, matches, fallback: matches.length < MATCHES_PER_WEEK ? 'invite' : null };
  }, { optIn: true });

  on('POST', /^\/api\/social\/shared-event$/, 'write', (actor, body) => sharedEvent(actor, body), { optIn: true });

  on('GET', /^\/api\/social\/kudos$/, 'read', actor => ({ kudos: store.listKudos(actor.id) }), { optIn: true });

  on('POST', /^\/api\/social\/kudos$/, 'write', (actor, body) => {
    const value = validateKudos(body);
    need(value, 'INVALID_INPUT', 400);
    need(value.from === actor.id, 'FORBIDDEN', 403); // 只能以本人名义加油
    need(!store.blockedBetween(value.from, value.to), 'BLOCKED', 403);
    const shared = store.getSharedEvent(value.to, value.sharedEventId);
    need(shared && shared.owner === value.to && shared.kind === value.eventKind, 'KUDOS_EVENT_NOT_SHARED', 403);
    store.addKudos({ ...value, at: new Date(now()).toISOString() });
    return { ok: true };
  }, { optIn: true });

  on('POST', /^\/api\/social\/baton$/, 'write', (actor, body) => {
    need(exactKeys(body, ['targetKind', 'targetId', 'card']), 'INVALID_INPUT', 400);
    need(BATON_TARGET_KINDS.includes(body.targetKind), 'INVALID_INPUT', 400);
    const card = validateBatonCard(body.card); // D6：卡只含三个字段，多一个即拒
    need(card, 'BATON_CARD_REJECTED', 400);
    let targetId = null;
    if (body.targetKind === 'link') {
      need(body.targetId == null, 'INVALID_INPUT', 400);
    } else {
      targetId = accountId(body.targetId);
      need(targetId, 'INVALID_INPUT', 400);
      need(!store.blockedBetween(actor.id, targetId), 'BLOCKED', 403);
    }
    const id = 'bs-' + randomUUID();
    const share = { id, usageId: card.usageId, fromAccount: actor.id, targetKind: body.targetKind, targetId, card };
    need(validateBatonShare(share), 'SOCIAL_DATA_INVALID', 500);
    store.createBatonShare(share);
    store.addBatonEvent({ id: 'be-' + randomUUID(), batonId: id, kind: 'sent', at: new Date(now()).toISOString(), byAccount: actor.id });
    return { id, card: share.card };
  }, { optIn: true });

  // 打开传棒链接：访客可用（PRD §4.8），按 IP 限流。
  on('GET', /^\/api\/social\/baton\/([\w-]+)$/, 'preview', (actor, _body, ctx) => {
    const share = store.getBatonShare(ctx.params[0]);
    need(share, 'BATON_NOT_FOUND', 404);
    if (actor) store.addBatonEvent({ id: 'be-' + randomUUID(), batonId: share.id, kind: 'opened', at: new Date(now()).toISOString(), byAccount: actor.id });
    return { id: share.id, card: share.card, chain: clipBatonChain(store.batonChain(share.id)) }; // D6：最多 5 跳
  }, { guest: true });

  on('POST', /^\/api\/social\/baton\/([\w-]+)\/event$/, 'write', (actor, body, ctx) => {
    const share = store.getBatonShare(ctx.params[0]);
    need(share, 'BATON_NOT_FOUND', 404);
    need(exactKeys(body, ['kind']), 'INVALID_INPUT', 400);
    need(['opened', 'relay-completed', 'graduated'].includes(body.kind), 'INVALID_INPUT', 400); // sent 只随发送产生
    const event = { id: 'be-' + randomUUID(), batonId: share.id, kind: body.kind, at: new Date(now()).toISOString(), byAccount: actor.id };
    need(validateBatonEvent(event), 'SOCIAL_DATA_INVALID', 500);
    store.addBatonEvent(event);
    return { ok: true, kind: event.kind };
  }, { optIn: true });

  on('GET', /^\/api\/social\/pairs$/, 'read', actor => ({
    pairs: (store.listPairs(actor.id) || []).map(pair => {
      const valid = validatePair(pair);
      need(valid, 'SOCIAL_DATA_INVALID', 500);
      return valid;
    }),
  }), { optIn: true });

  on('POST', /^\/api\/social\/pairs$/, 'write', (actor, body) => {
    need(exactKeys(body, ['with']), 'INVALID_INPUT', 400);
    const target = accountId(body.with);
    need(target, 'INVALID_INPUT', 400);
    need(target !== actor.id, 'PAIR_SELF_FORBIDDEN', 400);
    need(!store.blockedBetween(actor.id, target), 'BLOCKED', 403);
    need(store.pairCount(actor.id) < MAX_PAIRS, 'PAIR_LIMIT_REACHED', 409); // 最多 5 位搭档
    const pair = { id: 'pr-' + randomUUID(), a: actor.id, b: target, startedWeek: currentWeek(), flame: 0, freezesUsed: 0 };
    need(validatePair(pair), 'SOCIAL_DATA_INVALID', 500);
    store.createPair(pair);
    return { pair };
  }, { optIn: true });

  on('POST', /^\/api\/social\/pairs\/([\w-]+)\/leave$/, 'write', (actor, _body, ctx) => {
    const pair = store.getPair(ctx.params[0]);
    need(pair, 'PAIR_NOT_FOUND', 404);
    need(pair.a === actor.id || pair.b === actor.id, 'FORBIDDEN', 403);
    store.deletePair(pair.id);
    return { ok: true };
  }, { optIn: true });

  on('POST', /^\/api\/social\/pairs\/([\w-]+)\/freeze$/, 'write', (actor, _body, ctx) => {
    const pair = store.getPair(ctx.params[0]);
    need(pair, 'PAIR_NOT_FOUND', 404);
    need(pair.a === actor.id || pair.b === actor.id, 'FORBIDDEN', 403);
    need(pair.freezesUsed < PAIR_FREEZES_PER_WEEK, 'PAIR_FROZEN_ALREADY', 409); // 每周 1 次冻结
    store.freezePair(pair.id);
    return { pair: store.getPair(pair.id) };
  }, { optIn: true });

  on('GET', /^\/api\/social\/circles$/, 'read', actor => ({
    circles: (store.listCircles(actor.id) || []).map(circle => ({
      id: circle.id, name: circle.name, inviteCode: circle.inviteCode,
      owner: circle.owner, memberCount: Array.isArray(circle.members) ? circle.members.length : store.circleMemberCount(circle.id),
    })),
  }), { optIn: true });

  on('POST', /^\/api\/social\/circles$/, 'write', (actor, body) => {
    need(exactKeys(body, ['name']), 'INVALID_INPUT', 400);
    const name = textMax(body.name, CIRCLE_NAME_MAX);
    need(name, 'INVALID_INPUT', 400);
    let inviteCode = genInviteCode(rng);
    while (store.findCircleByInvite(inviteCode)) inviteCode = genInviteCode(rng);
    const circle = { id: 'ci-' + randomUUID(), name, inviteCode, owner: actor.id };
    need(validateCircle({ id: circle.id, name: circle.name, inviteCode }), 'SOCIAL_DATA_INVALID', 500);
    store.createCircle(circle);
    return { circle: { id: circle.id, name: circle.name, inviteCode: circle.inviteCode, owner: circle.owner } };
  }, { optIn: true });

  on('POST', /^\/api\/social\/circles\/join$/, 'write', (actor, body, ctx) => {
    const keys = Object.keys(body);
    let circle;
    if (keys.length === 1 && keys[0] === 'inviteCode') {
      circle = store.findCircleByInvite(String(body.inviteCode));
      need(circle, 'CIRCLE_INVITE_CODE_INVALID', 404);
    } else if (keys.length === 1 && keys[0] === 'circleId') {
      // 圈链接直进：成年人可用；未成年人只认邀请码（PRD §5）。
      need(ctx.state.minor !== true, 'MINOR_INVITE_CODE_REQUIRED', 403);
      circle = store.getCircle(accountId(body.circleId));
      need(circle, 'CIRCLE_NOT_FOUND', 404);
    } else {
      throw socialError('INVALID_INPUT', 400);
    }
    need(store.circleMemberCount(circle.id) < CIRCLE_MAX_MEMBERS, 'CIRCLE_FULL', 409);
    store.joinCircle(circle.id, actor.id);
    return { circle: { id: circle.id, name: circle.name, inviteCode: circle.inviteCode, owner: circle.owner } };
  }, { optIn: true });

  on('POST', /^\/api\/social\/circles\/([\w-]+)\/leave$/, 'write', (actor, _body, ctx) => {
    const circle = store.getCircle(ctx.params[0]);
    need(circle, 'CIRCLE_NOT_FOUND', 404);
    need(store.isCircleMember(circle.id, actor.id), 'NOT_CIRCLE_MEMBER', 403);
    store.leaveCircle(circle.id, actor.id);
    return { ok: true };
  }, { optIn: true });

  on('POST', /^\/api\/social\/circles\/([\w-]+)\/remove$/, 'write', (actor, body, ctx) => {
    const circle = store.getCircle(ctx.params[0]);
    need(circle, 'CIRCLE_NOT_FOUND', 404);
    need(store.circleOwner(circle.id) === actor.id, 'NOT_CIRCLE_OWNER', 403); // 圈主移除成员
    need(exactKeys(body, ['member']), 'INVALID_INPUT', 400);
    const member = accountId(body.member);
    need(member && member !== actor.id, 'INVALID_INPUT', 400);
    store.removeCircleMember(circle.id, member);
    return { ok: true };
  }, { optIn: true });

  on('GET', /^\/api\/social\/circles\/([\w-]+)$/, 'read', (actor, _body, ctx) => {
    const circle = store.getCircle(ctx.params[0]);
    need(circle, 'CIRCLE_NOT_FOUND', 404);
    need(store.isCircleMember(circle.id, actor.id), 'NOT_CIRCLE_MEMBER', 403);
    const week = weekParam(ctx.query);
    const home = store.circleHome(circle.id, week) || {};
    // D5：排名只按传棒/毕业、汇总只允许占比 —— 出口再校验，污染即拒。
    const rank = home.rankView ? validateCircleRankView(home.rankView) : null;
    need(!home.rankView || rank, 'SOCIAL_DATA_INVALID', 500);
    const freedTo = home.freedTo ? validateFreedToSummary(home.freedTo) : null;
    need(!home.freedTo || freedTo, 'SOCIAL_DATA_INVALID', 500);
    return {
      circle: { id: circle.id, name: circle.name, inviteCode: circle.inviteCode, owner: circle.owner, memberCount: store.circleMemberCount(circle.id) },
      week,
      wall: home.wall || [],
      chain: clipBatonChain(home.chain || []),
      freedTo,
      rank,
    };
  }, { optIn: true });

  on('GET', /^\/api\/social\/quests$/, 'read', (actor, _body, ctx) => {
    const week = weekParam(ctx.query);
    const quests = questPlan(week).map(quest => {
      const progress = validateQuestProgress(store.getQuestProgress(quest.id, quest.scope, actor.id) ||
        { questId: quest.id, scope: quest.scope, owner: actor.id, progress: 0, done: false });
      need(progress, 'SOCIAL_DATA_INVALID', 500);
      return { quest, progress };
    });
    return { week, quests };
  }, { optIn: true });

  on('POST', /^\/api\/social\/quests\/([\w-]+)\/feedback$/, 'write', (actor, body, ctx) => {
    const questId = accountId(ctx.params[0]);
    need(questId, 'QUEST_NOT_FOUND', 404);
    need(exactKeys(body, ['type']), 'INVALID_INPUT', 400);
    need(QUEST_FEEDBACK_TYPES.includes(body.type), 'INVALID_INPUT', 400); // 「太多了」是保护指标（PRD §8）
    store.recordQuestFeedback({ account: actor.id, questId, type: body.type, at: new Date(now()).toISOString() });
    return { ok: true };
  }, { optIn: true });

  on('POST', /^\/api\/social\/block$/, 'write', (actor, body) => {
    need(exactKeys(body, ['account']), 'INVALID_INPUT', 400);
    const target = accountId(body.account);
    need(target && target !== actor.id, 'INVALID_INPUT', 400);
    store.block(actor.id, target);
    return { ok: true, blocked: store.listBlocks(actor.id) };
  });

  on('GET', /^\/api\/social\/blocks$/, 'read', actor => ({ blocked: store.listBlocks(actor.id) }));

  on('POST', /^\/api\/social\/block\/([\w-]+)\/remove$/, 'write', (actor, _body, ctx) => {
    const target = accountId(ctx.params[0]);
    need(target, 'INVALID_INPUT', 400);
    store.unblock(actor.id, target);
    return { ok: true, blocked: store.listBlocks(actor.id) };
  });

  on('POST', /^\/api\/social\/report$/, 'write', (actor, body) => {
    need(exactKeys(body, ['account', 'reason']), 'INVALID_INPUT', 400);
    const target = accountId(body.account);
    const reason = textMax(body.reason, REPORT_REASON_MAX);
    need(target && target !== actor.id && reason, 'INVALID_INPUT', 400);
    store.report({ from: actor.id, about: target, reason, at: new Date(now()).toISOString() });
    return { ok: true };
  });

  on('POST', /^\/api\/social\/delete-me$/, 'write', actor => {
    store.purgeAccount(actor.id); // D2：级联彻底删除（同频数据 24h 内清除的服务端部分）
    return { deleted: true };
  });

  function send(res, status, value) {
    if (!res.destroyed) res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(value));
  }

  return {
    store,
    close() { if (typeof store.close === 'function') store.close(); },
    async handle(req, res, rawPath) {
      if (typeof rawPath !== 'string' || !rawPath.startsWith('/api/social/')) return false;
      const query = new URLSearchParams(rawPath.includes('?') ? rawPath.slice(rawPath.indexOf('?') + 1) : '');
      const path = rawPath.includes('?') ? rawPath.slice(0, rawPath.indexOf('?')) : rawPath;
      try {
        const matched = routes.filter(route => route.pattern.test(path));
        if (!matched.length) throw socialError('NOT_FOUND', 404);
        const route = matched.find(entry => entry.method === req.method);
        if (!route) throw socialError('METHOD_NOT_ALLOWED', 405);
        const actor = tryAuthenticate(req);
        if (!route.guest) need(actor, 'AUTH_REQUIRED', 401); // 访客只能 preview / 开传棒链接
        // 统一的 opt-in 门禁：同频功能（匹配/上传/圈/搭档/传棒发出/挑战）都要求
        // 先开启；隐私控制（block/report/delete-me/alias）随时可用。
        const state = actor ? store.getState(actor.id) : null;
        if (route.optIn) need(state && state.optIn === true, 'SOCIAL_OPT_IN_REQUIRED', 403);
        if (route.kind === 'preview') hit('p:' + ((req.socket && req.socket.remoteAddress) || 'unknown'), limits.preview);
        else if (actor) hit((route.kind === 'write' ? 'w:' : 'r:') + actor.id, limits[route.kind]);
        const body = req.method === 'POST' ? await readBody(req) : {};
        const params = route.pattern.exec(path).slice(1);
        const result = await route.handler(actor, body, { params, query, req, state });
        send(res, 200, result);
      } catch (error) {
        const status = Number.isInteger(error && error.status) ? error.status : 500;
        const code = typeof (error && error.code) === 'string' ? error.code : 'SOCIAL_UNAVAILABLE';
        send(res, status, { error: code }); // 永不回显 body/字段值（D2）
      }
      return true;
    },
  };
}
