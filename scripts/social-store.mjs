import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

// scripts/social-store.mjs — 同频（社交游戏化）存储层。
// PRD design/social-sync/PRD.md §7: 新库 social.sqlite（node:sqlite，路径由
// 服务层传入、与 collaboration.sqlite 同目录），权限 600，照
// scripts/collaboration-store.mjs 的写法（工厂函数 + :memory: 支持 + WAL +
// 版本元表迁移 + BEGIN IMMEDIATE 事务）。
//
// 表（PRD §7 的 11 张 + 隐私规则必需的 3 张 + 迁移元表）:
//   profiles_weekly / pairs / kudos / baton_shares / baton_events / circles /
//   circle_members / quests / quest_progress / blocks / reports     ← PRD §7
//   social_accounts   ← PRD §5 opt-in 默认关闭、化名+头像色、自报未成年需要
//                       账号级落点（§7 清单未列，证据文件有 spec 冲突记录）
//   shared_events     ← PRD §4.3 “事件只在本人确认分享后出现”，kudos 的
//                       sharedEventId 引用目标（S4 服务线 store 契约要求）
//   quest_feedback    ← PRD §8 保护指标“太多了”反馈通道
//   social_meta       ← 迁移版本（collab_meta 同款）
//
// 硬规则:
// - D2 上传白名单在存储边界仍然生效: saveProfile 只接受 sanitizeFeaturesUpload
//   通过的值；白名单外字段（含嵌套）一律 INVALID_INPUT 拒绝，绝不静默剥离。
//   事项标题/材料/具体时间因此永远进不了库。
// - D2 删除我的数据级联彻底: purgeAccount 在一个事务里清掉本账号在每张表的
//   痕迹（含指向其搭档关系的传棒、独守圈的圈挑战与进度），accountReferences
//   用同一套谓词逐表复核；他人数据不动。
// - D6 baton_events 四种事件（sent/opened/relay-completed/graduated）全部
//   落库；传递链存储可长，视图封顶 5 跳由契约 clipBatonChain 在聚合层执行。
// - D5 圈内排名只按传棒与毕业；circleHome 出库即过 validateCircleRankView /
//   validateFreedToSummary，结构上不可能出现工时字段。
// - 所有形状/枚举/上限一律 import 自 ../web/social/contracts.js，本文件不
//   重复定义；不做任何日志输出（D2: 日志里不得出现隐私字段）。
// - 方法名与形状对齐 S4 服务线声明的 store 契约
//   (tests/unit/social-service.test.mjs mkStore)。

import {
  KUDOS_EVENT_KINDS,
  PAIR_FREEZES_PER_WEEK,
  CIRCLE_MAX_MEMBERS,
  CIRCLE_RANK_SHOWN,
  QUEST_FEEDBACK_TYPES,
  ACCOUNT_ID_MAX,
  sanitizeFeaturesUpload,
  validateAlias,
  isAvatarColor,
  validateKudos,
  validateBatonEvent,
  validateBatonShare,
  validatePair,
  validateCircle,
  validateQuest,
  validateQuestProgress,
  validateCircleRankView,
  validateFreedToSummary,
  clipBatonChain,
} from '../web/social/contracts.js';

const SOCIAL_TABLES = [
  'social_accounts', 'profiles_weekly', 'shared_events', 'pairs', 'kudos',
  'baton_shares', 'baton_events', 'circles', 'circle_members', 'quests',
  'quest_progress', 'quest_feedback', 'blocks', 'reports', 'social_meta',
];

export function socialError(code, status = 400) { return Object.assign(new Error(code), { code, status }); }
function requireValue(ok, code = 'INVALID_INPUT', status = 400) { if (!ok) throw socialError(code, status); }
function accountText(value) {
  return typeof value === 'string' && value.trim() && value.length <= ACCOUNT_ID_MAX ? value.trim() : null;
}
function reasonText(value, max = 500) {
  return typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null;
}

// ISO 周（YYYY-Www）。冻结与圈聚合按周锚定，用注入的 now() 推导。
function isoWeekOf(iso) {
  const date = new Date(iso);
  requireValue(!Number.isNaN(date.getTime()), 'INVALID_INPUT');
  const weekday = (date.getUTCDay() + 6) % 7; // 周一=0
  date.setUTCDate(date.getUTCDate() - weekday + 3); // 本周四
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((date - firstThursday) / (7 * 86400000));
  return date.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}

function randomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 个易读字符
  return Array.from(randomBytes(8), (byte) => alphabet[byte & 31]).join('');
}

// ---------------------------------------------------------------------------
// 迁移 — 每个版本一个 up()，按 social_meta 版本顺序执行；改结构只加新版本，
// 绝不改历史版本。
// ---------------------------------------------------------------------------
const MIGRATIONS = [
  {
    version: 1,
    up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS social_accounts(
        account TEXT PRIMARY KEY, alias TEXT NOT NULL, avatar_color TEXT NOT NULL,
        is_minor INTEGER NOT NULL DEFAULT 0, opted_in INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS profiles_weekly(
        account TEXT NOT NULL, week TEXT NOT NULL, features TEXT NOT NULL,
        uploaded_at TEXT NOT NULL, PRIMARY KEY(account, week));
      CREATE TABLE IF NOT EXISTS shared_events(
        id TEXT PRIMARY KEY, owner_account TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pairs(
        id TEXT PRIMARY KEY, a TEXT NOT NULL, b TEXT NOT NULL, started_week TEXT NOT NULL,
        flame INTEGER NOT NULL, freezes_used INTEGER NOT NULL, freezes_week TEXT,
        created_at TEXT NOT NULL, UNIQUE(a, b));
      CREATE TABLE IF NOT EXISTS kudos(
        id TEXT PRIMARY KEY, from_account TEXT NOT NULL, to_account TEXT NOT NULL,
        event_kind TEXT NOT NULL, shared_event_id TEXT NOT NULL, at TEXT NOT NULL,
        UNIQUE(from_account, shared_event_id));
      CREATE TABLE IF NOT EXISTS baton_shares(
        id TEXT PRIMARY KEY, usage_id TEXT NOT NULL, from_account TEXT NOT NULL,
        target_kind TEXT NOT NULL, target_id TEXT, card TEXT NOT NULL,
        parent_share_id TEXT, created_week TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_baton_shares_target ON baton_shares(target_kind, target_id);
      CREATE INDEX IF NOT EXISTS idx_baton_shares_from ON baton_shares(from_account, created_week);
      CREATE TABLE IF NOT EXISTS baton_events(
        id TEXT PRIMARY KEY, baton_id TEXT NOT NULL, kind TEXT NOT NULL,
        at TEXT NOT NULL, by_account TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_baton_events_baton ON baton_events(baton_id);
      CREATE TABLE IF NOT EXISTS circles(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, invite_code TEXT NOT NULL UNIQUE,
        owner_account TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS circle_members(
        circle_id TEXT NOT NULL, account TEXT NOT NULL, joined_at TEXT NOT NULL,
        PRIMARY KEY(circle_id, account));
      CREATE INDEX IF NOT EXISTS idx_circle_members_account ON circle_members(account);
      CREATE TABLE IF NOT EXISTS quests(
        id TEXT PRIMARY KEY, week TEXT NOT NULL, scope TEXT NOT NULL, title TEXT NOT NULL,
        target INTEGER NOT NULL, unit TEXT NOT NULL, circle_id TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quest_progress(
        quest_id TEXT NOT NULL, owner TEXT NOT NULL, scope TEXT NOT NULL,
        progress INTEGER NOT NULL, done INTEGER NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(quest_id, owner));
      CREATE TABLE IF NOT EXISTS quest_feedback(
        quest_id TEXT NOT NULL, account TEXT NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL,
        PRIMARY KEY(quest_id, account, type));
      CREATE TABLE IF NOT EXISTS blocks(
        blocker_account TEXT NOT NULL, blocked_account TEXT NOT NULL, at TEXT NOT NULL,
        PRIMARY KEY(blocker_account, blocked_account), CHECK(blocker_account <> blocked_account));
      CREATE TABLE IF NOT EXISTS reports(
        id TEXT PRIMARY KEY, reporter_account TEXT NOT NULL, target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL);
    `),
  },
  {
    // v2（2026-10-25 修复轮）：
    // - onboarding_seen：PRD §5「开启前一屏讲清楚会分享什么」的服务端可查落点
    //   （service /opt-in 开启时校验；/onboarding-seen 幂等标记）。
    // - 三个热查询索引：profiles_weekly 按 week 分区（PRD §7「候选池按周分区」，
    //   poolCandidates 的 JOIN 不再全表扫）；kudos(to_account)（listKudos）；
    //   pairs(b)（listPairs/pairCount 的 b 侧，原先只有 UNIQUE(a,b) 覆盖 a 侧）。
    version: 2,
    up: (db) => db.exec(`
      ALTER TABLE social_accounts ADD COLUMN onboarding_seen INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_profiles_weekly_week ON profiles_weekly(week);
      CREATE INDEX IF NOT EXISTS idx_kudos_to ON kudos(to_account);
      CREATE INDEX IF NOT EXISTS idx_pairs_b ON pairs(b);
    `),
  },
];

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS social_meta(version INTEGER PRIMARY KEY)');
  let current = Number(db.prepare('SELECT MAX(version) AS v FROM social_meta').get()?.v ?? 0);
  for (const step of MIGRATIONS) {
    if (step.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      step.up(db);
      db.prepare('INSERT OR REPLACE INTO social_meta(version) VALUES (?)').run(step.version);
      db.exec('COMMIT');
      current = step.version;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return current;
}

// 圈级联删除：圈没了，圈挑战、进度、反馈与指向圈的传棒一起清。
function cascadeDeleteCircle(db, circleId) {
  const questIds = db.prepare('SELECT id FROM quests WHERE circle_id=?').all(circleId).map((row) => row.id);
  const removed = { quests: 0, quest_progress: 0, quest_feedback: 0, baton_shares: 0, circles: 0 };
  if (questIds.length) {
    const marks = questIds.map(() => '?').join(',');
    removed.quest_progress += db.prepare(`DELETE FROM quest_progress WHERE quest_id IN (${marks})`).run(...questIds).changes;
    removed.quest_feedback += db.prepare(`DELETE FROM quest_feedback WHERE quest_id IN (${marks})`).run(...questIds).changes;
    removed.quests += db.prepare(`DELETE FROM quests WHERE id IN (${marks})`).run(...questIds).changes;
  }
  removed.baton_shares += db.prepare("DELETE FROM baton_shares WHERE target_kind='circle' AND target_id=?").run(circleId).changes;
  removed.circles += db.prepare('DELETE FROM circles WHERE id=?').run(circleId).changes;
  return removed;
}

export function createSocialStore({ databaseFile = ':memory:', now = () => new Date().toISOString() } = {}) {
  if (databaseFile !== ':memory:') mkdirSync(dirname(databaseFile), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(databaseFile);
  const isFile = databaseFile !== ':memory:';
  // 权限 600：主库与 WAL/SHM 边车都收紧（边车在连接打开期间存在；每次提交后统一 chmod）
  function tighten() {
    if (!isFile) return;
    for (const suffix of ['', '-wal', '-shm']) {
      try { chmodSync(databaseFile + suffix, 0o600); } catch { /* 边车尚不存在是常态 */ }
    }
  }
  if (isFile) chmodSync(databaseFile, 0o600);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');
  const schemaVersion = migrate(db);
  tighten();

  // 候选池读缓存（PRD §7「匹配每周批量 + 实时增量」）：pool/peers 的行解析
  // （万级 JSON.parse 实测 ≈124ms/万行）是 /matches 全链路最大成本项，而
  // 这些集合只随三张表变化：social_accounts / profiles_weekly / circle_members。
  // 失效策略：改这三张表的写点（optIn/setAlias/markOnboardingSeen/saveProfile/
  // createCircle/joinCircle/removeCircleMember/leaveCircle/purgeAccount）在事务
  // 成功后显式 bumpGraphCache()，其余写（kudos/发棒/挑战等）不清缓存 ——
  // 宁可多失效，不给陈旧候选留缝。返回值是共享只读快照，调用方只遍历/过滤。
  const poolCache = new Map();
  const POOL_CACHE_MAX = 512;
  let graphVersion = 0;
  const bumpGraphCache = () => { graphVersion += 1; poolCache.clear(); };
  const cachedGraph = (key, compute) => {
    const hit = poolCache.get(key);
    if (hit && hit.version === graphVersion) return hit.value;
    const value = compute();
    if (poolCache.size >= POOL_CACHE_MAX) poolCache.delete(poolCache.keys().next().value);
    poolCache.set(key, { version: graphVersion, value });
    return value;
  };

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); tighten(); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  // 预编译语句缓存：all()/get() 是全部热路径（匹配管线逐候选 blockedBetween
  // 曾被每调用 db.prepare 放大成最大成本项）；同一条 SQL 只编译一次。
  const statements = new Map();
  const stmt = (sql) => {
    let prepared = statements.get(sql);
    if (!prepared) { prepared = db.prepare(sql); statements.set(sql, prepared); }
    return prepared;
  };
  const all = (sql, ...params) => stmt(sql).all(...params);
  const get = (sql, ...params) => stmt(sql).get(...params) ?? null;
  const count = (sql, ...params) => Number(get(sql, ...params)?.count ?? 0);

  // ---- 行 ↔ 契约形状 ------------------------------------------------------
  // pairOf 有意不含 freezes_week：validatePair 是六键白名单，公共形状不加键；
  // 周预算判断走 pairFreezeState（专用读面）。
  const pairOf = (row) => row && { id: row.id, a: row.a, b: row.b, startedWeek: row.started_week, flame: row.flame, freezesUsed: row.freezes_used };
  const questOf = (row) => row && { id: row.id, week: row.week, scope: row.scope, title: row.title, target: row.target, unit: row.unit };
  const progressOf = (row) => row && { questId: row.quest_id, scope: row.scope, owner: row.owner, progress: row.progress, done: !!row.done };
  const shareOf = (row) => row && {
    id: row.id, usageId: row.usage_id, fromAccount: row.from_account,
    targetKind: row.target_kind, targetId: row.target_id, card: JSON.parse(row.card),
  };
  const eventOf = (row) => row && { id: row.id, batonId: row.baton_id, kind: row.kind, at: row.at, byAccount: row.by_account };
  const stateOf = (row) => row && { optIn: !!row.opted_in, minor: !!row.is_minor, alias: row.alias, avatarColor: row.avatar_color, onboardingSeen: !!row.onboarding_seen };
  const circleRow = (id) => get('SELECT * FROM circles WHERE id=?', id);
  const circleOf = (row) => row && {
    id: row.id, name: row.name, inviteCode: row.invite_code, owner: row.owner_account,
    members: all('SELECT account FROM circle_members WHERE circle_id=? ORDER BY joined_at, rowid', row.id).map((m) => m.account),
  };

  const api = {
    close() { tighten(); poolCache.clear(); db.close(); },
    schemaVersion: () => schemaVersion,
    indexNames: () => all("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").map((row) => row.name),
    tableCounts() {
      const names = all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name);
      requireValue(names.every((name) => SOCIAL_TABLES.includes(name)), 'SCHEMA_DRIFT', 500);
      const out = {};
      for (const name of SOCIAL_TABLES) out[name] = count(`SELECT COUNT(*) AS count FROM ${name}`);
      return out;
    },

    // ---- 账号状态（opt-in / 化名 / 未成年） --------------------------------
    getState: (account) => stateOf(get('SELECT * FROM social_accounts WHERE account=?', accountText(account))),
    optIn(account, input = {}) {
      const id = accountText(account);
      requireValue(id);
      const existing = get('SELECT * FROM social_accounts WHERE account=?', id);
      const enabled = input.enabled === true;
      if (!enabled && !existing) return { optIn: false, minor: false, alias: null, avatarColor: null, onboardingSeen: false };
      // S4 契约：开启时服务端已生成化名+头像色；已有值优先（可再开启语义）
      const alias = existing?.alias || validateAlias(input.alias);
      const avatarColor = existing?.avatar_color || (isAvatarColor(input.avatarColor) ? input.avatarColor : null);
      requireValue(alias && avatarColor);
      const minor = enabled ? input.minor === true : !!existing?.is_minor;
      const stamp = now();
      const graphWrite = transaction(() => {
        db.prepare(`INSERT INTO social_accounts(account, alias, avatar_color, is_minor, opted_in, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(account) DO UPDATE SET alias=excluded.alias, avatar_color=excluded.avatar_color,
            is_minor=excluded.is_minor, opted_in=excluded.opted_in, updated_at=excluded.updated_at`)
          .run(id, alias, avatarColor, minor ? 1 : 0, enabled ? 1 : 0, existing?.created_at || stamp, stamp);
        return api.getState(id);
      });
      bumpGraphCache(); // 这张表在候选池面里：提交成功即失效
      return graphWrite;
    },
    setAlias(account, input = {}) {
      const id = accountText(account);
      requireValue(id && get('SELECT 1 AS one FROM social_accounts WHERE account=?', id), 'NOT_FOUND', 404);
      const alias = validateAlias(input.alias);
      requireValue(alias);
      const avatarColor = isAvatarColor(input.avatarColor) ? input.avatarColor : null;
      const graphWrite = transaction(() => {
        db.prepare('UPDATE social_accounts SET alias=?, avatar_color=COALESCE(?, avatar_color), updated_at=? WHERE account=?')
          .run(alias, avatarColor, now(), id);
        return api.getState(id);
      });
      bumpGraphCache(); // 这张表在候选池面里：提交成功即失效
      return graphWrite;
    },
    // 「已看过会分享什么」幂等标记（PRD §5）。账号行不存在时用调用方给的
    // 化名/头像色占位建档（opted_in=0）；之后的 /opt-in 会复用这个化名。
    markOnboardingSeen(account, input = {}) {
      const id = accountText(account);
      requireValue(id);
      const stamp = now();
      const graphWrite = transaction(() => {
        const existing = get('SELECT * FROM social_accounts WHERE account=?', id);
        if (existing) {
          db.prepare('UPDATE social_accounts SET onboarding_seen=1, updated_at=? WHERE account=?').run(stamp, id);
        } else {
          const alias = validateAlias(input.alias);
          const avatarColor = isAvatarColor(input.avatarColor) ? input.avatarColor : null;
          requireValue(alias && avatarColor, 'INVALID_INPUT');
          db.prepare(`INSERT INTO social_accounts(account, alias, avatar_color, is_minor, opted_in, onboarding_seen, created_at, updated_at)
            VALUES (?,?,?,?,0,1,?,?)`).run(id, alias, avatarColor, 0, stamp, stamp);
        }
        return api.getState(id);
      });
      bumpGraphCache(); // 这张表在候选池面里：提交成功即失效
      return graphWrite;
    },

    // ---- 每周画像（D2 白名单在存储边界） -----------------------------------
    saveProfile(account, features) {
      const id = accountText(account);
      const sanitized = sanitizeFeaturesUpload(features);
      requireValue(id && sanitized);
      const graphWrite = transaction(() => {
        db.prepare('INSERT OR REPLACE INTO profiles_weekly(account, week, features, uploaded_at) VALUES (?,?,?,?)')
          .run(id, sanitized.week, JSON.stringify(sanitized), now());
        return sanitized;
      });
      bumpGraphCache(); // 这张表在候选池面里：提交成功即失效
      return graphWrite;
    },
    getProfile: (account, week) => {
      const row = get('SELECT features FROM profiles_weekly WHERE account=? AND week=?', accountText(account), week);
      return row ? JSON.parse(row.features) : null;
    },
    poolCandidates(week, { allowMinors = false } = {}) {
      requireValue(typeof week === 'string' && week);
      return cachedGraph(`pool:${week}:${allowMinors ? 1 : 0}`, () => all(`SELECT s.account AS account, s.alias AS alias, s.avatar_color AS avatar_color, p.features AS features
        FROM social_accounts s JOIN profiles_weekly p ON p.account=s.account AND p.week=?
        WHERE s.opted_in=1 AND (?=1 OR s.is_minor=0)`, week, allowMinors ? 1 : 0)
        .map((row) => { const features = JSON.parse(row.features); return { account: row.account, graduations: features.graduations, record: { alias: row.alias, avatarColor: row.avatar_color, features } }; }));
    },
    // 是否同圈（kudos 圈级挑战「圈内互相加油」的判定面）。
    isCirclePeer: (account, other) => !!get(
      'SELECT 1 AS one FROM circle_members m1 JOIN circle_members m2 ON m2.circle_id=m1.circle_id WHERE m1.account=? AND m2.account=?',
      accountText(account), accountText(other)),
    circlePeerCandidates(account, week, { allowMinors = true } = {}) {
      const id = accountText(account);
      requireValue(id && typeof week === 'string' && week);
      return cachedGraph(`peers:${id}:${week}:${allowMinors ? 1 : 0}`, () => all(`SELECT DISTINCT s.account AS account, s.alias AS alias, s.avatar_color AS avatar_color, p.features AS features
        FROM circle_members mine
        JOIN circle_members theirs ON theirs.circle_id = mine.circle_id AND theirs.account <> ?
        JOIN social_accounts s ON s.account = theirs.account AND s.opted_in=1 AND (?=1 OR s.is_minor=0)
        JOIN profiles_weekly p ON p.account = theirs.account AND p.week=?
        WHERE mine.account=?`, id, allowMinors ? 1 : 0, week, id)
        .map((row) => { const features = JSON.parse(row.features); return { account: row.account, graduations: features.graduations, record: { alias: row.alias, avatarColor: row.avatar_color, features } }; }));
    },

    // ---- 分享事件 + 加油 ----------------------------------------------------
    recordSharedEvent(account, kind) {
      const id = accountText(account);
      requireValue(id && KUDOS_EVENT_KINDS.includes(kind));
      return transaction(() => {
        const eventId = randomUUID();
        db.prepare('INSERT INTO shared_events(id, owner_account, kind, at) VALUES (?,?,?,?)').run(eventId, id, kind, now());
        return { id: eventId, kind, owner: id };
      });
    },
    getSharedEvent: (owner, eventId) => {
      const row = get('SELECT * FROM shared_events WHERE id=? AND owner_account=?', eventId, accountText(owner));
      return row ? { id: row.id, kind: row.kind, owner: row.owner_account } : null;
    },
    // 仅按 id 反查（kudos 新形状：客户端只拿 sharedEventId，服务端自己找 owner，
    // 客户端永远不需要知道对方的 account id —— 化名体系 PRD §3.3/§5）。
    findSharedEvent: (eventId) => {
      const row = get('SELECT * FROM shared_events WHERE id=?', typeof eventId === 'string' ? eventId.trim() : '');
      return row ? { id: row.id, kind: row.kind, owner: row.owner_account } : null;
    },
    listSharedEvents: (owner, { limit = 50 } = {}) =>
      all('SELECT * FROM shared_events WHERE owner_account=? ORDER BY rowid LIMIT ?', accountText(owner), limit)
        .map((row) => ({ id: row.id, kind: row.kind, owner: row.owner_account, at: row.at })),
    // 「能被谁加油」面：本人确认分享的事件里，属于我的搭档或圈友的那部分
    // （PRD §4.3：可以对搭档或圈友的事件加油）。屏蔽过滤在 service 层做
    // （blocksInvolving 一次载入）。
    listShareableEvents(account, { limit = 20 } = {}) {
      const id = accountText(account);
      requireValue(id);
      return all(`SELECT e.id AS id, e.owner_account AS owner, e.kind AS kind, e.at AS at
        FROM shared_events e
        WHERE e.owner_account IN (
          SELECT b FROM pairs WHERE a=? UNION SELECT a FROM pairs WHERE b=?
          UNION SELECT m2.account FROM circle_members m1
            JOIN circle_members m2 ON m2.circle_id=m1.circle_id AND m2.account<>?
            WHERE m1.account=?
        )
        ORDER BY e.at DESC, e.rowid DESC LIMIT ?`, id, id, id, id, limit)
        .map((row) => ({ id: row.id, owner: row.owner, kind: row.kind, at: row.at }));
    },
    addKudos(entry) {
      const validated = validateKudos({ from: entry?.from, to: entry?.to, eventKind: entry?.eventKind, sharedEventId: entry?.sharedEventId });
      requireValue(validated);
      return transaction(() => {
        const existing = get('SELECT * FROM kudos WHERE from_account=? AND shared_event_id=?', validated.from, validated.sharedEventId);
        if (existing) return { id: existing.id, from: existing.from_account, to: existing.to_account, eventKind: existing.event_kind, sharedEventId: existing.shared_event_id, at: existing.at, duplicate: true };
        const id = randomUUID();
        const at = now();
        db.prepare('INSERT INTO kudos(id, from_account, to_account, event_kind, shared_event_id, at) VALUES (?,?,?,?,?,?)')
          .run(id, validated.from, validated.to, validated.eventKind, validated.sharedEventId, at);
        return { id, from: validated.from, to: validated.to, eventKind: validated.eventKind, sharedEventId: validated.sharedEventId, at, duplicate: false };
      });
    },
    listKudos: (account) => all('SELECT * FROM kudos WHERE to_account=? ORDER BY rowid', accountText(account))
      .map((row) => ({ id: row.id, from: row.from_account, to: row.to_account, eventKind: row.event_kind, sharedEventId: row.shared_event_id, at: row.at })),

    // ---- 传棒（D6） ---------------------------------------------------------
    createBatonShare(share, { parentShareId = null } = {}) {
      const id = share?.id || randomUUID();
      const built = {
        id, usageId: share?.usageId, fromAccount: share?.fromAccount,
        targetKind: share?.targetKind, targetId: share?.targetKind === 'link' ? null : share?.targetId,
        card: share?.card,
      };
      const validated = validateBatonShare(built);
      requireValue(validated);
      requireValue(!parentShareId || get('SELECT 1 AS one FROM baton_shares WHERE id=?', parentShareId), 'NOT_FOUND', 404);
      return transaction(() => {
        const stamp = now();
        db.prepare('INSERT INTO baton_shares(id, usage_id, from_account, target_kind, target_id, card, parent_share_id, created_week, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(validated.id, validated.usageId, validated.fromAccount, validated.targetKind, validated.targetId, JSON.stringify(validated.card), parentShareId, isoWeekOf(stamp), stamp);
        return shareOf(get('SELECT * FROM baton_shares WHERE id=?', validated.id));
      });
    },
    getBatonShare: (id) => shareOf(get('SELECT * FROM baton_shares WHERE id=?', id)),
    addBatonEvent(event) {
      requireValue(get('SELECT 1 AS one FROM baton_shares WHERE id=?', event?.batonId), 'NOT_FOUND', 404);
      const built = { id: event.id || randomUUID(), batonId: event.batonId, kind: event.kind, at: event.at || now(), byAccount: event.byAccount };
      const validated = validateBatonEvent(built);
      requireValue(validated);
      return transaction(() => {
        db.prepare('INSERT INTO baton_events(id, baton_id, kind, at, by_account) VALUES (?,?,?,?,?)')
          .run(validated.id, validated.batonId, validated.kind, validated.at, validated.byAccount);
        return validated;
      });
    },
    batonEvents: (batonId) => all('SELECT * FROM baton_events WHERE baton_id=? ORDER BY rowid', batonId).map(eventOf),
    // 传递链：父系 share 的发送者（最早发出的人在前）+ 本棒事件的参与人，按
    // 出现顺序去重。存储可长（D6）；视图封顶由调用方 clipBatonChain 完成。
    batonChain(batonId) {
      const senders = [];
      const walked = new Set();
      let cursor = get('SELECT * FROM baton_shares WHERE id=?', batonId);
      while (cursor) {
        senders.push(cursor.from_account);
        if (!cursor.parent_share_id || walked.has(cursor.parent_share_id)) break;
        walked.add(cursor.parent_share_id);
        cursor = get('SELECT * FROM baton_shares WHERE id=?', cursor.parent_share_id);
      }
      senders.reverse();
      const seen = new Set();
      const people = [];
      const push = (who) => { if (who && !seen.has(who)) { seen.add(who); people.push(who); } };
      senders.forEach(push);
      for (const row of all('SELECT by_account FROM baton_events WHERE baton_id=? ORDER BY rowid', batonId)) push(row.by_account);
      return people;
    },

    // ---- 接力搭档 -----------------------------------------------------------
    createPair(pair) {
      const id = pair?.id || randomUUID();
      const members = [pair?.a, pair?.b].sort(); // 规范序保证 UNIQUE(a,b) 语义
      const built = { id, a: members[0], b: members[1], startedWeek: pair?.startedWeek, flame: pair?.flame ?? 0, freezesUsed: pair?.freezesUsed ?? 0 };
      const validated = validatePair(built);
      requireValue(validated);
      return transaction(() => {
        try {
          db.prepare(`INSERT INTO pairs(id, a, b, started_week, flame, freezes_used, freezes_week, created_at) VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET a=excluded.a, b=excluded.b, started_week=excluded.started_week,
              flame=excluded.flame, freezes_used=excluded.freezes_used, freezes_week=excluded.freezes_week`)
            .run(validated.id, validated.a, validated.b, validated.startedWeek, validated.flame, validated.freezesUsed, null, now());
        } catch (error) {
          if (String(error?.code || error?.message).includes('UNIQUE')) throw socialError('PAIR_EXISTS', 409);
          throw error;
        }
        return pairOf(get('SELECT * FROM pairs WHERE id=?', validated.id));
      });
    },
    getPair: (id) => pairOf(get('SELECT * FROM pairs WHERE id=?', id)),
    listPairs: (account) => all('SELECT * FROM pairs WHERE a=? OR b=? ORDER BY rowid', accountText(account), accountText(account)).map(pairOf),
    pairCount: (account) => count('SELECT COUNT(*) AS count FROM pairs WHERE a=? OR b=?', accountText(account), accountText(account)),
    deletePair(id) { return transaction(() => { db.prepare('DELETE FROM pairs WHERE id=?').run(id); return { deleted: true }; }); },
    // 周预算专用读面：service 的「每周 1 次」预检用它与 store 层同口径按周
    // 重置（pairOf 的公共形状不含 freezes_week，白名单加键会炸 validatePair）。
    pairFreezeState: (id) => {
      const row = get('SELECT freezes_used, freezes_week FROM pairs WHERE id=?', id);
      return row ? { freezesUsed: row.freezes_used, freezesWeek: row.freezes_week } : null;
    },
    // 每周 PAIR_FREEZES_PER_WEEK 次冻结；换了周自动重置预算（freezes_week 锚定）。
    freezePair(id, { week } = {}) {
      return transaction(() => {
        const row = get('SELECT * FROM pairs WHERE id=?', id);
        requireValue(row, 'NOT_FOUND', 404);
        const targetWeek = week || isoWeekOf(now());
        const used = row.freezes_week === targetWeek ? row.freezes_used : 0;
        requireValue(used < PAIR_FREEZES_PER_WEEK, 'PAIR_FROZEN_ALREADY', 409);
        db.prepare('UPDATE pairs SET freezes_used=?, freezes_week=? WHERE id=?').run(used + 1, targetWeek, id);
        return pairOf(get('SELECT * FROM pairs WHERE id=?', id));
      });
    },

    // ---- 同频圈 -------------------------------------------------------------
    createCircle(input = {}) {
      const id = input.id || randomUUID();
      const inviteCode = input.inviteCode || randomCode();
      const owner = accountText(input.owner);
      const validated = validateCircle({ id, name: input.name, inviteCode });
      requireValue(validated && owner);
      requireValue(!get('SELECT 1 AS one FROM circles WHERE invite_code=?', inviteCode), 'CIRCLE_CODE_TAKEN', 409);
      const graphWrite = transaction(() => {
        const stamp = now();
        db.prepare('INSERT INTO circles(id, name, invite_code, owner_account, created_at) VALUES (?,?,?,?,?)').run(validated.id, validated.name, validated.inviteCode, owner, stamp);
        db.prepare('INSERT INTO circle_members(circle_id, account, joined_at) VALUES (?,?,?)').run(validated.id, owner, stamp);
        return circleOf(circleRow(validated.id));
      });
      bumpGraphCache(); // 这张表在候选池面里：提交成功即失效
      return graphWrite;
    },
    findCircleByInvite: (code) => circleOf(get('SELECT * FROM circles WHERE invite_code=?', code)),
    getCircle: (id) => circleOf(circleRow(id)),
    circleMemberCount: (id) => count('SELECT COUNT(*) AS count FROM circle_members WHERE circle_id=?', id),
    isCircleMember: (id, account) => !!get('SELECT 1 AS one FROM circle_members WHERE circle_id=? AND account=?', id, accountText(account)),
    circleOwner: (id) => circleRow(id)?.owner_account ?? null,
    joinCircle(id, account) {
      const member = accountText(account);
      requireValue(member && circleRow(id), 'NOT_FOUND', 404);
      if (api.isCircleMember(id, member)) return { joined: true };
      requireValue(api.circleMemberCount(id) < CIRCLE_MAX_MEMBERS, 'CIRCLE_FULL', 409);
      const graphWrite = transaction(() => {
        db.prepare('INSERT OR IGNORE INTO circle_members(circle_id, account, joined_at) VALUES (?,?,?)').run(id, member, now());
        return { joined: true };
      });
      bumpGraphCache(); // 这张表在候选池面里：提交成功即失效
      return graphWrite;
    },
    removeCircleMember(id, member) {
      requireValue(circleRow(id), 'NOT_FOUND', 404);
      const graphWrite = transaction(() => {
        db.prepare('DELETE FROM circle_members WHERE circle_id=? AND account=?').run(id, accountText(member));
        return { removed: true };
      });
      bumpGraphCache(); // 这张表在候选池面里：提交成功即失效
      return graphWrite;
    },
    // 圈主离开：有成员则交给最早加入的成员；独守则整圈级联删除。
    leaveCircle(id, account) {
      const graphWrite = transaction(() => {
        const circle = circleRow(id);
        requireValue(circle, 'NOT_FOUND', 404);
        const leaver = accountText(account);
        db.prepare('DELETE FROM circle_members WHERE circle_id=? AND account=?').run(id, leaver);
        if (circle.owner_account === leaver) {
          const heir = get('SELECT account FROM circle_members WHERE circle_id=? ORDER BY joined_at, rowid LIMIT 1', id);
          if (heir) db.prepare('UPDATE circles SET owner_account=? WHERE id=?').run(heir.account, id);
          else cascadeDeleteCircle(db, id);
        }
        return { left: true };
      });
      bumpGraphCache(); // 这张表在候选池面里：提交成功即失效
      return graphWrite;
    },
    listCircles: (account) => all('SELECT c.* FROM circles c JOIN circle_members m ON m.circle_id=c.id WHERE m.account=? ORDER BY c.rowid', accountText(account)).map(circleOf),

    // 圈主页聚合（D5：排名只按传棒/毕业；空出来的时间只出占比；链封顶 5 跳）。
    circleHome(id, week, viewer = null) {
      const circle = circleRow(id);
      requireValue(circle, 'NOT_FOUND', 404);
      const members = circleOf(circle).members;
      const marks = members.map(() => '?').join(',');
      const profiles = all(`SELECT account, features FROM profiles_weekly WHERE week=? AND account IN (${marks})`, week, ...members);
      const featuresBy = new Map(profiles.map((row) => [row.account, JSON.parse(row.features)]));
      // 用法墙：本周圈内成员用过的用法与人数
      const wallCounts = new Map();
      for (const features of featuresBy.values()) for (const usageId of features.usages || []) wallCounts.set(usageId, (wallCounts.get(usageId) || 0) + 1);
      const wall = [...wallCounts.entries()].map(([usageId, count]) => ({ usageId, count })).sort((x, y) => y.count - x.count || (x.usageId < y.usageId ? -1 : 1));
      // 传棒链：指向本圈的传棒经过的人（跨棒去重），视图封顶 5 跳（clipBatonChain）
      const chainSeen = new Set();
      const chainSource = [];
      for (const share of all("SELECT id FROM baton_shares WHERE target_kind='circle' AND target_id=?", id)) {
        for (const who of api.batonChain(share.id)) if (!chainSeen.has(who)) { chainSeen.add(who); chainSource.push(who); }
      }
      const chain = clipBatonChain(chainSource);
      // 空出来的时间：成员占比的均值，仍必须是能过校验的占比表
      let freedTo = null;
      if (profiles.length) {
        const sums = {};
        for (const features of featuresBy.values()) for (const [key, value] of Object.entries(features.freedTo)) sums[key] = (sums[key] || 0) + value;
        const mean = {};
        for (const key of Object.keys(sums)) mean[key] = sums[key] / profiles.length;
        freedTo = validateFreedToSummary(mean);
        requireValue(freedTo, 'SOCIAL_DATA_INVALID', 500);
      }
      // 圈内排名：只按传棒数与毕业数（D5），前 CIRCLE_RANK_SHOWN 名 + 你。
      // 传棒口径 = PRD §4.4/§8 北极星：发出的棒【被对方完成接力或毕业】才 +1
      // （EXISTS baton_events relay-completed/graduated）——零交互发棒不计数，
      // D5 防灌水。并列用 competition ranking（同名次），与 web/social/
      // circles.js circleRanking 纯函数同口径；「你」在前 3 内不重复输出。
      const batonsBy = new Map(all(`SELECT bs.from_account AS from_account, COUNT(*) AS n
        FROM baton_shares bs
        WHERE bs.created_week=? AND bs.from_account IN (${marks})
          AND EXISTS (SELECT 1 FROM baton_events be WHERE be.baton_id=bs.id AND be.kind IN ('relay-completed','graduated'))
        GROUP BY bs.from_account`, week, ...members).map((row) => [row.from_account, row.n]));
      const stateBy = new Map(all(`SELECT account, alias, avatar_color FROM social_accounts WHERE account IN (${marks})`, ...members).map((row) => [row.account, row]));
      const ranked = members.map((member) => ({
        member, batons: batonsBy.get(member) || 0, graduations: featuresBy.get(member)?.graduations || 0,
      })).sort((x, y) => y.batons - x.batons || y.graduations - x.graduations || (x.member < y.member ? -1 : 1));
      const rows = [];
      let viewerIndex = -1;
      ranked.forEach((row, index) => {
        const prev = rows[rows.length - 1];
        const rank = prev && prev.batons === row.batons && prev.graduations === row.graduations ? prev.rank : index + 1;
        if (viewer && row.member === viewer) viewerIndex = index;
        const state = stateBy.get(row.member);
        rows.push({ rank, alias: state?.alias || '同频圈友', avatarColor: state?.avatar_color || '#4C7A93', batons: row.batons, graduations: row.graduations });
      });
      const top = rows.slice(0, CIRCLE_RANK_SHOWN);
      const you = viewerIndex >= CIRCLE_RANK_SHOWN ? rows[viewerIndex] : null; // 在前 3 里已经可见，不重复
      const rankView = validateCircleRankView({ top, you });
      requireValue(rankView, 'SOCIAL_DATA_INVALID', 500);
      return { wall, chain, freedTo, rankView };
    },

    // ---- 周挑战 -------------------------------------------------------------
    addQuest(quest, { circleId = null } = {}) {
      const id = quest?.id || randomUUID();
      const validated = validateQuest({ id, week: quest?.week, scope: quest?.scope, title: quest?.title, target: quest?.target, unit: quest?.unit });
      requireValue(validated);
      requireValue((validated.scope === 'circle') === !!circleId); // circle 范围必须锚定一个真实圈
      requireValue(!circleId || circleRow(circleId), 'NOT_FOUND', 404);
      return transaction(() => {
        db.prepare('INSERT INTO quests(id, week, scope, title, target, unit, circle_id, created_at) VALUES (?,?,?,?,?,?,?,?)')
          .run(validated.id, validated.week, validated.scope, validated.title, validated.target, validated.unit, circleId, now());
        return questOf(get('SELECT * FROM quests WHERE id=?', validated.id));
      });
    },
    quest: (id) => questOf(get('SELECT * FROM quests WHERE id=?', id)),
    quests: (week) => all('SELECT * FROM quests WHERE week=? ORDER BY rowid', week).map(questOf),
    questsForCircle: (circleId, week) => all('SELECT * FROM quests WHERE circle_id=? AND (? IS NULL OR week=?) ORDER BY rowid', circleId, week ?? null, week ?? null).map(questOf),
    setQuestProgress(progress) {
      requireValue(get('SELECT 1 AS one FROM quests WHERE id=?', progress?.questId), 'NOT_FOUND', 404);
      const validated = validateQuestProgress(progress);
      requireValue(validated);
      return transaction(() => {
        db.prepare(`INSERT INTO quest_progress(quest_id, owner, scope, progress, done, updated_at) VALUES (?,?,?,?,?,?)
          ON CONFLICT(quest_id, owner) DO UPDATE SET progress=excluded.progress, done=excluded.done, updated_at=excluded.updated_at`)
          .run(validated.questId, validated.owner, validated.scope, validated.progress, validated.done ? 1 : 0, now());
        return progressOf(get('SELECT * FROM quest_progress WHERE quest_id=? AND owner=?', validated.questId, validated.owner));
      });
    },
    getQuestProgress: (questId, owner) => progressOf(get('SELECT * FROM quest_progress WHERE quest_id=? AND owner=?', questId, owner)),
    questFeedback(questId, account, type) {
      requireValue(get('SELECT 1 AS one FROM quests WHERE id=?', questId), 'NOT_FOUND', 404);
      requireValue(QUEST_FEEDBACK_TYPES.includes(type) && accountText(account));
      return transaction(() => {
        db.prepare('INSERT OR REPLACE INTO quest_feedback(quest_id, account, type, at) VALUES (?,?,?,?)').run(questId, accountText(account), type, now());
        return { recorded: true };
      });
    },

    // ---- 屏蔽与举报 ---------------------------------------------------------
    block(account, target) {
      const blocker = accountText(account);
      const blocked = accountText(target);
      requireValue(blocker && blocked);
      requireValue(blocker !== blocked);
      return transaction(() => {
        db.prepare('INSERT OR IGNORE INTO blocks(blocker_account, blocked_account, at) VALUES (?,?,?)').run(blocker, blocked, now());
        return { blocked: true };
      });
    },
    unblock(account, target) {
      return transaction(() => {
        const changes = db.prepare('DELETE FROM blocks WHERE blocker_account=? AND blocked_account=?').run(accountText(account), accountText(target)).changes;
        return { blocked: changes === 0 };
      });
    },
    listBlocks: (account) => all('SELECT blocked_account FROM blocks WHERE blocker_account=? ORDER BY rowid', accountText(account)).map((row) => row.blocked_account),
    blockedBetween: (a, b) => !!get('SELECT 1 AS one FROM blocks WHERE (blocker_account=? AND blocked_account=?) OR (blocker_account=? AND blocked_account=?)', a, b, b, a),
    // 与我相关的全部屏蔽对（两个方向一次载入）：匹配管线用它做 O(1) 过滤，
    // 替代逐候选 blockedBetween 的 1 万次往返（prepare 缓存后仍是纯开销）。
    blocksInvolving: (account) => new Set(all(
      'SELECT blocker_account AS a FROM blocks WHERE blocked_account=? UNION SELECT blocked_account AS a FROM blocks WHERE blocker_account=?',
      accountText(account), accountText(account)).map((row) => row.a)),
    report(entry = {}) {
      const reporter = accountText(entry.reporter);
      const reason = reasonText(entry.reason);
      const targetId = accountText(entry.targetId) || accountText(entry.account) || accountText(entry.circle) || accountText(entry.baton);
      const targetKind = entry.targetKind || (entry.account ? 'account' : entry.circle ? 'circle' : entry.baton ? 'baton' : 'account');
      requireValue(reporter && reason && targetId && ['account', 'circle', 'baton'].includes(targetKind));
      return transaction(() => {
        const id = randomUUID();
        const at = now();
        db.prepare('INSERT INTO reports(id, reporter_account, target_kind, target_id, reason, at) VALUES (?,?,?,?,?,?)').run(id, reporter, targetKind, targetId, reason, at);
        return { id, reporter, targetKind, targetId, reason, at };
      });
    },

    // ---- 删除我的数据（D2：级联彻底，一个事务） ------------------------------
    purgeAccount(account) {
      const id = accountText(account);
      requireValue(id);
      const graphWrite = transaction(() => {
        const deleted = {};
        const del = (table, sql, ...params) => { const changes = db.prepare(sql).run(...params).changes; if (changes) deleted[table] = (deleted[table] || 0) + changes; };
        // 1) 搭档：两人关系随删；指向该搭档关系的传棒一并清
        const pairIds = all('SELECT id FROM pairs WHERE a=? OR b=?', id, id).map((row) => row.id);
        if (pairIds.length) {
          const marks = pairIds.map(() => '?').join(',');
          del('baton_shares', `DELETE FROM baton_shares WHERE target_kind='pair' AND target_id IN (${marks})`, ...pairIds);
        }
        del('baton_shares', 'DELETE FROM baton_shares WHERE from_account=?', id);
        del('pairs', 'DELETE FROM pairs WHERE a=? OR b=?', id, id);
        // 2) 圈：退出所有圈；独守的圈主位触发整圈级联删除
        const myCircles = all('SELECT circle_id FROM circle_members WHERE account=?', id).map((row) => row.circle_id);
        del('circle_members', 'DELETE FROM circle_members WHERE account=?', id);
        for (const circleId of myCircles) {
          const circle = circleRow(circleId);
          if (!circle) continue;
          if (circle.owner_account === id) {
            const heir = get('SELECT account FROM circle_members WHERE circle_id=? ORDER BY joined_at, rowid LIMIT 1', circleId);
            if (heir) db.prepare('UPDATE circles SET owner_account=? WHERE id=?').run(heir.account, circleId);
            else {
              const removed = cascadeDeleteCircle(db, circleId);
              for (const table of Object.keys(removed)) if (removed[table]) deleted[table] = (deleted[table] || 0) + removed[table];
            }
          }
        }
        // 3) 其余各表逐一直清
        del('kudos', 'DELETE FROM kudos WHERE from_account=? OR to_account=?', id, id);
        del('baton_events', 'DELETE FROM baton_events WHERE by_account=?', id);
        del('quest_progress', 'DELETE FROM quest_progress WHERE owner=?', id);
        del('quest_feedback', 'DELETE FROM quest_feedback WHERE account=?', id);
        del('blocks', 'DELETE FROM blocks WHERE blocker_account=? OR blocked_account=?', id, id);
        del('reports', "DELETE FROM reports WHERE reporter_account=? OR (target_kind='account' AND target_id=?)", id, id);
        del('profiles_weekly', 'DELETE FROM profiles_weekly WHERE account=?', id);
        del('shared_events', 'DELETE FROM shared_events WHERE owner_account=?', id);
        del('social_accounts', 'DELETE FROM social_accounts WHERE account=?', id);
        return { account: id, deleted };
      });
      bumpGraphCache(); // 这张表在候选池面里：提交成功即失效
      return graphWrite;
    },

    // 逐表复核某账号的残留引用（delete-me unit 的证明工具，与 purge 同一套谓词）。
    accountReferences(account) {
      const id = accountText(account);
      requireValue(id);
      return {
        social_accounts: count('SELECT COUNT(*) AS count FROM social_accounts WHERE account=?', id),
        profiles_weekly: count('SELECT COUNT(*) AS count FROM profiles_weekly WHERE account=?', id),
        shared_events: count('SELECT COUNT(*) AS count FROM shared_events WHERE owner_account=?', id),
        kudos: count('SELECT COUNT(*) AS count FROM kudos WHERE from_account=? OR to_account=?', id, id),
        pairs: count('SELECT COUNT(*) AS count FROM pairs WHERE a=? OR b=?', id, id),
        baton_shares: count("SELECT COUNT(*) AS count FROM baton_shares WHERE from_account=? OR (target_kind='pair' AND target_id IN (SELECT id FROM pairs WHERE a=? OR b=?))", id, id, id),
        baton_events: count('SELECT COUNT(*) AS count FROM baton_events WHERE by_account=?', id),
        circles: count('SELECT COUNT(*) AS count FROM circles WHERE owner_account=?', id),
        circle_members: count('SELECT COUNT(*) AS count FROM circle_members WHERE account=?', id),
        quests: count('SELECT COUNT(*) AS count FROM quests WHERE circle_id IN (SELECT id FROM circles WHERE owner_account=?)', id),
        quest_progress: count('SELECT COUNT(*) AS count FROM quest_progress WHERE owner=?', id),
        quest_feedback: count('SELECT COUNT(*) AS count FROM quest_feedback WHERE account=?', id),
        blocks: count('SELECT COUNT(*) AS count FROM blocks WHERE blocker_account=? OR blocked_account=?', id, id),
        reports: count("SELECT COUNT(*) AS count FROM reports WHERE reporter_account=? OR (target_kind='account' AND target_id=?)", id, id),
      };
    },
  };
  return api;
}
