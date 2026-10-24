// web/social/home.js — 同频（社交游戏化）同频首页（PRD design/social-sync/PRD.md
// §4.1/§4.2，原型 design/social-sync/prototype.html ①屏）。
//
// S5同频页 line deliverable: 流派卡（三条证据）→ 本周同频推荐 3 人（含
// 「略多一点」理由）→ 每张推荐卡上的 加油（kudos）与 结为搭档 按钮。
//
// Visual contract: prototype ① 同频首页。The emitted markup uses the prototype
// class names verbatim — top/me/sub/arch/small/h2/p/bot/share/sec/match/mh/av/
// sim/why/uses/acts/b cheer/b pair — plus `.ahead`（「略多一点」理由行）、
// `.invite`（PRD §3.3 冷启动邀请）、`.pending`（流派卡未生成态，原型未覆盖，
// 按 PRD 补齐）和 `.soc-note` live region。Styles live in web/social/social.css
// (scope `.soc`, tokens = relay-v2 SPEC §3); this module only produces markup +
// behaviour. The tab bar / 第 4 个 tab 挂载属二期集成（CTO 派单），本模块不渲染。
//
// Data shapes come exclusively from web/social/contracts.js (STYLES,
// MATCHES_PER_WEEK, MAX_PAIRS, validateStyleCard, validateMatch …). Never
// redefined here. 流派判定与相似度计算是 social-features.mjs（D3 线）的纯函数，
// 本模块只消费它们的输出形状。渲染层对每条记录再过一遍契约校验，并把
// D4「略多一点」边界（isSlightlyAhead，经 validateMatch context）当第二道闸：
// 越界推荐根本进不了视图。冷启动不造假人（D4）：同频不足 MATCHES_PER_WEEK 人
// 时只渲染邀请文案「邀请同学加入，一起找同频」。
//
// All dynamic text is HTML-escaped on the way into the view string, like
// web/relay/home.js. Pure exports (no DOM/fetch/storage IO) are directly
// importable by `node --test`. createSocialHome(options) returns the controller:
//   { mount(el), unmount(), update(patch), kudosGiven(), pairsCount() }
//
// Integration hooks (all optional):
//   onKudos(matchView)  — 加油一键完成，回调拿完整视图模型（含 alias/styleLabel）
//   onPair(matchView)   — 结为搭档；MAX_PAIRS 已满时按钮禁用且不发
//   onShare(styleCard)  — 「生成分享图」（分享图本身是 ④ 屏，另一条线）
//   onInvite()          — 邀请文案点击
//   onMetric(name)      — social_kudos / social_pair / social_share / social_invite
//   copy                — 文案覆盖（默认 zh 与原型①一致）
//   styleCard, matches, myGraduations, usageTitles, pairsCount, me({alias})
// update(patch) 接受同名字段增量刷新。本模块不做网络与存储 IO —— 服务端
// /api/social/* 的接线属二期集成线。

import {
  STYLES, MATCHES_PER_WEEK, MATCH_RECENT_USAGES_MAX, MAX_PAIRS,
  validateStyleCard, validateMatch, aliasBadgeChar,
} from './contracts.js';

export var SOCIAL_HOME_COPY = {
  title: '同频',
  subLead: '根据你怎么用 AI、怎么分配空出来的时间',
  styleKicker: '本周你的时间流派',
  share: '生成分享图',
  shareLabel: '生成本周流派分享图',
  matchTitle: '本周和你同频',
  matchNote: '每周一更新',
  cheer: '♥ 加油',
  cheered: '已加油 ♥',
  pair: '结为搭档',
  paired: '已是搭档',
  pairFull: '搭档已满 {max} 位',
  invite: '邀请同学加入，一起找同频',
  stylePending: '本周流派还没算好，完成几次接力就有了',
};

// 化名头像用「流派字」兜底（原型① me 头像=夜，原型② 传递链晨光整理派=晨；
// 其余流派按同一规则取一个代表字）。
export var STYLE_CHARS = {
  'morning-sorter': '晨', 'night-creator': '夜', 'relay-ace': '接',
  'slow-liver': '生', 'academic-climber': '学', 'parallel-runner': '多',
};

// 原型①只画了深夜创作派：渐变与吉祥物色逐字照抄；其余流派由公式推导。
var STYLE_VISUALS = {
  'night-creator': { gradient: 'linear-gradient(135deg,#3B6A82,#24475A)', bot: '#9FC6DA' },
};

// 原型 mascot sprite（prototype.html <symbol id="bot"> 逐字复制）。
var BOT_SPRITE = '<svg class="soc-sprite" aria-hidden="true"><symbol id="soc-bot" viewBox="0 0 100 100"><path d="M30 30 L28 12" stroke="currentColor" stroke-width="5" stroke-linecap="round"/><circle cx="27.5" cy="10" r="6" fill="currentColor"/><path d="M70 30 C71 18 74 13 79 14 C84 15 83 22 78 21" stroke="currentColor" stroke-width="5" fill="none" stroke-linecap="round"/><rect x="9" y="42" width="12" height="24" rx="5" fill="currentColor"/><rect x="79" y="42" width="12" height="24" rx="5" fill="currentColor"/><rect x="16" y="28" width="68" height="62" rx="18" fill="currentColor"/><circle cx="38" cy="56" r="7" fill="#24475A"/><circle cx="62" cy="56" r="7" fill="#24475A"/><path d="M40 74 Q50 80 60 74" stroke="#24475A" stroke-width="4" fill="none" stroke-linecap="round"/><path d="M74 20 l3 -6 l3 6 l6 3 l-6 3 l-3 6 l-3 -6 l-6 -3z" fill="#FFE7A6"/></symbol></svg>';

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
  });
}

function mergeCopy(over) {
  var out = {};
  Object.keys(SOCIAL_HOME_COPY).forEach(function (key) {
    out[key] = over && over[key] != null ? String(over[key]) : SOCIAL_HOME_COPY[key];
  });
  return out;
}

// ---------------------------------------------------------------------------
// Pure helpers — 流派 meta / 周 / 化名 / 相似度。
// ---------------------------------------------------------------------------

export function styleById(styleId) {
  for (var i = 0; i < STYLES.length; i += 1) {
    if (STYLES[i].id === styleId) return STYLES[i];
  }
  return null;
}

export function weekNumber(week) {
  if (typeof week !== 'string') return null;
  var match = /^([0-9]{4})-W([0-9]{2})$/.exec(week);
  if (!match) return null;
  var number = parseInt(match[2], 10);
  return number >= 1 && number <= 53 ? number : null;
}

export function weekLabel(week) {
  var number = weekNumber(week);
  return number ? '第 ' + number + ' 周' : '';
}

// 化名徽章字 = 尾字（自然物）。PRD §5 化名系统是「形容词 + 自然物」，原型
// ① 安静的湖→湖、原型③ 课题组→组 / 妈妈→妈，头像画的都是尾字。
// 取字规则统一在 contracts.aliasBadgeChar（「·」标记后缀不参与，如 lab 示例
// 「今晚的风·示例」→风），①②③屏同一化名同一徽章。
export function aliasBadge(alias) {
  return aliasBadgeChar(alias);
}

export function similarityLabel(similarity) {
  var value = Number(similarity);
  if (!Number.isFinite(value)) value = 0;
  value = Math.min(1, Math.max(0, value));
  return '同频 ' + Math.round(value * 100) + '%';
}

// ---------------------------------------------------------------------------
// 流派卡视觉推导 — 颜色混合纯函数。
// mixWhite：向白靠（吉祥物浅色调）；darken：向黑靠（渐变深档）。
// ---------------------------------------------------------------------------

function channel(value, t, target) {
  return Math.round(value + (target - value) * t);
}

function withBase(hex, t, target) {
  var match = /^#([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})$/.exec(String(hex || ''));
  if (!match) return '';
  return '#' + [match[1], match[2], match[3]]
    .map(function (pair) { return channel(parseInt(pair, 16), t, target).toString(16).toUpperCase().padStart(2, '0'); })
    .join('');
}

export function mixWhite(hex, t) {
  return withBase(hex, t, 255);
}

function darken(hex, t) {
  return withBase(hex, t, 0);
}

function relLuminance(hex) {
  var rgb = /^#([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})$/.exec(hex);
  if (!rgb) return 0;
  var lin = [1, 2, 3].map(function (i) {
    var c = parseInt(rgb[i], 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

// 135° 双档渐变。深夜创作派照抄原型；其余流派从契约流派色推导：深浅两档
// 都要保证卡上白字可读（浅档 ≥3:1 承载 26px 流派名，深档 ≥4.5:1 承载小字
// 证据区），浅色流派（相对亮度 > .35，如晨光金）自动改用更深的两档。
export function styleGradient(styleId) {
  var meta = styleById(styleId);
  if (!meta) return '';
  var preset = STYLE_VISUALS[styleId];
  if (preset) return preset.gradient;
  var deep = relLuminance(meta.color) > 0.35;
  return 'linear-gradient(135deg,' + darken(meta.color, deep ? 0.45 : 0.13) + ',' + darken(meta.color, deep ? 0.62 : 0.42) + ')';
}

export function mascotColor(styleId) {
  var preset = STYLE_VISUALS[styleId];
  if (preset) return preset.bot;
  var meta = styleById(styleId);
  return meta ? mixWhite(meta.color, 0.55) : '';
}

// ---------------------------------------------------------------------------
// 流派卡 / 同频推荐 — 视图模型（全部先过契约校验）。
// ---------------------------------------------------------------------------

export function buildStyleCard(raw) {
  var card = validateStyleCard(raw);
  if (!card) return null;
  var meta = styleById(card.style);
  return {
    week: card.week, styleId: card.style, label: meta.label,
    motto: meta.motto, color: meta.color, evidence: card.evidence,
  };
}

export function usageChips(recentUsages, titles) {
  var list = Array.isArray(recentUsages) ? recentUsages : [];
  var map = titles && typeof titles === 'object' ? titles : {};
  var out = [];
  for (var i = 0; i < list.length && out.length < MATCH_RECENT_USAGES_MAX; i += 1) {
    var title = map[list[i]];
    if (typeof title === 'string' && title.trim()) {
      out.push({ usageId: list[i], title: title.trim() });
    }
  }
  return out;
}

// 「略多一点」理由（PRD §3.3 / D4）：对方 graduations 不少于你、不超过你的
// 2 倍加 2；文案只讲次数差，粗粒度、不制造压力。
export function aheadNote(myGraduations, theirGraduations) {
  if (!Number.isFinite(myGraduations) || !Number.isFinite(theirGraduations)) return '';
  var mine = Math.round(myGraduations);
  var theirs = Math.round(theirGraduations);
  if (theirs <= mine) return 'TA 和你做到的一样多';
  return 'TA 比你多做到 ' + (theirs - mine) + ' 次，刚好够一够';
}

// 推荐卡视图模型。context 提供 myGraduations 时同时强制 D4「略多一点」边界
// （validateMatch 内部走 isSlightlyAhead）：越界返回 null，渲染层拒画。
export function matchView(match, context, titles) {
  var rec = validateMatch(match, context);
  if (!rec) return null;
  var meta = styleById(rec.style);
  var label = meta ? meta.label : rec.style;
  var mine = context && Number.isFinite(context.myGraduations) ? Math.round(context.myGraduations) : null;
  return {
    alias: rec.alias,
    initial: aliasBadge(rec.alias),
    avatarColor: rec.avatarColor,
    styleId: rec.style,
    styleLabel: label,
    graduationsNote: label + ' · 自己做到 ' + rec.theirGraduations + ' 次',
    similarity: rec.similarity,
    similarityLabel: similarityLabel(rec.similarity),
    theirGraduations: rec.theirGraduations,
    reasons: rec.reasons,
    chips: usageChips(rec.recentUsages, titles),
    ahead: mine != null ? aheadNote(mine, rec.theirGraduations) : '',
  };
}

// ---------------------------------------------------------------------------
// 按钮状态纯函数（加油 / 结为搭档）。
// ---------------------------------------------------------------------------

export function kudosState(given, copyOver) {
  var copy = mergeCopy(copyOver);
  return given
    ? { done: true, label: copy.cheered, disabled: true }
    : { done: false, label: copy.cheer, disabled: false };
}

export function pairState(opts, copyOver) {
  var copy = mergeCopy(copyOver);
  var o = opts || {};
  var count = Number.isInteger(o.pairsCount) ? o.pairsCount : 0;
  var max = Number.isInteger(o.max) && o.max > 0 ? o.max : MAX_PAIRS;
  if (o.paired) return { done: true, label: copy.paired, disabled: true };
  if (count >= max) return { done: false, label: copy.pairFull.replace('{max}', String(max)), disabled: true };
  return { done: false, label: copy.pair, disabled: false };
}

export function kudosNote(alias) {
  return '已给 ' + alias + ' 加油';
}

export function pairNote(alias) {
  return '和 ' + alias + ' 结为搭档啦';
}

// PRD §3.3 冷启动：池不足每周推荐数 → 引导邀请，不造假人。
export function inviteNeeded(matches) {
  var list = Array.isArray(matches) ? matches : [];
  return list.length < MATCHES_PER_WEEK;
}

// ---------------------------------------------------------------------------
// 渲染 — 原型①逐屏 markup。state:
//   { me:{alias}, styleCard(raw|null), matches(raw[]), myGraduations|null,
//     usageTitles{}, kudosGiven{alias:bool}, pairedAliases{alias:bool},
//     pairsCount, note }
// ---------------------------------------------------------------------------

function meBadge(state, card) {
  var char = card ? STYLE_CHARS[card.styleId] : (aliasBadge(state.me && state.me.alias) || '你');
  var color = card ? card.color : '#8E9086';
  return '<span class="me" style="background:' + esc(color) + '" aria-hidden="true">' + esc(char) + '</span>';
}

function styleCardHtml(card, copy) {
  if (!card) return '<p class="pending">' + esc(copy.stylePending) + '</p>';
  var html = '<div class="arch" style="background:' + styleGradient(card.styleId) + '">'
    + '<small>' + esc(copy.styleKicker) + '</small>'
    + '<h2>' + esc(card.label) + '</h2>'
    + '<p>' + esc(card.motto) + '</p>'
    + '<svg class="bot" style="color:' + mascotColor(card.styleId) + '" aria-hidden="true"><use href="#soc-bot"/></svg>'
    + '<ul>';
  card.evidence.forEach(function (line) { html += '<li>' + esc(line) + '</li>'; });
  html += '</ul>'
    + '<button type="button" class="share" data-share aria-label="' + esc(copy.shareLabel) + '">' + esc(copy.share) + '</button>'
    + '</div>';
  return html;
}

function matchCardHtml(view, ui, copy) {
  var kudos = kudosState(!!(ui.kudosGiven && ui.kudosGiven[view.alias]), copy);
  var pair = pairState({ paired: !!(ui.pairedAliases && ui.pairedAliases[view.alias]), pairsCount: ui.pairsCount }, copy);
  var html = '<div class="match">'
    + '<div class="mh"><span class="av" style="background:' + esc(view.avatarColor) + '" aria-hidden="true">' + esc(view.initial) + '</span>'
    + '<div><b>' + esc(view.alias) + '</b><small>' + esc(view.graduationsNote) + '</small></div>'
    + '<span class="sim">' + esc(view.similarityLabel) + '</span></div>';
  if (view.reasons.length) {
    html += '<p class="why">' + view.reasons.map(function (reason) { return '<b>' + esc(reason) + '</b>'; }).join('，') + '。</p>';
  }
  if (view.ahead) html += '<p class="ahead">' + esc(view.ahead) + '</p>';
  if (view.chips.length) {
    html += '<div class="uses">' + view.chips.map(function (chip) {
      return '<span>' + esc(chip.title) + '</span>';
    }).join('') + '</div>';
  }
  html += '<div class="acts">'
    + '<button type="button" class="b cheer' + (kudos.done ? ' did' : '') + '" data-kudos="' + esc(view.alias) + '" aria-label="给 ' + esc(view.alias) + ' 加油"' + (kudos.disabled ? ' disabled' : '') + '>' + esc(kudos.label) + '</button>'
    + '<button type="button" class="b pair' + (pair.done ? ' did' : pair.disabled ? ' full' : '') + '" data-pair="' + esc(view.alias) + '" aria-label="和 ' + esc(view.alias) + ' 结为搭档"' + (pair.disabled ? ' disabled' : '') + '>' + esc(pair.label) + '</button>'
    + '</div></div>';
  return html;
}

export function socialHomeView(state, copyOver) {
  var s = state || {};
  var copy = mergeCopy(copyOver);
  var card = buildStyleCard(s.styleCard);
  var context = Number.isFinite(s.myGraduations) ? { myGraduations: Math.round(s.myGraduations) } : {};
  var views = (Array.isArray(s.matches) ? s.matches : [])
    .map(function (match) { return matchView(match, context, s.usageTitles); })
    .filter(Boolean); // 契约/D4 越界记录在渲染层即被丢弃
  var week = card ? weekLabel(card.week) : '';

  var html = card ? BOT_SPRITE : '';
  html += '<div class="top"><h1>' + esc(copy.title) + '</h1>' + meBadge(s, card) + '</div>';
  html += '<p class="sub">' + (week ? esc(week) + ' · ' : '') + esc(copy.subLead) + '</p>';
  html += styleCardHtml(card, copy);
  html += '<div class="sec"><h3>' + esc(copy.matchTitle) + '</h3><span>' + esc(copy.matchNote) + '</span></div>';
  views.forEach(function (view) { html += matchCardHtml(view, s, copy); });
  if (inviteNeeded(views)) {
    html += '<button type="button" class="invite" data-invite>' + esc(copy.invite) + '</button>';
  }
  if (s.note) html += '<p class="soc-note" role="status">' + esc(s.note) + '</p>';
  return html;
}

// ---------------------------------------------------------------------------
// Controller — 事件委托 + 乐观状态；不做网络 IO，接线由集成线注入回调。
// ---------------------------------------------------------------------------

export function createSocialHome(options) {
  options = options || {};
  var copy = mergeCopy(options.copy);
  var state = {
    me: options.me && typeof options.me === 'object' ? options.me : { alias: '' },
    styleCard: options.styleCard || null,
    matches: Array.isArray(options.matches) ? options.matches : [],
    myGraduations: Number.isFinite(options.myGraduations) ? Math.round(options.myGraduations) : null,
    usageTitles: options.usageTitles && typeof options.usageTitles === 'object' ? options.usageTitles : {},
    kudosGiven: {},
    pairedAliases: {},
    pairsCount: Number.isInteger(options.pairsCount) ? options.pairsCount : 0,
    note: '',
  };
  var target = null;
  var views = [];

  function metric(name) {
    if (typeof options.onMetric === 'function') {
      try { options.onMetric(name); } catch (e) { /* metrics must never break the page */ }
    }
  }

  function render() {
    if (!target) return;
    target.innerHTML = socialHomeView(state, copy);
  }

  function refreshViews() {
    var context = state.myGraduations != null ? { myGraduations: state.myGraduations } : {};
    views = state.matches
      .map(function (match) { return matchView(match, context, state.usageTitles); })
      .filter(Boolean);
  }

  function findView(alias) {
    for (var i = 0; i < views.length; i += 1) {
      if (views[i].alias === alias) return views[i];
    }
    return null;
  }

  function onKudosTap(alias) {
    var view = findView(alias);
    if (!view || state.kudosGiven[alias]) return;
    state.kudosGiven[alias] = true;
    state.note = kudosNote(alias);
    metric('social_kudos');
    if (typeof options.onKudos === 'function') options.onKudos(view);
    render();
    refreshViews();
  }

  function onPairTap(alias) {
    var view = findView(alias);
    if (!view || state.pairedAliases[alias] || state.pairsCount >= MAX_PAIRS) return;
    state.pairedAliases[alias] = true;
    state.pairsCount += 1;
    state.note = pairNote(alias);
    metric('social_pair');
    if (typeof options.onPair === 'function') options.onPair(view);
    render();
    refreshViews();
  }

  function onShareTap() {
    var card = buildStyleCard(state.styleCard);
    if (!card) return;
    metric('social_share');
    if (typeof options.onShare === 'function') options.onShare(card);
  }

  function onInviteTap() {
    metric('social_invite');
    if (typeof options.onInvite === 'function') options.onInvite();
  }

  function onClick(event) {
    if (!event || !event.target || typeof event.target.closest !== 'function') return;
    if (!target) return;
    var node = event.target.closest('[data-kudos],[data-pair],[data-share],[data-invite]');
    if (!node || !target.contains(node)) return;
    var kudosAlias = node.getAttribute('data-kudos');
    if (kudosAlias) { onKudosTap(kudosAlias); return; }
    var pairAlias = node.getAttribute('data-pair');
    if (pairAlias) { onPairTap(pairAlias); return; }
    if (node.getAttribute('data-share') != null) { onShareTap(); return; }
    if (node.getAttribute('data-invite') != null) { onInviteTap(); return; }
  }

  refreshViews();

  return {
    mount: function (node) {
      target = node || null;
      if (!target) return;
      target.addEventListener('click', onClick);
      render();
    },
    unmount: function () {
      target = null;
    },
    update: function (patch) {
      patch = patch || {};
      if (patch && patch.styleCard !== undefined) state.styleCard = patch.styleCard || null;
      if (Array.isArray(patch.matches)) state.matches = patch.matches;
      if (patch.myGraduations !== undefined) state.myGraduations = Number.isFinite(patch.myGraduations) ? Math.round(patch.myGraduations) : null;
      if (patch.usageTitles && typeof patch.usageTitles === 'object') state.usageTitles = patch.usageTitles;
      if (Number.isInteger(patch.pairsCount)) state.pairsCount = patch.pairsCount;
      if (patch.me && typeof patch.me === 'object') state.me = patch.me;
      refreshViews();
      render();
    },
    kudosGiven: function () {
      var out = {};
      Object.keys(state.kudosGiven).forEach(function (alias) { out[alias] = true; });
      return out;
    },
    pairsCount: function () { return state.pairsCount; },
  };
}
