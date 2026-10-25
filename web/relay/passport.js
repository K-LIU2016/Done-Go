// web/relay/passport.js — AI 接力 v2 · L5 我的用法（#/me 护照）。
//
// Renders SPEC design/relay-v2/SPEC.md §4⑤ from the store delivered by the
// storage line and the scene library id→usage map:
//   - 三个统计：学会的用法 / AI 接力次数 / 自己做到的次数（第三个绿色 .stat.g）；
//   - 学会的用法卡片（2 列 .skills）：已毕业金色奖章（.m.gold），未毕业绿色（.m）；
//   - 最近记录（.hist 行）与只读详情（点开查看 + 复制）；
//   - 导出我的记录（JSON）；
//   - 再做一次 / 去试一次（onAgain(usageId) 回调，由集成线接到 #/relay）。
//
// Copy and DOM structure follow the prototype (D1 视觉为准): h1/lead/.stats/
// .sec/.skills/.hist/.grad verbatim from design/relay-v2/prototype.html
// s-passport and the m-passport.png shot. CSS classes live in web/relay/relay.css
// (another line); this module only emits matching markup.
//
// Pinned decisions for states the SPEC/prototype leave open (documented, not
// arbitrary):
//   - AI 接力次数 counts EVERY stored record: §5.4 keeps failed relays and an
//     attempted relay is still an AI 接力. This preserves the shot invariant
//     Σ(skill.接力) = 次 AI 接力 (4+3+1+1 = 9).
//   - Skill order: relayCount desc, then most recent record desc — the only
//     order consistent with the shot cards (4,3,1,1 with 昨天 before 10-21
//     among the 1-count ties).
//   - v1-migrated records (usageId null, contracts.js pin) join stats and the
//     recent list but never form skill cards; their sub line is date-only.
//   - A usageId missing from the scene lib renders as a retired usage card
//     (已下线的用法) instead of leaking the internal id.
//   - rating null renders a quiet '·' emoji slot (SPEC §1.5 fixes the three
//     rated emoji; unrated rows must not fake a rating).
//   - Day labels: 今天 / 昨天 / MM-DD (same year) / YYYY-MM-DD (other years),
//     local time (prototype shows 今天, 昨天, 10-22).
//   - SPEC §4④ "跳到 #/me 并高亮这个用法": highlightUsageId rings the card
//     with an inline token-colored outline so it is visible even before the
//     relay.css line lands (var(--gold,#E8B04B)).
//
// Pure module for everything except the thin controller: no DOM access at
// import time, directly importable by `node --test` like web/relay/contracts.js.
// The controller takes an injectable `root` (window-like) so unit tests can
// drive clicks/clipboard/downloads with stubs.

import { RATINGS } from './contracts.js';
import { mountShelf } from '../story/shelf.js';

var EVENT_ROW_MAX = 24;      // long event titles truncate with … (shot shows 读论文 Attention…)
var DEFAULT_RECENT_LIMIT = 10; // 最近 keeps the page short; store cap is 200
var HL_STYLE = 'outline:2px solid var(--gold,#E8B04B);outline-offset:2px';

// ---------------------------------------------------------------------------
// Strings — prototype copy verbatim (zh); override via options.strings for the
// future web/relay/i18n.js line (SPEC §6) without touching this file.
// ---------------------------------------------------------------------------

export function passportStrings() {
  return {
    title: '我的用法',
    lead: '你和 AI 一起做过的事，都在这里。',
    statLearned: '学会的用法',
    statRelays: '次 AI 接力',
    statGraduations: '次自己做到',
    secSkills: '学会的用法',
    secRecent: '最近',
    skillAgain: '再做一次 →',
    skillTry: '去试一次 →',
    skillRelayTpl: '接力 {n} 次',
    skillGradTpl: '自己做到 {m} 次',
    skillNoGrad: '还没自己试',
    gradBadge: '自己做到',
    emptySkills: '完成第一次接力，这里会出现你学会的第一个用法',
    exportJson: '导出我的记录（JSON）',
    back: '返回',
    aiTag: 'AI 生成 · 请你核对',
    readonly: '只读',
    copy: '复制',
    copied: '已复制 ✓',
    openAria: '查看记录：',
    failNote: 'AI 这次没接上，没有保存的结果。',
    retiredUsage: '已下线的用法',
    unrated: '未自评',
    today: '今天',
    yesterday: '昨天',
    ratingLabels: { much: '省了不少', little: '省了一点', none: '没省时间' },
  };
}

function mergeStrings(overrides) {
  var base = passportStrings();
  if (overrides && typeof overrides === 'object') {
    var keys = Object.keys(overrides);
    for (var i = 0; i < keys.length; i += 1) base[keys[i]] = overrides[keys[i]];
  }
  return base;
}

function fmt(tpl, values) {
  return String(tpl == null ? '' : tpl).replace(/\{(\w+)\}/g, function (all, key) {
    return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : all;
  });
}

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
  });
}

function text(value) {
  return esc(value).replace(/\n/g, '<br>');
}

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

// ---------------------------------------------------------------------------
// Usage lookup
// ---------------------------------------------------------------------------

export function toUsageMap(usages) {
  var map = Object.create(null);
  if (Array.isArray(usages)) {
    for (var i = 0; i < usages.length; i += 1) {
      var usage = usages[i];
      if (usage && usage.id != null) map[String(usage.id)] = usage;
    }
  } else if (usages && typeof usages === 'object') {
    var keys = Object.keys(usages);
    for (var j = 0; j < keys.length; j += 1) map[keys[j]] = usages[keys[j]];
  }
  return map;
}

// ---------------------------------------------------------------------------
// Stats — SPEC §4⑤ 三个统计
// ---------------------------------------------------------------------------

export function computeStats(records) {
  var list = Array.isArray(records) ? records : [];
  var learned = {};
  var relays = 0;
  var graduations = 0;
  for (var i = 0; i < list.length; i += 1) {
    var record = list[i];
    if (!record || typeof record !== 'object') continue;
    relays += 1;
    if (record.usageId != null) learned[String(record.usageId)] = true;
    if (record.graduated === true) graduations += 1;
  }
  return { learned: Object.keys(learned).length, relays: relays, graduations: graduations };
}

// ---------------------------------------------------------------------------
// Skill cards — 学会的用法（金色=已毕业 / 绿色=未毕业）
// ---------------------------------------------------------------------------

export function usageSummaries(records, usagesById, options) {
  var strings = mergeStrings(options && options.strings);
  var map = usagesById && typeof usagesById === 'object' ? usagesById : {};
  var acc = {};
  var order = [];
  var list = Array.isArray(records) ? records : [];
  for (var i = 0; i < list.length; i += 1) {
    var record = list[i];
    if (!record || typeof record !== 'object' || record.usageId == null) continue;
    var id = String(record.usageId);
    var entry = acc[id];
    if (!entry) {
      entry = acc[id] = { usageId: id, relayCount: 0, gradCount: 0, graduated: false, lastUsedAt: 0 };
      order.push(id);
    }
    entry.relayCount += 1;
    if (record.graduated === true) {
      entry.gradCount += 1;
      entry.graduated = true;
    }
    var stamp = Date.parse(String(record.at == null ? '' : record.at));
    if (!Number.isNaN(stamp) && stamp > entry.lastUsedAt) entry.lastUsedAt = stamp;
  }
  var skills = order.map(function (id) {
    var usage = map[id];
    var known = !!(usage && usage.title);
    return {
      usageId: id,
      title: known ? String(usage.title) : strings.retiredUsage,
      known: known,
      relayCount: acc[id].relayCount,
      gradCount: acc[id].gradCount,
      graduated: acc[id].graduated,
      lastUsedAt: acc[id].lastUsedAt,
    };
  });
  skills.sort(function (a, b) {
    return (b.relayCount - a.relayCount) || ((b.lastUsedAt || 0) - (a.lastUsedAt || 0));
  });
  return skills;
}

// ---------------------------------------------------------------------------
// Day labels + rating emoji
// ---------------------------------------------------------------------------

function dayKey(date) {
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}

function dayKeyToUtc(key) {
  return Date.UTC(Math.floor(key / 10000), Math.floor(key / 100) % 100 - 1, key % 100);
}

function toDate(value) {
  if (value instanceof Date) return value;
  var n = Number(value);
  return new Date(Number.isFinite(n) ? n : Date.now());
}

export function formatDayLabel(iso, now, strings) {
  var s = mergeStrings(strings);
  var stamp = Date.parse(String(iso == null ? '' : iso));
  if (Number.isNaN(stamp)) return '';
  var date = new Date(stamp);
  var today = toDate(now == null ? Date.now() : now);
  var recordKey = dayKey(date);
  var todayKey = dayKey(today);
  if (recordKey === todayKey) return s.today;
  // Calendar-day diff via UTC noon of the local y/m/d (DST safe).
  var days = Math.round((dayKeyToUtc(todayKey) - dayKeyToUtc(recordKey)) / 86400000);
  if (days === 1) return s.yesterday;
  if (date.getFullYear() === today.getFullYear()) return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
  return formatFullDay(iso);
}

export function formatFullDay(iso) {
  var stamp = Date.parse(String(iso == null ? '' : iso));
  if (Number.isNaN(stamp)) return '';
  var date = new Date(stamp);
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

export function ratingEmoji(rating) {
  if (rating === 'much') return '😀';
  if (rating === 'little') return '🙂';
  if (rating === 'none') return '😐';
  return '·';
}

// ---------------------------------------------------------------------------
// Export — SPEC §4⑤ 导出我的记录（JSON）
// ---------------------------------------------------------------------------

export function buildExportJson(store) {
  if (!store || typeof store !== 'object' || !Array.isArray(store.records)) return null;
  return JSON.stringify({ v: store.v, records: store.records }, null, 2);
}

export function exportFileName(now) {
  var date = toDate(now == null ? new Date() : now);
  return 'tango-donego-relay-' + date.getFullYear() + pad2(date.getMonth() + 1) + pad2(date.getDate()) + '.json';
}

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

export function buildPassportModel(records, usagesById, options) {
  var opts = options || {};
  var strings = mergeStrings(opts.strings);
  var list = (Array.isArray(records) ? records : []).filter(function (r) { return r && typeof r === 'object'; });
  var sorted = list.slice().sort(function (a, b) {
    var ta = Date.parse(String(a.at == null ? '' : a.at));
    var tb = Date.parse(String(b.at == null ? '' : b.at));
    if (Number.isNaN(tb)) tb = 0;
    if (Number.isNaN(ta)) ta = 0;
    return tb - ta;
  });
  var limit = opts.recentLimit == null ? DEFAULT_RECENT_LIMIT : Math.max(0, Number(opts.recentLimit) || 0);
  var recent = sorted.slice(0, limit).map(function (record) {
    var usage = record.usageId != null && usagesById ? usagesById[String(record.usageId)] : null;
    var day = formatDayLabel(record.at, opts.now, strings);
    var eventFull = String(record.event == null ? '' : record.event);
    var eventShort = eventFull.length > EVENT_ROW_MAX ? eventFull.slice(0, EVENT_ROW_MAX) + '…' : eventFull;
    return {
      id: record.id,
      at: record.at,
      emoji: ratingEmoji(record.rating),
      event: eventShort,
      eventFull: eventFull,
      sub: usage && usage.title ? day + ' · ' + String(usage.title) : day,
      graduated: record.graduated === true,
      rating: RATINGS.includes(record.rating) ? record.rating : null,
      failed: record.failed == null ? null : record.failed,
    };
  });
  return {
    stats: computeStats(list),
    skills: usageSummaries(list, usagesById, opts),
    recent: recent,
  };
}

// ---------------------------------------------------------------------------
// Renderers — HTML strings, prototype markup verbatim, all user text escaped
// ---------------------------------------------------------------------------

function skillCard(skill, strings, highlight) {
  var hl = highlight && skill.usageId === highlight;
  var caption = skill.graduated
    ? fmt(strings.skillRelayTpl, { n: skill.relayCount }) + ' · ' + fmt(strings.skillGradTpl, { m: skill.gradCount })
    : fmt(strings.skillRelayTpl, { n: skill.relayCount }) + ' · ' + strings.skillNoGrad;
  return '<div id="relay-skill-' + esc(skill.usageId) + '" class="skill' + (hl ? ' hl' : '') + '"' + (hl ? ' style="' + HL_STYLE + '"' : '') + '>'
    + '<div class="top2"><span class="m' + (skill.graduated ? ' gold' : '') + '"><svg aria-hidden="true"><use href="#i-medal"/></svg></span><b>' + esc(skill.title) + '</b></div>'
    + '<span>' + esc(caption) + '</span>'
    + '<button type="button" data-again="' + esc(skill.usageId) + '">' + esc(skill.graduated ? strings.skillAgain : strings.skillTry) + '</button>'
    + '</div>';
}

function histRow(row, strings) {
  return '<div class="row" role="button" tabindex="0" data-record-id="' + esc(row.id) + '" aria-label="' + esc(strings.openAria + row.eventFull) + '">'
    + '<span class="e" aria-hidden="true">' + row.emoji + '</span>'
    + '<div><b>' + esc(row.event) + '</b><span>' + esc(row.sub) + '</span></div>'
    + (row.graduated ? '<span class="grad">' + esc(strings.gradBadge) + '</span>' : '')
    + '</div>';
}

export function renderPassport(model, options) {
  var opts = options || {};
  var strings = mergeStrings(opts.strings);
  var data = model || { stats: { learned: 0, relays: 0, graduations: 0 }, skills: [], recent: [] };
  var stats = data.stats || { learned: 0, relays: 0, graduations: 0 };
  var html = ''
    + '<h1 style="margin-top:14px">' + esc(strings.title) + '</h1>'
    + '<p class="lead">' + esc(strings.lead) + '</p>'
    + '<div class="stats">'
    + '<div class="stat"><b>' + Number(stats.learned || 0) + '</b><span>' + esc(strings.statLearned) + '</span></div>'
    + '<div class="stat"><b>' + Number(stats.relays || 0) + '</b><span>' + esc(strings.statRelays) + '</span></div>'
    + '<div class="stat g"><b>' + Number(stats.graduations || 0) + '</b><span>' + esc(strings.statGraduations) + '</span></div>'
    + '</div>'
    + '<div class="sec"><h3>' + esc(strings.secSkills) + '</h3></div>';
  var skills = Array.isArray(data.skills) ? data.skills : [];
  if (!skills.length) {
    html += '<div class="empty">' + esc(strings.emptySkills) + '</div>';
  } else {
    html += '<div class="skills">' + skills.map(function (skill) {
      return skillCard(skill, strings, opts.highlightUsageId);
    }).join('') + '</div>';
  }
  html += '<section id="relay-story-shelf" data-slot="story-shelf" aria-label="我的故事书"></section>';
  var recent = Array.isArray(data.recent) ? data.recent : [];
  if (recent.length) {
    html += '<div class="sec"><h3>' + esc(strings.secRecent) + '</h3></div>'
      + '<div class="hist">' + recent.map(function (row) { return histRow(row, strings); }).join('') + '</div>';
  }
  html += '<button type="button" class="btn ghost wide" style="margin-top:16px" data-export>' + esc(strings.exportJson) + '</button>';
  return html;
}

export function renderRecordDetail(record, usagesById, options) {
  var opts = options || {};
  var strings = mergeStrings(opts.strings);
  var map = usagesById && typeof usagesById === 'object' ? usagesById : {};
  var usage = record && record.usageId != null ? map[String(record.usageId)] : null;
  var rating = record && RATINGS.includes(record.rating) ? record.rating : null;
  var meta = [formatDayLabel(record && record.at, opts.now, strings)];
  if (usage && usage.title) meta.push(String(usage.title));
  if (rating) meta.push(ratingEmoji(rating) + ' ' + strings.ratingLabels[rating]);
  if (record && record.graduated === true) meta.push(strings.gradBadge);
  meta.push(strings.readonly);
  var result = String(record && record.result == null ? '' : record.result);
  return ''
    + '<button type="button" class="back" data-back><svg aria-hidden="true"><use href="#i-left"/></svg>' + esc(strings.back) + '</button>'
    + '<div class="card">'
    + '<div class="run-h"><b>' + esc(record && record.event) + '</b>'
    + '<span class="ai-tag"><svg width="14" height="14" aria-hidden="true"><use href="#i-spark"/></svg>' + esc(strings.aiTag) + '</span></div>'
    + '<p class="evt">' + esc(meta.filter(Boolean).join(' · ')) + '</p>'
    + (record && record.failed != null ? '<div class="empty">' + esc(strings.failNote) + '</div>' : '')
    + (result ? '<div class="out">' + text(result) + '</div>' : '')
    + '<div class="res-actions"><button type="button" class="btn dark" data-copy-result="' + esc(record && record.id) + '"><svg aria-hidden="true"><use href="#i-copy"/></svg>' + esc(strings.copy) + '</button></div>'
    + '</div>';
}

// ---------------------------------------------------------------------------
// Controller — thin DOM glue; every dependency is injectable for tests.
//
// createPassport({
//   loadStore(): {v,records}|null        — storage line reader (required)
//   usagesById | usages: map|array       — scene library (required)
//   onAgain(usageId)                     — 再做一次/去试一次 navigation (integration)
//   root: window-like                    — defaults to window when present
//   now, strings, recentLimit, highlightUsageId
// }) → { mount(node), unmount(), render(), openRecord(id), closeDetail(),
//        highlightUsage(id), copyResult(id, button?), exportRecords() }
// ---------------------------------------------------------------------------

export function createPassport(options) {
  var opts = options || {};
  var strings = mergeStrings(opts.strings);
  var root = opts.root != null ? opts.root : (typeof window !== 'undefined' ? window : null);
  var node = null;
  var state = { view: 'list', recordId: null, highlightUsageId: opts.highlightUsageId || null };

  function usagesById() {
    return opts.usagesById || toUsageMap(opts.usages);
  }

  function records() {
    var store = typeof opts.loadStore === 'function' ? opts.loadStore() : null;
    return store && Array.isArray(store.records) ? store.records : [];
  }

  function findRecord(id) {
    var list = records();
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].id === id) return list[i];
    }
    return null;
  }

  function render() {
    if (!node) return;
    if (state.view === 'detail' && state.recordId) {
      var record = findRecord(state.recordId);
      if (record) {
        node.innerHTML = renderRecordDetail(record, usagesById(), { now: opts.now, strings: strings });
        return;
      }
      state.view = 'list';
      state.recordId = null;
    }
    node.innerHTML = renderPassport(buildPassportModel(records(), usagesById(), { now: opts.now, strings: strings }), {
      strings: strings,
      highlightUsageId: state.highlightUsageId,
    });
    var shelfHost = node.querySelector ? node.querySelector('#relay-story-shelf') : null;
    if (shelfHost) {
      var scoped = null;
      try { scoped = root && (root.TangoAccountStorage || root.localStorage); } catch (e) { scoped = null; }
      mountShelf(shelfHost, {
        loadText: function () {
          try { return scoped && typeof scoped.getItem === 'function' ? scoped.getItem('tango-donego.story.v1') : null; } catch (e) { return null; }
        },
        handlers: {
          onOpen: function (chapter) {
            if (typeof opts.onStoryOpen === 'function') opts.onStoryOpen(chapter);
            else if (root && root.location) root.location.hash = '#/story?chapter=' + encodeURIComponent(chapter.id);
          },
          onReplay: function (chapter) {
            if (typeof opts.onStoryReplay === 'function') opts.onStoryReplay(chapter);
            else if (root && root.location) root.location.hash = '#/story?chapter=' + encodeURIComponent(chapter.id);
          },
          onExportPoster: opts.onStoryExportPoster,
        },
      });
    }
  }

  function closest(el, selector) {
    return el && typeof el.closest === 'function' ? el.closest(selector) : null;
  }

  function attr(el, name) {
    return el && typeof el.getAttribute === 'function' ? el.getAttribute(name) : null;
  }

  function openRecord(id) {
    if (!id) return;
    state.view = 'detail';
    state.recordId = id;
    render();
  }

  function closeDetail() {
    state.view = 'list';
    state.recordId = null;
    render();
  }

  function flashCopied(button) {
    if (!button) return;
    var original = button.textContent;
    button.textContent = strings.copied;
    if (root && typeof root.setTimeout === 'function') {
      root.setTimeout(function () { button.textContent = original; }, 1200);
    }
  }

  function copyResult(id, button) {
    var record = id ? findRecord(id) : null;
    if (!record) return false;
    var value = String(record.result == null ? '' : record.result);
    var nav = root && root.navigator;
    if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
      flashCopied(button);
      nav.clipboard.writeText(value);
      return true;
    }
    // Legacy fallback: hidden textarea + execCommand, when clipboard API is
    // unavailable (older WebViews). Degrades to a silent false without a DOM.
    var doc = root && root.document;
    if (doc && typeof doc.createElement === 'function' && doc.body && typeof doc.execCommand === 'function') {
      var area = doc.createElement('textarea');
      area.value = value;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.left = '-9999px';
      doc.body.appendChild(area);
      area.select();
      var ok = false;
      try { ok = doc.execCommand('copy'); } catch { ok = false; }
      doc.body.removeChild(area);
      if (ok) flashCopied(button);
      return ok;
    }
    return false;
  }

  function exportRecords() {
    var json = buildExportJson(typeof opts.loadStore === 'function' ? opts.loadStore() : null);
    if (json == null) return false;
    var BlobCtor = root && root.Blob;
    var urlApi = root && (root.URL || root.webkitURL);
    var doc = root && root.document;
    if (!BlobCtor || !urlApi || typeof urlApi.createObjectURL !== 'function') return false;
    if (!doc || typeof doc.createElement !== 'function' || !doc.body) return false;
    var blob = new BlobCtor([json], { type: 'application/json' });
    var url = urlApi.createObjectURL(blob);
    var anchor = doc.createElement('a');
    anchor.href = url;
    anchor.download = exportFileName(new Date());
    doc.body.appendChild(anchor);
    anchor.click();
    doc.body.removeChild(anchor);
    if (typeof urlApi.revokeObjectURL === 'function') urlApi.revokeObjectURL(url);
    return true;
  }

  function handleClick(event) {
    if (!node || !event) return;
    var target = event.target;
    var again = closest(target, '[data-again]');
    if (again) {
      var usageId = attr(again, 'data-again');
      if (usageId && typeof opts.onAgain === 'function') opts.onAgain(usageId);
      return;
    }
    if (closest(target, '[data-back]')) {
      closeDetail();
      return;
    }
    var copyButton = closest(target, '[data-copy-result]');
    if (copyButton) {
      copyResult(attr(copyButton, 'data-copy-result'), copyButton);
      return;
    }
    if (closest(target, '[data-export]')) {
      exportRecords();
      return;
    }
    var row = closest(target, '[data-record-id]');
    if (row) openRecord(attr(row, 'data-record-id'));
  }

  function handleKeydown(event) {
    if (!node || !event) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    var row = closest(event.target, '[data-record-id]');
    if (!row) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    openRecord(attr(row, 'data-record-id'));
  }

  function mount(target) {
    node = target || null;
    if (!node) return;
    node.onclick = handleClick;
    node.onkeydown = handleKeydown;
    render();
  }

  function unmount() {
    if (node) {
      node.onclick = null;
      node.onkeydown = null;
    }
    node = null;
  }

  function highlightUsage(usageId) {
    state.highlightUsageId = usageId || null;
    render();
  }

  return {
    mount: mount,
    unmount: unmount,
    render: render,
    openRecord: openRecord,
    closeDetail: closeDetail,
    highlightUsage: highlightUsage,
    copyResult: copyResult,
    exportRecords: exportRecords,
  };
}
