// web/relay/boot.js — AI 接力 v2 集成挂载器（index.html 唯一入口）。
// 把 L1–L10 的 web/relay/* 模块接进主界面：
//   · 外壳路由：createRelayShell（L1）接管 #relay-root；relay 路由激活时旧应用
//     （.app/#tabs/#layer）由 html.relay-on 隐藏（头部内联预隐藏防闪，加载后按
//     resolveRoute 校正）；#/lab/* 与 legacy 路由时外壳让位（D2，index.html
//     route() 剥 /lab/ 前缀）。
//   · 访客放行（D5）：#relay-root 在 #view 之外不受登录门影响；访客记录经
//     store.js pickStorage 落本机裸键；登录提示 flow LOGIN_NUDGE → #settings。
//   · 首屏预算（SPEC §6 ≤60KB）：关键路径仅 boot.js + shell.js；home/flow/
//     passport/discover/matcher/store/i18n/baton/contracts/external-apps 全部
//     按路由 dynamic import；scenes.zh.json 是数据（非 JS），按需 fetch。
//   · 交接参数（与 L2 默认 handoff 一致）：#/relay?event=<原话>；场景卡
//     #/relay?usage=<id>&event=<标题>；两者皆无 → replace('#/start')。
//   · 漏斗（§5.5）：metric 回调统一 POST /api/metrics {event}（D10 只计数）。
//   · 落盘（§5.4）：record 副作用经 nextRecordAction 路由到 store 的
//     add/setRating/graduate/replaceResult（一次 #/relay 访问一行）。
//   · 访客→账号提升（§4④，L9）：TangoAppAuth 回调调 TangoRelayV2.onLogin →
//     promoteGuestStore 幂等合并 + 换库重渲染；TangoRelayV2 模块求值时同步挂
//     （先于异步登录回调，无竞态）。
//   · 接力棒（L3 裁决）：用 flow.js 内置三处 baton（结果/失败/20s 慢速）；
//     baton.js 独立挂载版保留为库。
// 纯函数（parseRelayQuery/relayHandoffUrl/nextRecordAction/discoverViewHtml/
// flowStringsFor/passportStringsFor）不触 DOM，node --test 可测
// （rv2-integration.test.mjs）；自动启动仅浏览器执行。本模块【零静态 import】。
// EVENT_MAX=600/MATERIAL_MAX=8000 镜像 contracts.js 同名常量（23KB 不进关键
// 路径；改契约时同步）。

// ---------------------------------------------------------------------------
// 纯函数层
// ---------------------------------------------------------------------------

var EVENT_MAX = 600;

function decodeParam(value) {
  var text = String(value == null ? '' : value);
  try { return decodeURIComponent(text.replace(/\+/g, ' ')); } catch (e) { return text; }
}

// #/relay?usage=&event= → { usage, event }（usage 库 id，event ≤600 字）
export function parseRelayQuery(raw) {
  var query = String(raw == null ? '' : raw);
  var usage = '';
  var event = '';
  var parts = query.split('&');
  for (var i = 0; i < parts.length; i += 1) {
    var eq = parts[i].indexOf('=');
    if (eq <= 0) continue;
    var key = parts[i].slice(0, eq);
    var value = decodeParam(parts[i].slice(eq + 1));
    if (key === 'usage' && !usage) usage = value.trim().slice(0, 120);
    if (key === 'event' && !event) event = value.slice(0, EVENT_MAX).trim();
  }
  return { usage: usage, event: event };
}

export function relayHandoffUrl(event, usageId) {
  var query = 'event=' + encodeURIComponent(String(event == null ? '' : event).slice(0, EVENT_MAX));
  if (usageId) query = 'usage=' + encodeURIComponent(String(usageId)) + '&' + query;
  return '#/relay?' + query;
}

// flow record 副作用 → store 动作。run={id} 是本次 #/relay 访问的记录游标：
// 首个终态（relay_ok/relay_fail）add 一行；后续（rate/graduate/redo/续跑）
// 原地更新同一行。fields 见 flow.js recordFieldsFrom。
export function nextRecordAction(fields, run) {
  if (!fields || typeof fields !== 'object') return null;
  if (!run || typeof run !== 'object') return null;
  if (run.id == null) return { op: 'add' };
  return {
    op: 'update',
    id: String(run.id),
    rating: fields.rating == null ? null : String(fields.rating),
    graduatedApp: fields.graduatedApp == null ? null : String(fields.graduatedApp),
    result: fields.result ? String(fields.result) : null,
  };
}

var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) { return ESC_MAP[ch]; });
}

// §4⑥ 发现页（prototype #s-discover 逐类名）：h1 + lead + .seg 人群切换 +
// 每分类 p.cat + .grid 场景卡。helpers={iconHref, cardClass} 来自 home.js
//（sceneIcon/sceneClass，与首页卡同源，保证视觉一致）。
export function discoverViewHtml(data, helpers) {
  var d = data || {};
  var h = helpers || {};
  var iconHref = typeof h.iconHref === 'function' ? h.iconHref : function () { return '#i-spark'; };
  var cardClass = typeof h.cardClass === 'function' ? h.cardClass : function (index) { return 'c' + ((Number(index) || 0) % 3 + 1); };
  var html = '<h1 style="margin-top:14px">' + esc(d.title) + '</h1>'
    + '<p class="lead">' + esc(d.lead) + '</p>'
    + '<div class="seg" role="tablist" aria-label="' + esc(d.segLabel || '我是') + '">';
  var labels = d.personaLabels || {};
  var order = d.personaOrder && d.personaOrder.length ? d.personaOrder : Object.keys(labels);
  for (var p = 0; p < order.length; p += 1) {
    var pid = order[p];
    var on = pid === d.persona;
    html += '<button type="button" role="tab" aria-selected="' + on + '"' + (on ? ' class="on"' : '') + ' data-persona="' + esc(pid) + '">' + esc(labels[pid]) + '</button>';
  }
  html += '</div>';
  var groups = Array.isArray(d.groups) ? d.groups : [];
  for (var g = 0; g < groups.length; g += 1) {
    var group = groups[g] || {};
    html += '<p class="cat">' + esc(group.label) + '</p><div class="grid">';
    var cards = Array.isArray(group.cards) ? group.cards : [];
    for (var c = 0; c < cards.length; c += 1) {
      var card = cards[c] || {};
      var title = String(card.title == null ? '' : card.title);
      html += '<button type="button" class="scene ' + cardClass(c) + '" data-scene="' + esc(card.usageId) + '" data-event="' + esc(title) + '">'
        + '<span class="ic"><svg><use href="' + esc(iconHref(card.category, title)) + '"/></svg></span>'
        + '<b>' + esc(title) + '</b><span>' + esc(card.hint) + '</span></button>';
    }
    html += '</div>';
  }
  return html;
}

// i18n 组（match/running/result/ratings/baton/fail）→ FLOW_STRINGS 覆盖键。
// 只映射有来源的键：en 覆盖缺项时回退 flow.js 内置 zh（原型逐字），不虚构。
var FLOW_KEY_SOURCES = [
  ['back', 'match', 'back'], ['kicker', 'match', 'kicker'], ['youSaid', 'match', 'youSaid'],
  ['lowConfidenceTitle', 'match', 'lowConfidenceTitle'], ['materialEm', 'match', 'materialNote'],
  ['toolSay', 'match', 'toolsSpeak'], ['toolPaste', 'match', 'toolsPaste'],
  ['privacy', 'match', 'privacy'], ['submit', 'match', 'send'], ['tooLong', 'match', 'tooLong'],
  ['altPrefix', 'match', 'altPrefix'], ['altJoin', 'match', 'altJoin'],
  ['runningTitle', 'running', 'title'], ['stop', 'running', 'stop'], ['runHint', 'running', 'note'],
  ['slowHint', 'running', 'slowHint'],
  ['resultTitle', 'result', 'title'], ['aiTag', 'result', 'aiTag'], ['copy', 'result', 'copy'],
  ['edit', 'result', 'edit'], ['redo', 'result', 'redo'], ['rateTitle', 'result', 'rateTitle'],
  ['learnedKicker', 'result', 'learnedKicker'],
  ['batonKicker', 'baton', 'resultKicker'], ['batonTitle', 'baton', 'resultTitle'],
  ['batonP', 'baton', 'resultBody'], ['moreApps', 'baton', 'moreApps'],
  ['copyOpen', 'baton', 'copyAndOpen'], ['graduated', 'baton', 'doneLink'],
  ['failBatonKicker', 'baton', 'failKicker'], ['failBatonTitle', 'baton', 'failTitle'],
  ['failBatonP', 'baton', 'failBody'],
  ['failTitle', 'fail', 'title'], ['notYourFault', 'fail', 'notYourFault'],
  ['failKeep', 'fail', 'kept'], ['retry', 'fail', 'retry'],
];

export function flowStringsFor(groups) {
  var out = {};
  if (!groups || typeof groups !== 'object') return out;
  for (var i = 0; i < FLOW_KEY_SOURCES.length; i += 1) {
    var source = groups[FLOW_KEY_SOURCES[i][1]];
    var value = source && source[FLOW_KEY_SOURCES[i][2]];
    if (value != null) out[FLOW_KEY_SOURCES[i][0]] = value;
  }
  var ratings = groups.ratings;
  if (ratings && typeof ratings === 'object') out.ratings = { much: ratings.much, little: ratings.little, none: ratings.none };
  var reasons = groups.fail && groups.fail.reasons;
  if (reasons && typeof reasons === 'object') out.failReasons = reasons;
  return out;
}

// i18n passport 组 → passportStrings 覆盖键（键名不一致，逐对映射）。
var PASSPORT_KEY_SOURCES = [
  ['title', 'title'], ['lead', 'lead'], ['statLearned', 'statLearned'],
  ['statRelays', 'statRelay'], ['statGraduations', 'statGraduated'],
  ['secSkills', 'skillsTitle'], ['secRecent', 'recentTitle'],
  ['skillAgain', 'doAgain'], ['skillTry', 'tryOnce'], ['gradBadge', 'gradBadge'],
  ['today', 'today'], ['yesterday', 'yesterday'], ['exportJson', 'exportJson'],
];

export function passportStringsFor(group) {
  var out = {};
  if (!group || typeof group !== 'object') return out;
  for (var i = 0; i < PASSPORT_KEY_SOURCES.length; i += 1) {
    var value = group[PASSPORT_KEY_SOURCES[i][1]];
    if (value != null) out[PASSPORT_KEY_SOURCES[i][0]] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 浏览器层（node 下 doc/win 为 null，以上纯函数照常可测）
// ---------------------------------------------------------------------------

var doc = typeof document !== 'undefined' ? document : null;
var win = typeof window !== 'undefined' ? window : null;

var shellApi = null;
var shellResolveRoute = null;
var shellCopyOverride = null;
var i18nMod = null;
var scenesPromise = null;
var storePromise = null;
var storeUserId;
var pageCtl = null;          // 当前页控制器（home/flow/passport），路由切换时 unmount
var flowCtl = null;
var flowRun = null;          // { id } 本次 #/relay 访问的记录游标
var pendingToken = 0;        // 异步挂载竞态令牌
var highlightUsageId = null; // 毕业跳转 #/me 时高亮的用法

function safeLocalStorage() {
  try { return win ? win.localStorage : null; } catch (e) { return null; }
}

function personaStorage() { return (win && win.TangoAccountStorage) || safeLocalStorage(); }

function postMetric(name) {
  if (!win || !name || typeof win.fetch !== 'function') return;
  try {
    win.fetch('/api/metrics', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: String(name) }),
      keepalive: true,
    }).catch(function () { /* 计数失败不影响流程 */ });
  } catch (e) { /* 旧环境无 fetch：静默 */ }
}

// 场景库（数据，按需 fetch 一次缓存；SPEC §5.1 zh 唯一来源）
function scenes() {
  if (!scenesPromise) {
    scenesPromise = win.fetch('/relay/scenes.zh.json').then(function (response) { return response.text(); })
      .then(function (text) {
        return import('./discover.js').then(function (mod) {
          var parsed = mod.parseSceneLib(text);
          return parsed && parsed.status === 'ok' ? { lib: parsed.lib, discover: mod } : { lib: null, discover: mod };
        });
      })
      .catch(function () { return { lib: null, discover: null }; });
  }
  return scenesPromise;
}

// relay 记录库（L9）。用户身份变化（登录/登出换号）时重建——pickStorage 在
// 创建时解析 TangoAccountStorage，登录后账号作用域生效。
function ensureStore(force) {
  var userId = win && win.TangoCurrentUser ? win.TangoCurrentUser.id : null;
  if (force || !storePromise || storeUserId !== userId) {
    storeUserId = userId;
    storePromise = import('./store.js').then(function (mod) {
      return { store: mod.createRelayStore({}), mod: mod };
    });
  }
  return storePromise;
}

function langEn() {
  return !!doc && /^en/i.test(doc.documentElement.getAttribute('lang') || '');
}

// en 时懒加载 i18n（22KB，非 zh 首屏不付费），并填充 shell copy 覆盖（可变
// options 对象，shell 每次渲染都会读）。
function applyI18n() {
  if (!langEn()) return Promise.resolve(null);
  if (i18nMod) return Promise.resolve(i18nMod);
  return import('./i18n.js').then(function (mod) {
    i18nMod = mod;
    if (shellCopyOverride) {
      var group = mod.copyGroup('en', 'shell');
      if (group) Object.assign(shellCopyOverride, group);
    }
    return mod;
  }).catch(function () { return null; });
}

function pageStrings(builder) {
  if (!i18nMod || !langEn()) return undefined;
  return builder(i18nMod) || undefined;
}

function usageMap(usages) {
  var map = {};
  (Array.isArray(usages) ? usages : []).forEach(function (usage) {
    if (usage && usage.id) map[String(usage.id)] = usage;
  });
  return map;
}

function teardownPage() {
  if (pageCtl) {
    try { if (typeof pageCtl.unmount === 'function') pageCtl.unmount(); } catch (e) { /* 卸载失败不阻塞路由 */ }
    pageCtl = null;
  }
  flowCtl = null;
  flowRun = null;
}

function mountNode(id) {
  return doc ? doc.getElementById(id) : null;
}

// ----- #/start（L2 home）-----
function routeStart() {
  teardownPage();
  var token = ++pendingToken;
  Promise.all([import('./home.js'), ensureStore(), scenes(), applyI18n()]).then(function (loaded) {
    if (token !== pendingToken) return;
    var info = shellApi && shellApi.routeInfo();
    if (!info || info.kind !== 'relay' || info.route !== 'start') return;
    var node = mountNode('rv2-start');
    if (!node) return;
    var home = loaded[0].createHome({
      root: win,
      records: loaded[1].store.all(),
      usages: loaded[2].lib ? loaded[2].lib.usages : [],
      copy: pageStrings(function (m) { return m.copyGroup('en', 'home') || undefined; }),
      onMetric: postMetric,
    });
    pageCtl = home;
    home.mount(node);
  }).catch(function () { /* 模块缺失时保留骨架，不打断外壳 */ });
  return '<div id="rv2-start" aria-busy="true"></div>';
}

// ----- #/relay（L3 flow + L7 matcher；交接参数见文件头约定）-----
function routeCall(request) {
  return win.fetch('/api/assistant/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  }).then(function (response) {
    return response.json().then(function (data) {
      if (!response.ok) throw new Error((data && data.error) || ('HTTP ' + response.status));
      var text = Array.isArray(data && data.content)
        ? data.content.filter(function (part) { return part && part.type === 'text'; }).map(function (part) { return part.text; }).join('')
        : '';
      var start = text.indexOf('{');
      var end = text.lastIndexOf('}');
      if (start < 0 || end <= start) return null;
      return JSON.parse(text.slice(start, end + 1));
    });
  });
}

function onFlowRecord(fields) {
  var run = flowRun;
  var action = nextRecordAction(fields, run);
  if (!action) return;
  ensureStore().then(function (loaded) {
    if (action.op === 'add') {
      var record = loaded.store.add(fields);
      if (record && run) run.id = record.id;
      return;
    }
    if (action.rating) loaded.store.setRating(action.id, action.rating);
    if (action.graduatedApp) loaded.store.graduate(action.id, action.graduatedApp);
    if (action.result) loaded.store.replaceResult(action.id, action.result);
  }).catch(function () { /* 落盘失败不影响流程 */ });
}

function flowNavigate(hash) {
  if (hash === '#/me' && flowCtl) {
    var state = flowCtl.state();
    if (state && state.usage && state.graduatedApp) highlightUsageId = state.usage.id;
  }
  if (win && win.location) win.location.hash = hash;
}

// 「说给我听」：复用 speech-capture.js（TangoSpeech 全局，v1 同款管线）。
function makeFlowSpeech() {
  return function () {
    if (!win || !win.TangoSpeech || !win.fetch) return;
    win.fetch('/api/speech', {}).then(function (response) { return response.json(); }).then(function (config) {
      if (!config || !config.available) return;
      var recorder = win.TangoSpeech.createRecorder(function (audio) {
        if (!audio || audio.length <= 44) return;
        var body = typeof win.Blob === 'function' ? new win.Blob([audio], { type: 'audio/wav' }) : audio;
        win.fetch('/api/speech/transcribe?lang=' + encodeURIComponent(win.TangoRelayV2SpeechLang || 'zh-CN'), {
          method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: body,
        }).then(function (response) { return response.json(); }).then(function (data) {
          var text = data && typeof data.text === 'string' ? data.text.trim() : '';
          if (!text || !flowCtl) return;
          var box = doc ? doc.querySelector('#rv2-relay [data-flow-material]') : null;
          var current = box ? String(box.value || '') : '';
          var merged = (current ? current + '，' : '') + text;
          merged = merged.slice(0, 8000); // MATERIAL_MAX 镜像（contracts.js）
          flowCtl.dispatch({ type: 'SET_MATERIAL', value: merged });
          if (box) box.value = merged;
        }).catch(function () { /* 转写失败静默 */ });
      });
      Promise.resolve().then(function () { return recorder.start(); }).catch(function () { /* 麦克风拒绝等 */ });
    }).catch(function () { /* 语音配置探测失败：按钮无效但页面不受影响 */ });
  };
}

function beginFlow(input) {
  if (flowCtl) flowCtl.begin(input);
}

function routeRelay(ctx) {
  teardownPage();
  var query = parseRelayQuery(ctx && ctx.query);
  if (!query.event && !query.usage) {
    if (win && win.location) win.location.replace('#/start');
    return '';
  }
  var token = ++pendingToken;
  Promise.all([import('./flow.js'), scenes(), import('./external-apps.js'), import('./home.js'), applyI18n()]).then(function (loaded) {
    if (token !== pendingToken) return;
    var info = shellApi && shellApi.routeInfo();
    if (!info || info.kind !== 'relay' || info.route !== 'relay') return;
    var node = mountNode('rv2-relay');
    if (!node) return;
    var flowMod = loaded[0];
    var lib = loaded[1].lib;
    var apps = loaded[2].EXTERNAL_APPS;
    var homeMod = loaded[3];
    if (!lib) {
      node.innerHTML = '<section><div class="card"><h2>场景库暂不可用</h2><p class="lead">稍后再试，或先回首页直接描述这件事。</p><a class="btn pri wide" href="#/start">回首页</a></div></section>';
      return;
    }
    var byId = usageMap(lib.usages);
    var tools = { say: homeMod.speechAvailable(win), paste: true };
    var stringsOverride = pageStrings(function (m) { return flowStringsFor({
      match: m.copyGroup('en', 'match'), running: m.copyGroup('en', 'running'),
      result: m.copyGroup('en', 'result'), ratings: m.copyGroup('en', 'ratings'),
      baton: m.copyGroup('en', 'baton'), fail: m.copyGroup('en', 'fail'),
    }); });
    flowCtl = flowMod.createRelayFlow({
      apps: apps,
      strings: stringsOverride,
      metrics: postMetric,
      navigate: flowNavigate,
      onRecord: onFlowRecord,
      speech: tools.say ? makeFlowSpeech() : null,
    });
    pageCtl = flowCtl;
    flowRun = { id: null };
    var base = {
      event: query.event,
      usagesById: byId,
      tools: tools,
      guest: !(win && win.TangoCurrentUser),
      apps: apps,
    };
    flowCtl.mount(node);
    var preselected = query.usage && byId[query.usage] ? byId[query.usage] : null;
    if (preselected) {
      // 场景卡路径：用法已由用户点选，跳过匹配。
      beginFlow(Object.assign({}, base, { usage: preselected, event: query.event || preselected.title, confidence: 1 }));
      return;
    }
    import('./matcher.js').then(function (matcher) {
      return matcher.matchEvent(query.event, lib, { route: routeCall });
    }).then(function (match) {
      if (token !== pendingToken) return;
      if (!match || !byId[match.usageId]) {
        if (win && win.location) win.location.replace('#/start');
        return;
      }
      beginFlow(Object.assign({}, base, {
        usage: byId[match.usageId],
        alternatives: match.alternatives,
        confidence: match.confidence,
      }));
    }).catch(function () {
      if (token === pendingToken && win && win.location) win.location.replace('#/start');
    });
  }).catch(function () { /* 模块缺失时保留骨架 */ });
  return '<div id="rv2-relay" aria-busy="true"></div>';
}

// ----- #/me（L5 passport）-----
function routeMe() {
  teardownPage();
  var token = ++pendingToken;
  Promise.all([import('./passport.js'), scenes(), ensureStore(), applyI18n()]).then(function (loaded) {
    if (token !== pendingToken) return;
    var info = shellApi && shellApi.routeInfo();
    if (!info || info.kind !== 'relay' || info.route !== 'me') return;
    var node = mountNode('rv2-me');
    if (!node) return;
    var passportMod = loaded[0];
    var byId = usageMap(loaded[1].lib ? loaded[1].lib.usages : []);
    var store = loaded[2].store;
    var passport = passportMod.createPassport({
      root: win,
      loadStore: function () { return { v: 2, records: store.all() }; },
      usagesById: byId,
      onAgain: function (usageId) {
        var usage = byId[usageId];
        if (win && win.location) win.location.hash = relayHandoffUrl(usage ? usage.title : '', usageId);
      },
      strings: pageStrings(function (m) { return passportStringsFor(m.copyGroup('en', 'passport') || null); }),
      highlightUsageId: highlightUsageId,
    });
    highlightUsageId = null;
    pageCtl = passport;
    passport.mount(node);
  }).catch(function () { /* 保留骨架 */ });
  return '<div id="rv2-me" aria-busy="true"></div>';
}

// ----- #/discover（L6 discover + L2 卡片助手）-----
function mountDiscover(node, lib, discoverMod, homeMod) {
  var storage = personaStorage();
  var persona = homeMod.loadPersona(storage);
  function render() {
    var data = {
      title: '发现',
      lead: '挑一件跟你有关的事，点一下就开始。',
      segLabel: '我是',
      persona: persona,
      personaLabels: homeMod.PERSONA_LABELS,
    };
    if (i18nMod && langEn()) {
      var group = i18nMod.copyGroup('en', 'discover');
      if (group) {
        if (group.title) data.title = group.title;
        if (group.lead) data.lead = group.lead;
      }
    }
    // 分组来自 L6 canonical：scenesByCategory（contracts.CATEGORIES 顺序）
    data.groups = discoverMod.scenesByCategory(lib, persona).map(function (grouped) {
      return {
        label: grouped.category,
        cards: grouped.scenes.map(function (card) {
          return { usageId: card.id, title: card.title, hint: card.hint, category: card.category };
        }),
      };
    });
    node.innerHTML = discoverViewHtml(data, { iconHref: homeMod.sceneIcon, cardClass: homeMod.sceneClass });
  }
  render();
  node.onclick = function (event) {
    if (!event || !event.target || typeof event.target.closest !== 'function') return;
    var personaButton = event.target.closest('[data-persona]');
    if (personaButton) {
      var next = homeMod.normalizePersona(personaButton.getAttribute('data-persona'));
      if (next && next !== persona) {
        persona = next;
        homeMod.savePersona(storage, persona); // 与首页同一存储键，选择互通
        render();
      }
      return;
    }
    var scene = event.target.closest('[data-scene]');
    if (scene) {
      postMetric('scene_click');
      if (win && win.location) {
        win.location.hash = relayHandoffUrl(scene.getAttribute('data-event') || '', scene.getAttribute('data-scene') || '');
      }
    }
  };
  pageCtl = { unmount: function () { node.onclick = null; } };
}

function routeDiscover() {
  teardownPage();
  var token = ++pendingToken;
  Promise.all([scenes(), import('./home.js'), applyI18n()]).then(function (loaded) {
    if (token !== pendingToken) return;
    var info = shellApi && shellApi.routeInfo();
    if (!info || info.kind !== 'relay' || info.route !== 'discover') return;
    var node = mountNode('rv2-discover');
    if (!node) return;
    var lib = loaded[0].lib;
    var discoverMod = loaded[0].discover;
    var homeMod = loaded[1];
    if (!lib || !discoverMod) {
      node.innerHTML = '<section><div class="card"><h2>场景库暂不可用</h2><p class="lead">稍后再试。</p></div></section>';
      return;
    }
    mountDiscover(node, lib, discoverMod, homeMod);
  }).catch(function () { /* 保留骨架 */ });
  return '<div id="rv2-discover" aria-busy="true"></div>';
}

// ----- #/more 面板动作（隐私与数据；L1 shell 发事件）-----
function exportRecords() {
  ensureStore().then(function (loaded) {
    var text = loaded.store.exportText();
    if (!text || !doc) return;
    var blob = new win.Blob([text], { type: 'application/json' });
    var anchor = doc.createElement('a');
    anchor.href = win.URL.createObjectURL(blob);
    anchor.download = 'tango-relay-records.json';
    doc.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(function () { win.URL.revokeObjectURL(anchor.href); }, 1000);
  }).catch(function () { /* 导出失败静默 */ });
}

function deleteRecords() {
  ensureStore(true).then(function (loaded) {
    loaded.store.clear();
    if (shellApi) shellApi.handleHash();
  }).catch(function () { /* 删除失败静默 */ });
}

// ----- 访客→账号提升（§4④；index.html 登录回调调用，幂等）-----
function onLogin() {
  import('./store.js').then(function (mod) {
    var result = null;
    try { result = mod.promoteGuestStore({ root: win }); } catch (e) { result = null; }
    return ensureStore(true).then(function () {
      if (shellApi) shellApi.handleHash();
      return result;
    });
  }).catch(function () { /* 提升失败不阻塞登录 */ });
}

// relay 接管旧界面（html.relay-on；index.html 头部已按同一规则预隐藏防闪）
function syncLegacy() {
  if (!doc || !shellResolveRoute) return;
  var info = shellResolveRoute(win ? win.location.hash : '');
  var relayActive = !!(info && !info.redirect && info.kind === 'relay');
  doc.documentElement.classList.toggle('relay-on', relayActive);
}

function start() {
  if (!doc || !win) return;
  var root = doc.getElementById('relay-root');
  if (!root) {
    root = doc.createElement('div');
    root.id = 'relay-root';
    var oldApp = doc.querySelector('.app');
    if (oldApp && oldApp.parentNode) oldApp.parentNode.insertBefore(root, oldApp);
    else doc.body.insertBefore(root, doc.body.firstChild);
  }
  import('./shell.js').then(function (shell) {
    shellResolveRoute = shell.resolveRoute;
    shellCopyOverride = {};
    shellApi = shell.createRelayShell({
      mount: root,
      copy: shellCopyOverride,
      getUser: function () { return win.TangoCurrentUser || null; },
      onExportRecords: exportRecords,
      onDeleteRecords: deleteRecords,
    });
    shellApi.registerRoute('start', routeStart);
    shellApi.registerRoute('relay', routeRelay);
    shellApi.registerRoute('me', routeMe);
    shellApi.registerRoute('discover', routeDiscover);
    win.addEventListener('hashchange', syncLegacy);
    root.addEventListener('relay:lang-change', function () {
      applyI18n().then(function () { if (shellApi) shellApi.handleHash(); });
    });
    scenes(); // 场景库数据预取（首屏卡片尽快出现；失败降级空网格）
    applyI18n().then(function () {
      shellApi.start();
      syncLegacy();
    });
  }).catch(function () {
    // 集成降级：外壳加载失败时交还旧界面（预隐藏类由超时兜底移除）
    if (doc) doc.documentElement.classList.remove('relay-on');
  });
}

// 模块求值时同步挂上（先于任何异步登录回调，消除 onLogin 竞态）
if (win) {
  win.TangoRelayV2 = { onLogin: onLogin };
  start();
}
