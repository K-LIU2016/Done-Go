// web/relay/sync-tab.js — #/sync 同频正式接入（I3同频）。
//
// 只负责正式 app 的装配：同频页的视觉和纯 UI 由 web/social/home.js，
// 搭档/圈/挑战由 web/social/* 各自模块；本文件负责账号作用域读取、
// 本地聚合特征白名单上传、流派卡计算、传棒接入和四段纵向页面。
// 不复用 lab 的 demo seed、翻页或硬编码示例账号。

import { createSocialHome } from '../social/home.js';
import { createOnboarding } from '../social/onboarding.js';
import { computeWeeklyFeatures, featuresUploadPayload, styleCardFromFeatures } from '../social/features-client.js';
import { mountSendSheet } from '../social/baton.js';
import { validateUsage } from './contracts.js';

export const SYNC_TAB_ID = 'sync';
export const SYNC_UPLOAD_PATH = '/api/social/profile';
export const SYNC_SECTIONS = Object.freeze(['style', 'matches', 'pairs', 'circle', 'quests']);

const SOCIAL_UPLOAD_WEEK_KEY = 'tango-donego.social.uploaded-week.v1';
const RELAY_STORE_KEY = 'tango-donego.relay.v2';
const LEDGER_KEY = 'tango-donego.web.v1';
const COPY = {
  title: '同频',
  privacy: '只上传聚合特征：事项类别、时段占比、用法编号和你确认过的去向。标题、材料、结果、具体时间和地点不会上传。',
  enable: '开启同频',
  refresh: '重新计算',
  upload: '本周特征已更新',
  uploadMissing: '还缺一点本周数据，完成几件事后再来看看。',
  uploadFailed: '同频数据暂时没更新，页面仍可浏览。',
  optOut: '关闭同频',
  optOutDone: '已关闭同频；服务端数据会按隐私流程删除。',
  pairs: '我的搭档',
  circle: '我的圈',
  quests: '本周挑战',
  emptyPairs: '还没有搭档。去推荐卡上和一位同频的人结为搭档吧。',
  emptyCircle: '还没有加入圈。用邀请码加入课题组、班级或团队。',
  emptyQuests: '本周挑战还没有准备好。',
  baton: '传给 TA',
  batonClose: '收起传棒',
  shareUsage: '选择一个已学会的用法，把不含个人内容的用法卡传出去。',
};

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}

function jsonResponse(response) {
  return response && typeof response.json === 'function' ? response.json().catch(function () { return null; }) : Promise.resolve(null);
}

function rootStorage(root) {
  try { return root && (root.TangoAccountStorage || root.localStorage); } catch { return null; }
}

function ensureSocialStyles(doc) {
  if (!doc || typeof doc.querySelector !== 'function' || typeof doc.createElement !== 'function') return;
  if (doc.querySelector('link[data-donego-social-css]')) return;
  var link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/social/social.css';
  link.setAttribute('data-donego-social-css', '1');
  if (doc.head && typeof doc.head.appendChild === 'function') doc.head.appendChild(link);
}

function readJson(storage, key) {
  if (!storage || typeof storage.getItem !== 'function') return null;
  try {
    var raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function readLedger(root) {
  var storage = rootStorage(root);
  var state = readJson(storage, LEDGER_KEY);
  return state && Array.isArray(state.entries) ? state.entries : [];
}

function readRelayRecords(root) {
  var storage = rootStorage(root);
  var state = readJson(storage, RELAY_STORE_KEY);
  return state && Array.isArray(state.records) ? state.records : [];
}

function currentWeekFromDate(date) {
  var d = date instanceof Date ? date : new Date(date == null ? Date.now() : date);
  if (Number.isNaN(d.getTime())) return null;
  var day = (d.getDay() + 6) % 7;
  var monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
  var thursday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 3);
  var first = new Date(thursday.getFullYear(), 0, 1);
  var week = 1 + Math.round((thursday.getTime() - first.getTime()) / 604800000);
  return thursday.getFullYear() + '-W' + String(week).padStart(2, '0');
}

function usageMap(usages) {
  var out = {};
  (Array.isArray(usages) ? usages : []).forEach(function (usage) {
    if (usage && usage.id) out[usage.id] = usage;
  });
  return out;
}

function methodName(usage) {
  return usage && usage.title ? usage.title : '';
}

function accountId(root) {
  var user = root && root.TangoCurrentUser;
  return user && (user.id || user.accountId || user.username) ? String(user.id || user.accountId || user.username) : null;
}

function fetcher(root) {
  return root && typeof root.fetch === 'function' ? root.fetch.bind(root) : null;
}

function safeMetric(root, name) {
  var fetch = fetcher(root);
  if (!fetch || !name) return;
  try {
    fetch('/api/metrics', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: String(name) }), keepalive: true,
    }).catch(function () {});
  } catch { /* count-only telemetry never blocks UI */ }
}

function batonUsageList(usages, records) {
  var map = usageMap(usages);
  var seen = {};
  var list = [];
  (Array.isArray(records) ? records : []).forEach(function (record) {
    if (!record || record.failed != null || !record.usageId || seen[record.usageId]) return;
    var usage = map[record.usageId];
    if (!usage || !validateUsage(usage)) return;
    seen[record.usageId] = true;
    list.push(usage);
  });
  return list;
}

function aggregateLocal(root, week) {
  var result = computeWeeklyFeatures({ entries: readLedger(root), records: readRelayRecords(root) }, { week: week });
  return { result: result, payload: result.ok ? featuresUploadPayload(result) : null };
}

function localUploadMarker(root) {
  return readJson(rootStorage(root), SOCIAL_UPLOAD_WEEK_KEY);
}

function markUploaded(root, week) {
  var storage = rootStorage(root);
  if (!storage || typeof storage.setItem !== 'function') return;
  try { storage.setItem(SOCIAL_UPLOAD_WEEK_KEY, JSON.stringify({ v: 1, week: week })); } catch { /* best effort */ }
}

function requestJson(root, path, init) {
  var fetch = fetcher(root);
  if (!fetch) return Promise.resolve({ ok: false, status: 0, body: null });
  return fetch(path, init).then(function (response) {
    return jsonResponse(response).then(function (body) { return { ok: !!response.ok, status: response.status, body: body }; });
  }).catch(function () { return { ok: false, status: 0, body: null }; });
}

function postJson(root, path, body) {
  return requestJson(root, path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

function sectionHeader(title, note) {
  return '<div class="sec"><h3>' + esc(title) + '</h3>' + (note ? '<span>' + esc(note) + '</span>' : '') + '</div>';
}

function batonUsageHtml(usage, options) {
  var title = methodName(usage);
  var label = options && options.open ? COPY.batonClose : COPY.baton;
  return '<button type="button" class="sync-usage" data-sync-usage="' + esc(usage.id) + '">'
    + '<span class="sync-usage-medal" aria-hidden="true">✓</span><span>' + esc(title) + '</span>'
    + '<strong>' + esc(label) + '</strong></button>';
}

function pairHtml(pair, current, aliases) {
  var other = pair.a === current ? pair.b : pair.a;
  var alias = aliases[other] || '同频搭档';
  var flame = Number.isFinite(pair.flame) ? pair.flame : 0;
  return '<article class="sync-pair"><span class="sync-avatar" aria-hidden="true">' + esc(Array.from(alias).slice(-1).join('') || '搭') + '</span>'
    + '<div><b>' + esc(alias) + '</b><p>火苗 ' + flame + ' · 每天各接力 1 次</p></div>'
    + '<span class="sync-flame" aria-label="火苗 ' + flame + '">🔥 ' + flame + '</span></article>';
}

function circleHtml(circle, home) {
  var body = '<h4>' + esc(circle.name || '我的圈') + '<small>' + esc(String(circle.memberCount || 0)) + ' 人</small></h4>';
  var wall = home && Array.isArray(home.wall) ? home.wall : [];
  if (wall.length) {
    body += '<div class="sync-wall">' + wall.map(function (item) {
      return '<span>' + esc(item.usageId) + ' ×' + esc(item.count) + '</span>';
    }).join('') + '</div>';
  } else body += '<p class="sync-muted">本周还没有学会的用法。</p>';
  if (home && home.freedTo) {
    var keys = ['family', 'exercise', 'study', 'rest', 'hobby', 'other'];
    body += '<div class="sync-freed" aria-label="圈内空出来的时间去向（仅占比）">'
      + keys.filter(function (key) { return home.freedTo[key] > 0; }).map(function (key) {
        return '<span style="--share:' + Math.round(home.freedTo[key] * 100) + '%"><i></i>' + esc(key) + ' ' + Math.round(home.freedTo[key] * 100) + '%</span>';
      }).join('') + '</div>';
  }
  if (home && home.rank) {
    body += '<div class="sync-rank">' + (home.rank.top || []).map(function (row) {
      return '<div><b>' + row.rank + '</b><span>' + esc(row.alias) + '</span><em>传棒 ' + row.batons + '</em></div>';
    }).join('') + (home.rank.you ? '<div class="you"><b>' + home.rank.you.rank + '</b><span>你</span><em>传棒 ' + home.rank.you.batons + '</em></div>' : '') + '</div>';
  }
  return '<article class="sync-circle">' + body + '</article>';
}

function questHtml(item) {
  var quest = item && item.quest;
  var progress = item && item.progress;
  if (!quest || !progress) return '';
  var ratio = quest.target > 0 ? Math.min(1, Math.max(0, progress.progress / quest.target)) : 0;
  return '<article class="sync-quest"><div><b>' + esc(quest.title) + '</b><span>' + esc(progress.progress) + '/' + esc(quest.target) + ' ' + esc(quest.unit) + '</span></div>'
    + '<div class="sync-progress"><i style="width:' + Math.round(ratio * 100) + '%"></i></div>'
    + '<button type="button" data-sync-feedback="' + esc(quest.id) + '">太多了</button></article>';
}

export function relayBatonBridge(options) {
  var o = options || {};
  var root = o.root || (typeof window !== 'undefined' ? window : null);
  var target = o.target || null;
  var usage = o.usage || null;
  var current = o.currentAccount || accountId(root);
  var targets = Array.isArray(o.targets) ? o.targets : [];
  if (!target || !usage || !validateUsage(usage)) return null;
  target.innerHTML = '<div class="sync-baton-head"><b>' + esc(COPY.shareUsage) + '</b><button type="button" data-sync-baton-close aria-label="' + esc(COPY.batonClose) + '">×</button></div><div class="sync-baton-host"></div>';
  var host = target.querySelector ? target.querySelector('.sync-baton-host') : target;
  var controller = mountSendSheet(host, {
    usage: usage, fromAccount: current || 'guest', targets: targets, root: root,
    onSend: function (out) {
      if (!out || !out.share) return;
      postJson(root, '/api/social/baton', {
        targetKind: out.share.targetKind, targetId: out.share.targetId, card: out.share.card,
      }).then(function (response) {
        if (response.ok && typeof o.onSent === 'function') o.onSent(response.body);
      });
    },
  });
  var close = function () {
    if (controller && controller.unmount) controller.unmount();
    target.innerHTML = '';
    if (typeof o.onClose === 'function') o.onClose();
  };
  if (target.addEventListener) target.addEventListener('click', function (event) {
    var node = event.target && event.target.closest ? event.target.closest('[data-sync-baton-close]') : null;
    if (node) close();
  });
  return { close: close, controller: controller };
}

export function syncTabView(state) {
  var s = state || {};
  var card = s.styleCard;
  var html = '<div class="sync-page">'
    + '<div class="sync-header"><div><p class="sync-kicker">每周一次，和做事方式相近的人一起接力</p><h1>' + esc(COPY.title) + '</h1></div>'
    + (s.optIn ? '<button type="button" class="sync-privacy" data-sync-optout>' + esc(COPY.optOut) + '</button>' : '') + '</div>'
    + '<p class="sync-privacy-note">' + esc(COPY.privacy) + '</p>';
  if (!s.account && s.preview) {
    var previewStyles = Array.isArray(s.preview.styles) ? s.preview.styles.slice(0, 3) : [];
    html += '<section class="sync-gate"><h2>同频预览</h2><p>登录后开启同频，才能上传本地聚合特征并看到真实推荐。预览不展示真实用户。</p><div class="sync-preview-list">'
      + previewStyles.map(function (style) { return '<div class="sync-preview-card" aria-hidden="true"><b>' + esc(style.label) + '</b><span>' + esc(style.motto) + '</span></div>'; }).join('')
      + '</div><a class="btn pri wide" href="#settings">去登录，开启同频</a></section></div>';
    return html;
  }
  if (!s.optIn) {
    html += '<section class="sync-gate"><h2>同频默认关闭</h2><p>开启前先看清楚会分享什么。你可以随时关闭并删除服务端数据。</p><button type="button" class="btn pri wide" data-sync-onboard>' + esc(COPY.enable) + '</button></section></div>';
    return html;
  }
  if (card) {
    html += '<section class="sync-style-summary"><small>本周你的时间流派 · ' + esc(card.week) + '</small><h2>' + esc(card.label) + '</h2><p>' + esc(card.motto) + '</p></section>';
  } else html += '<section class="sync-pending"><b>本周流派还没算好</b><p>' + esc(s.uploadMessage || COPY.uploadMissing) + '</p><button type="button" data-sync-refresh>' + esc(COPY.refresh) + '</button></section>';
  html += '<section class="sync-matches" aria-label="同频首页"><h3 class="sync-section-label">本周和你同频</h3><div class="soc" data-sync-home></div></section>';
  html += '<section class="sync-subsection">' + sectionHeader(COPY.pairs, '最多 5 位') + '<div class="sync-pairs">' + (s.pairs.length ? s.pairs.map(function (pair) { return pairHtml(pair, s.account, s.aliases); }).join('') : '<p class="sync-muted">' + esc(COPY.emptyPairs) + '</p>') + '</div></section>';
  html += '<section class="sync-subsection">' + sectionHeader(COPY.circle, '邀请码加入') + '<div class="sync-circles">' + (s.circles.length ? s.circles.map(function (circle, index) { return circleHtml(circle, s.circleHomes[index]); }).join('') : '<p class="sync-muted">' + esc(COPY.emptyCircle) + '</p>') + '</div></section>';
  html += '<section class="sync-subsection"><span class="sync-section-label">' + esc(COPY.quests) + '</span>' + sectionHeader(COPY.quests, '每周 3 个') + '<div class="sync-quests">' + (s.quests.length ? s.quests.map(questHtml).join('') : '<p class="sync-muted">' + esc(COPY.emptyQuests) + '</p>') + '</div></section>';
  html += '<section class="sync-usages">' + sectionHeader('我的用法', '把学会的用法传给 TA') + '<p class="sync-muted">' + esc(COPY.shareUsage) + '</p>' + (s.usages || []).map(function (usage) { return batonUsageHtml(usage, { open: s.openUsageId === usage.id }); }).join('') + '</section>';
  html += '<div class="sync-baton" data-sync-baton></div><p class="sync-status" role="status">' + esc(s.status || '') + '</p></div>';
  return html;
}

export function createSyncTab(options) {
  var o = options || {};
  var root = o.root || (typeof window !== 'undefined' ? window : null);
  var doc = o.doc || (root && root.document) || (typeof document !== 'undefined' ? document : null);
  var target = null;
  var home = null;
  var state = {
    account: accountId(root), optIn: false, preview: null, styleCard: null, matches: [], myGraduations: 0,
    pairs: [], circles: [], circleHomes: [], quests: [], aliases: {}, usages: [],
    status: '', uploadMessage: '', openUsageId: null,
  };
  var week = o.week || currentWeekFromDate(o.now == null ? Date.now() : o.now);
  var usages = Array.isArray(o.usages) ? o.usages : [];
  var records = Array.isArray(o.records) ? o.records : readRelayRecords(root);
  var uploadDone = false;
  var requestToken = 0;

  function renderShell() {
    if (!target) return;
    target.innerHTML = syncTabView(state);
    var homeHost = target.querySelector ? target.querySelector('[data-sync-home]') : null;
    if (homeHost && home) {
      home.update({ styleCard: state.styleCard, matches: state.matches, myGraduations: state.myGraduations, pairsCount: state.pairs.length });
      home.mount(homeHost);
    }
  }

  function sendFeatures() {
    var aggregate = aggregateLocal(root, week);
    if (!aggregate.payload) {
      state.uploadMessage = aggregate.result && aggregate.result.missing ? '还缺：' + aggregate.result.missing.join('、') : COPY.uploadMissing;
      return Promise.resolve(false);
    }
    var marker = localUploadMarker(root);
    if (marker && marker.week === week && !o.forceUpload) uploadDone = true;
    if (uploadDone) return Promise.resolve(true);
    return postJson(root, SYNC_UPLOAD_PATH, aggregate.payload).then(function (response) {
      if (!response.ok) { state.uploadMessage = COPY.uploadFailed; return false; }
      uploadDone = true;
      markUploaded(root, week);
      state.uploadMessage = COPY.upload;
      return true;
    });
  }

  function loadState() {
    var token = ++requestToken;
    if (!state.account) {
      return requestJson(root, '/api/social/preview').then(function (response) {
        if (token !== requestToken) return;
        state.preview = response.ok ? response.body : null;
        renderShell();
      });
    }
    var stateQ = requestJson(root, '/api/social/state');
    var profileQ = requestJson(root, '/api/social/profile?week=' + encodeURIComponent(week));
    var matchesQ = requestJson(root, '/api/social/matches?week=' + encodeURIComponent(week));
    var pairsQ = requestJson(root, '/api/social/pairs');
    var circlesQ = requestJson(root, '/api/social/circles');
    var questsQ = requestJson(root, '/api/social/quests?week=' + encodeURIComponent(week));
    return Promise.all([stateQ, profileQ, matchesQ, pairsQ, circlesQ, questsQ]).then(function (parts) {
      if (token !== requestToken) return;
      var remote = parts[0].body || {};
      var profile = parts[1].body && parts[1].body.features;
      var matches = parts[2].body && Array.isArray(parts[2].body.matches) ? parts[2].body.matches : [];
      var pairs = parts[3].body && Array.isArray(parts[3].body.pairs) ? parts[3].body.pairs : [];
      var circles = parts[4].body && Array.isArray(parts[4].body.circles) ? parts[4].body.circles : [];
      var quests = parts[5].body && Array.isArray(parts[5].body.quests) ? parts[5].body.quests : [];
      var local = aggregateLocal(root, week);
      var card = profile ? styleCardFromFeatures(profile) : local.payload ? styleCardFromFeatures(local.payload) : null;
      state.optIn = remote.optIn === true;
      state.account = state.account || accountId(root);
      state.styleCard = card;
      state.matches = matches;
      state.myGraduations = profile ? profile.graduations : local.payload ? local.payload.graduations : 0;
      state.pairs = pairs;
      state.circles = circles;
      state.quests = quests;
      state.usages = batonUsageList(usages, records);
      renderShell();
      return Promise.all(circles.map(function (circle) {
        return requestJson(root, '/api/social/circles/' + encodeURIComponent(circle.id) + '?week=' + encodeURIComponent(week));
      })).then(function (homes) {
        state.circleHomes = homes.map(function (item) { return item.body || {}; });
        renderShell();
      });
    });
  }

  function openOnboarding() {
    if (!doc || !target) return;
    var host = doc.createElement('div');
    host.className = 'sync-onboarding-host';
    target.appendChild(host);
    var onboarding = createOnboarding({ storage: null, onOptIn: function () {
      postJson(root, '/api/social/onboarding-seen', {}).then(function () {
        return postJson(root, '/api/social/opt-in', { enabled: true, minor: false });
      }).then(function () { host.remove(); loadState(); });
    }, onDone: function () { if (host && host.remove) host.remove(); } });
    onboarding.mount(host);
  }

  function openBaton(usage) {
    var host = target && target.querySelector('[data-sync-baton]');
    if (!host) return;
    state.openUsageId = usage.id;
    renderShell();
    host = target.querySelector('[data-sync-baton]');
    relayBatonBridge({ root: root, target: host, usage: usage, targets: state.pairs.map(function (pair) {
      var other = pair.a === state.account ? pair.b : pair.a;
      return { id: other, kind: 'pair', alias: state.aliases[other] || '搭档', avatarColor: '#4C7A93' };
    }), onSent: function () { state.status = '已发出传棒'; loadState(); } });
  }

  function onClick(event) {
    var node = event && event.target && event.target.closest ? event.target.closest('[data-sync-onboard],[data-sync-optout],[data-sync-refresh],[data-sync-usage],[data-sync-feedback]') : null;
    if (!node || !target || !target.contains(node)) return;
    if (node.hasAttribute('data-sync-onboard')) { openOnboarding(); return; }
    if (node.hasAttribute('data-sync-optout')) {
      postJson(root, '/api/social/opt-in', { enabled: false, minor: false }).then(function () { state.status = COPY.optOutDone; state.optIn = false; renderShell(); });
      return;
    }
    if (node.hasAttribute('data-sync-refresh')) { sendFeatures().then(loadState); return; }
    if (node.hasAttribute('data-sync-usage')) {
      var id = node.getAttribute('data-sync-usage');
      var usage = state.usages.filter(function (item) { return item.id === id; })[0];
      if (usage) openBaton(usage);
      return;
    }
    if (node.hasAttribute('data-sync-feedback')) {
      postJson(root, '/api/social/quests/' + encodeURIComponent(node.getAttribute('data-sync-feedback')) + '/feedback', { type: 'too-much' });
    }
  }

  return {
    mount: function (node) {
      target = node || null;
      if (!target) return;
      ensureSocialStyles(doc);
      target.addEventListener('click', onClick);
      home = createSocialHome({
        usageTitles: usageMap(usages),
        onMetric: function (name) { safeMetric(root, name); },
        onKudos: function (view) {
          requestJson(root, '/api/social/shared-events').then(function (response) {
            var events = response.body && Array.isArray(response.body.events) ? response.body.events : [];
            var event = events.filter(function (item) { return item.ownerAlias === view.alias; })[0];
            if (event) postJson(root, '/api/social/kudos', { eventKind: event.kind, sharedEventId: event.id }).then(loadState);
          });
        },
        onPair: function (view) {
          var pairTarget = Object.keys(state.aliases).filter(function (id) { return state.aliases[id] === view.alias; })[0];
          if (pairTarget) postJson(root, '/api/social/pairs', { with: pairTarget }).then(loadState);
        },
      });
      renderShell();
      sendFeatures().then(loadState);
    },
    unmount: function () {
      requestToken += 1;
      if (home) home.unmount();
      if (target) target.removeEventListener('click', onClick);
      target = null;
      home = null;
    },
    refresh: function () { return sendFeatures().then(loadState); },
    state: function () { return Object.assign({}, state); },
  };
}
