// web/story/store.js — 时光故事书的章节存储（SPEC design/story-recap/SPEC.md §6）。
//
// IO 层 over web/story/contracts.js：键名、版本、120 章上限、章节/心愿/文案
// 校验一律来自契约模块（STORY_STORE_KEY、STORY_STORE_VERSION、MAX_CHAPTERS、
// createChapter、validateChapter、validateWish、sanitizeCaptions、
// sanitizeStoreText），本模块不自定义形状。纯 ES module、无顶层 DOM；
// storage 注入，node --test 用假存储即可驱动全部行为（relay v2 的
// web/relay/store.js 先例）。
//
// ============================ 账号作用域（D9 同款）============================
// 章节只活在一个键上：'tango-donego.story.v1'（含 '.quarantine' 副作用键）。
// 存储链（pickStorage）：显式注入 > root.TangoAccountStorage（登录后由
// web/app-auth.js 的 scope() 设置）> root.localStorage 裸键（访客）。
// ⚠️ 二期集成点：web/app-auth.js scope() 的 key 正则目前【不含 story\.v1】
// （relay-v2 L9 只挂了 relay\.v2 一个 alternative）。挂钩未加之前，登录用户
// 的章节会经 TangoAccountStorage 透传到裸键（功能不受影响，仅未按账号隔
// 离）。把 story\.v1（含 .quarantine）加进该正则属二期接入，归 CTO 派单
// 的集成节点，本线不越界改 app-auth.js。
//
// ======================= 行为要点（对应 tests/unit/story-store.test.mjs）======================
// · 读取：sanitizeStoreText 全量消毒，非法章节丢弃；乱序入库按
//   (period.from, no) 升序排好 = 书架序；读操作零写入。
// · 淘汰策略（明确）：任何写入后超过 MAX_CHAPTERS=120 章时，按
//   (period.from, no) 排序保留最新 120 章，最老的被修剪。章号存在章节里，
//   修剪只删数据、绝不重排历史章号（contracts.js 头注的增补理由）。
// · 新增：createChapter 全量校验；同 type+period 幂等去重（重复添加拒绝，
//   与 scheduler 的 due 去重互为纵深）。
// · 局部更新：updateCaptions 合并保存用户编辑（空串删键，非法键被契约清
//   洗）；setWish 校验后落章，at 缺省以 options.now 盖章。
// · 隔离区：未知版本/坏 JSON 的原文先复制到 <key>.quarantine，复制成功主键
//   才允许被全新空库替换（SPEC §6「绝不覆盖」→ 数据零丢失）；复制失败进入
//   blocked 态：主键保持原样、一切持久化被拒绝。
// · 事务式提交：写盘失败即回滚内存。
// · clear()：写入空库而非删键（键存在本身防止任何惰性迁移复活旧数据），
//   同时清掉隔离区副本。
// · exportText()/readQuarantined() 供书架与隐私 UI 使用。

import {
  STORY_STORE_KEY, STORY_STORE_VERSION, MAX_CHAPTERS,
  createChapter, validateChapter, validateWish, sanitizeCaptions, sanitizeStoreText,
} from './contracts.js';

// 隔离区副作用键（契约把隔离区策略留给存储线，这里与 relay v2 同款后缀）。
export function storyQuarantineKey(key) {
  return String(key == null ? '' : key) + '.quarantine';
}

function storageAt(root, name) {
  try { return root ? root[name] : null; } catch (e) { return null; } // 禁用 localStorage 的浏览器在属性访问时就会抛
}

// D9 存储链：显式注入 > 登录账号作用域 > 访客本机裸键。
export function pickStorage(options) {
  options = options || {};
  if (options.storage) return options.storage;
  var root = options.root || (typeof globalThis !== 'undefined' ? globalThis : null);
  return storageAt(root, 'TangoAccountStorage') || storageAt(root, 'localStorage') || null;
}

function readText(storage, key) {
  try { return { ok: true, value: storage.getItem(key) }; } catch (e) { return { ok: false, value: null }; }
}
function writeText(storage, key, text) {
  try { storage.setItem(key, text); return true; } catch (e) { return false; }
}
function removeKey(storage, key) {
  try { storage.removeItem(key); return true; } catch (e) { return false; }
}

// 书架序 = 生成序：(period.from, no) 升序。淘汰保新按同一序剪尾。
function sortChapters(list) {
  return list.slice().sort(function (a, b) {
    var fa = a && a.period ? String(a.period.from == null ? '' : a.period.from) : '';
    var fb = b && b.period ? String(b.period.from == null ? '' : b.period.from) : '';
    if (fa !== fb) return fa < fb ? -1 : 1;
    return ((a && a.no) || 0) - ((b && b.no) || 0);
  });
}

function samePeriodKey(a, b) {
  return String(a.type) + '\u0000' + a.period.from + '\u0000' + a.period.to
    === String(b.type) + '\u0000' + b.period.from + '\u0000' + b.period.to;
}

export function createStoryStore(options) {
  options = options || {};
  var storage = pickStorage(options);
  var state = {
    status: 'empty', // 'ok' | 'empty' | 'quarantined' | 'blocked'
    quarantined: false,
    quarantineFailed: false,
    blocked: false,
  };
  var chapters = [];

  function persist() {
    if (!storage || state.blocked) return false;
    return writeText(storage, STORY_STORE_KEY, JSON.stringify({ v: STORY_STORE_VERSION, chapters: chapters }));
  }

  // 事务式提交：写盘失败即回滚内存。
  function commit(next) {
    var previous = chapters;
    chapters = next;
    if (persist()) return true;
    chapters = previous;
    return false;
  }

  if (!storage) {
    state.status = 'blocked';
    state.blocked = true;
  } else {
    var read = readText(storage, STORY_STORE_KEY);
    if (!read.ok) {
      state.status = 'blocked';
      state.blocked = true;
    } else {
      var parsed = sanitizeStoreText(read.value);
      if (parsed.status === 'unknown') {
        // SPEC §6：未知版本绝不覆盖 — 原文先进隔离区，搬成功才允许重开新库。
        if (writeText(storage, storyQuarantineKey(STORY_STORE_KEY), String(read.value))) {
          state.quarantined = true;
          state.status = 'quarantined';
          chapters = [];
          persist();
        } else {
          state.status = 'blocked';
          state.blocked = true;
          state.quarantineFailed = true;
        }
      } else if (parsed.status === 'ok') {
        state.status = 'ok';
        chapters = sortChapters(parsed.store.chapters); // 盘上乱序也排成书架序
      } else {
        state.status = 'empty'; // 全新访客：惰性 — 首次变更才写盘。
      }
    }
  }

  function findIndex(id) {
    var key = String(id == null ? '' : id);
    for (var i = 0; i < chapters.length; i += 1) {
      if (chapters[i] && chapters[i].id === key) return i;
    }
    return -1;
  }

  function patchChapter(id, mutate) {
    if (state.blocked) return false;
    var index = findIndex(id);
    if (index < 0) return false;
    var candidate = mutate(chapters[index]);
    if (!candidate) return false; // 非法补丁：内存与磁盘都不动。
    var next = chapters.slice();
    next[index] = candidate;
    return commit(next); // 文案/心愿补丁不影响排序
  }

  return {
    status: state.status,
    quarantined: state.quarantined,
    quarantineFailed: state.quarantineFailed,
    blocked: state.blocked,

    // 书架序章节列表（副本：外层数组的改动不影响库）。
    chapters: function () { return chapters.slice(); },

    get: function (id) {
      var index = findIndex(id);
      return index < 0 ? null : chapters[index];
    },

    count: function () { return chapters.length; },

    // 新增一章：全量校验（contracts.createChapter），同 type+period 幂等去重，
    // 超过 120 章修剪最老。返回落盘后的章节；失败返回 null。
    addChapter: function (fields, callOptions) {
      if (state.blocked) return null;
      var chapter = createChapter(fields || {}, callOptions || {});
      if (!chapter) return null;
      for (var i = 0; i < chapters.length; i += 1) {
        if (samePeriodKey(chapters[i], chapter)) return null; // 已有同键章节
      }
      var next = sortChapters(chapters.concat([chapter]));
      if (next.length > MAX_CHAPTERS) next = next.slice(next.length - MAX_CHAPTERS); // 保新剪老
      return commit(next) ? chapter : null;
    },

    // SPEC §5：用户可编辑任何一句，编辑后保存在章节里。patch 合并覆盖，
    // 空串删键，非法键被契约清洗。
    updateCaptions: function (id, patch) {
      return patchChapter(id, function (current) {
        return validateChapter(Object.assign({}, current, {
          captions: Object.assign({}, current.captions, patch || {}),
        }));
      });
    },

    // SPEC §3 ⑧：写给下一章的心愿存进本章。wish.at 缺省时以 options.now 盖章。
    setWish: function (id, wish) {
      return patchChapter(id, function (current) {
        var candidate = wish;
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate) && candidate.at == null) {
          var now = options.now == null ? Date.now() : options.now;
          candidate = Object.assign({}, candidate, { at: new Date(now).toISOString() });
        }
        var validated = validateWish(candidate);
        if (!validated) return null;
        return validateChapter(Object.assign({}, current, { wish: validated }));
      });
    },

    // 隐私「删除本机记录」：写空库而非删键，并清掉隔离区副本。
    clear: function () {
      if (state.blocked) return false;
      var previous = chapters;
      chapters = [];
      if (!persist()) { chapters = previous; return false; }
      removeKey(storage, storyQuarantineKey(STORY_STORE_KEY));
      return true;
    },

    exportText: function () {
      return JSON.stringify({ v: STORY_STORE_VERSION, chapters: chapters }, null, 2);
    },

    readQuarantined: function () {
      if (!storage) return null;
      var quarantined = readText(storage, storyQuarantineKey(STORY_STORE_KEY));
      return quarantined.ok ? quarantined.value : null;
    },
  };
}
