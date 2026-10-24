// web/relay/store.js — AI 接力 v2 本地记录（SPEC §5.4，L9存储迁移线）。
//
// IO layer over web/relay/contracts.js: every shape/cap/enum comes from the
// contracts module (RELAY_STORE_KEY, MAX_RECORDS, sanitizeStoreText,
// migrateLegacyText, createRecord, sanitizeRecord, quarantineKey) — nothing is
// redefined here. Pure ES module, no top-level DOM; storage objects are
// injected so node --test can drive the whole surface with fakes.
//
// ============================ D9 账号作用域 ============================
// Records live under exactly one key: 'tango-donego.relay.v2' (plus its
// '.quarantine' sidecar). The calling convention is the v1 precedent from
// web/ai-relay.js, wired at web/index.html:760→1186:
//
//   window.TangoAppAuth.start(function (authUser) {
//     var relayStore = TangoRelayStore.createRelayStore({
//       storage: window.TangoAccountStorage,   // ← 登录后由 app-auth launch() 设置
//     });
//   });
//
// · 登录用户：web/app-auth.js 的 scope(user)（root.TangoAccountStorage）把
//   'tango-donego.relay.v2' 与 'tango-donego.relay.v2.quarantine' 重写为
//   'tango-donego.user.<id>.tango-donego.relay.v2*'。本线已对该文件做了
//   【最小挂钩】——scope() 的 key 正则加入 relay\.v2 一个 alternative（见
//   web/app-auth.js 内 [relay-v2 L9 D9] 注释）；挂钩的整体统筹归集成节点
//   （契约文件 contracts.js 头注亦指明该集成点）。
// · 访客（D5：不登录走完全流程）：root.TangoAccountStorage 未定义时自动
//   回退 root.localStorage 裸键，记录只存在本设备（SPEC §1.7）。
// · 登录/登出会触发 app-auth 的 location.reload()，app 重启后 createRelayStore
//   重新解析可用 storage，无需额外监听。
// · 访客→账号提升：SPEC §4④ 访客提示条承诺「登录后换手机也能看到」，由本
//   模块的 promoteGuestStore() 提供机制（按 event+at+result 去重合并，幂等，
//   账号侧 200 上限）；在登录时机调用它（例如保存/跨设备提示登录成功后）的
//   接线归集成节点。
// · 旧 ai-relay.v1 键【不】纳入 scope：v1 一直写在裸键上，迁移必须从它实际
//   所在的位置读（见 migrateLegacyText；v1 键只读不写）。
//
// ====================== 行为要点（对应单测 rv2-store.test.mjs）======================
// · 读取：sanitizeStoreText 全量消毒——非法记录不进主列表，读操作零写入。
// · 新增：新记录在最前（沿用 v1 unshift 的“最近优先”），写盘上限 200 条。
// · 迁移：仅在 v2 键不存在且 v1 键存在时执行一次（estimatedSavedMinutes 丢弃、
//   rating=null），迁移成功后 v2 键落盘，v1 键字节不变、永不回写。
// · 隔离区：未知版本/坏 JSON 的原文先复制到 <key>.quarantine，复制成功后主键
//   才允许被全新空库替换（SPEC §5.4「不覆盖」→ 数据零丢失）；复制失败则进入
//   blocked 态：主键保持原样、一切持久化被拒绝，直到用户处理。
// · clear()（#/more › 隐私与数据 › 删除本机记录）：写入空库而非删除键——v2 键
//   存在即保证 v1 不会被再次迁移（记录删了不复活）；同时清掉隔离区副本。
// · exportText()（§4⑤ 导出我的记录 JSON）与 readQuarantined() 供 UI 线使用。

import {
  RELAY_STORE_KEY, RELAY_STORE_VERSION, LEGACY_V1_STORE_KEY, MAX_RECORDS, RATINGS,
  quarantineKey, sanitizeStoreText, migrateLegacyText, createRecord, sanitizeRecord,
} from './contracts.js';

function storageAt(root, name) {
  try { return root ? root[name] : null; } catch (e) { return null; } // 禁用 localStorage 的浏览器在属性访问时就会抛
}

// D5/D9 storage 链：显式注入 > 登录账号作用域 > 访客本机裸键。
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

export function createRelayStore(options) {
  options = options || {};
  var storage = pickStorage(options);
  var state = {
    status: 'empty',       // 'ok' | 'empty' | 'migrated' | 'quarantined' | 'blocked'
    migratedCount: 0,
    quarantined: false,
    quarantineFailed: false,
    blocked: false,
  };
  var records = [];

  function persist() {
    if (!storage || state.blocked) return false;
    return writeText(storage, RELAY_STORE_KEY, JSON.stringify({ v: RELAY_STORE_VERSION, records: records }));
  }

  // 事务式提交：写盘失败即回滚内存（沿用 v1 save() 的先写后验思路）。
  function commit(next) {
    var previous = records;
    records = next;
    if (persist()) return true;
    records = previous;
    return false;
  }

  if (!storage) {
    state.status = 'blocked';
    state.blocked = true;
  } else {
    var read = readText(storage, RELAY_STORE_KEY);
    if (!read.ok) {
      state.status = 'blocked';
      state.blocked = true;
    } else {
      var parsed = sanitizeStoreText(read.value);
      if (parsed.status === 'unknown') {
        // SPEC §5.4：未知版本时不覆盖——先把原文搬进隔离区，搬成功才允许替换主键。
        if (writeText(storage, quarantineKey(RELAY_STORE_KEY), String(read.value))) {
          state.quarantined = true;
          state.status = 'quarantined';
          records = [];
          persist();
        } else {
          state.status = 'blocked';
          state.blocked = true;
          state.quarantineFailed = true;
        }
      } else if (parsed.status === 'empty') {
        // 一次性 v1 迁移：仅在 v2 键不存在时触发；成功即落盘，之后永不再跑。
        var legacy = readText(storage, LEGACY_V1_STORE_KEY);
        var migration = legacy.ok ? migrateLegacyText(legacy.value, { now: options.now, uuids: options.uuids }) : { status: 'empty' };
        if (migration.status === 'ok') {
          records = migration.store.records;
          state.migratedCount = migration.store.records.length;
          state.status = 'migrated';
          persist();
        } else {
          state.status = 'empty'; // 全新访客：惰性——首次变更才写盘。
        }
      } else {
        state.status = 'ok';
        records = parsed.store.records;
      }
    }
  }

  function all() { return records.slice(); }

  function add(fields, callOptions) {
    if (state.blocked) return null;
    var record = createRecord(fields || {}, callOptions || {});
    if (!record) return null;
    var next = [record].concat(records).slice(0, MAX_RECORDS);
    return commit(next) ? record : null;
  }

  function patch(id, mutate) {
    if (state.blocked) return false;
    var next = null;
    for (var i = 0; i < records.length; i += 1) {
      if (records[i].id !== id) continue;
      var candidate = mutate(records[i]);
      if (!candidate) return false; // 非法补丁：内存与磁盘都不动。
      next = records.slice();
      next[i] = candidate;
      break;
    }
    if (!next) return false;
    return commit(next);
  }

  function setRating(id, rating) {
    return patch(id, function (record) {
      if (rating == null || !RATINGS.includes(rating)) return null;
      return sanitizeRecord(Object.assign({}, record, { rating: rating }));
    });
  }

  function graduate(id, appId) {
    return patch(id, function (record) {
      return sanitizeRecord(Object.assign({}, record, {
        graduated: true,
        graduatedApp: appId == null ? null : String(appId),
      }));
    });
  }

  function replaceResult(id, result) {
    return patch(id, function (record) {
      return sanitizeRecord(Object.assign({}, record, { result: String(result == null ? '' : result) }));
    });
  }

  function clear() {
    if (state.blocked) return false;
    var previous = records;
    records = [];
    if (!persist()) { records = previous; return false; }
    removeKey(storage, quarantineKey(RELAY_STORE_KEY)); // 删除本机记录时一并清掉隔离区副本。
    return true;
  }

  function exportText() {
    return JSON.stringify({ v: RELAY_STORE_VERSION, records: records }, null, 2);
  }

  function readQuarantined() {
    if (!storage) return null;
    var quarantined = readText(storage, quarantineKey(RELAY_STORE_KEY));
    return quarantined.ok ? quarantined.value : null;
  }

  return {
    status: state.status,
    migratedCount: state.migratedCount,
    quarantined: state.quarantined,
    quarantineFailed: state.quarantineFailed,
    blocked: state.blocked,
    all: all,
    add: add,
    setRating: setRating,
    graduate: graduate,
    replaceResult: replaceResult,
    clear: clear,
    exportText: exportText,
    readQuarantined: readQuarantined,
  };
}

// 访客→账号提升（§4④ 访客提示条「登录后换手机也能看到」的机制，接线归集成
// 节点，见文件头 D9 说明）。从 root.localStorage 的裸键读访客库，合并进
// accountStorage 作用域库：按 event+at+result 三元组去重（v1 双侧迁移出的同
// 源记录也会因此折叠），按 at 降序（稳定排序，同刻账号侧在前），账号侧 200
// 上限。访客副本不删——幂等，重复调用只报告 duplicates。访客库是未知版本时
// 原样跳过（skipped:'unknown'）；账号侧读写失败返回 null 且不写任何东西。
export function promoteGuestStore(options) {
  options = options || {};
  var guest = options.guestStorage || storageAt(options.root || (typeof globalThis !== 'undefined' ? globalThis : null), 'localStorage');
  var account = options.accountStorage || options.storage;
  if (!guest || !account) return null;

  var guestRead = readText(guest, RELAY_STORE_KEY);
  if (!guestRead.ok) return null;
  var guestParsed = sanitizeStoreText(guestRead.value);
  if (guestParsed.status === 'unknown') return { added: 0, duplicates: 0, skipped: 'unknown' };
  var guestRecords = guestParsed.status === 'ok' ? guestParsed.store.records : [];
  if (!guestRecords.length) return { added: 0, duplicates: 0 };

  var accountRead = readText(account, RELAY_STORE_KEY);
  if (!accountRead.ok) return null;
  var accountParsed = sanitizeStoreText(accountRead.value);
  if (accountParsed.status === 'unknown') return null; // 账号侧未知版本交给隔离区流程，不在提升里碰。
  var merged = accountParsed.status === 'ok' ? accountParsed.store.records.slice() : [];

  var seen = {};
  merged.forEach(function (record) { seen[record.event + '\u0000' + record.at + '\u0000' + record.result] = true; });
  var duplicates = 0;
  var pushed = [];
  guestRecords.forEach(function (record) {
    var fingerprint = record.event + '\u0000' + record.at + '\u0000' + record.result;
    if (seen[fingerprint]) { duplicates += 1; return; }
    seen[fingerprint] = true;
    pushed.push(record); // 本次调用真正新引入的访客记录（重提升时账号侧已有的同源记录走 duplicates）。
    merged.push(record);
  });
  merged.sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0; });
  merged = merged.slice(0, MAX_RECORDS);

  if (!writeText(account, RELAY_STORE_KEY, JSON.stringify({ v: RELAY_STORE_VERSION, records: merged }))) return null;
  var pushedIds = {};
  pushed.forEach(function (record) { pushedIds[record.id] = true; });
  var added = 0;
  merged.forEach(function (record) { if (pushedIds[record.id]) added += 1; });
  return { added: added, duplicates: duplicates };
}
