// web/relay/shell.js — AI 接力 v2 外壳与路由（L1）。
// SPEC §2（路由表）、§3（token 在 relay.css）、§4⑦（更多页）、§6（无障碍/
// RTL/reduced-motion）；视觉标准 = design/relay-v2/prototype.html。
// 三层，均可 node --test 直接导入（无隐式 DOM 触点）：
//   1. 纯路由：parseHash/resolveRoute/activeTab —— 旧 hash 重定向（'' 与
//      '#today' → '#/start'；'#line'/'#review'/'#agreements' → '#/lab/*'；
//      '#settings'/'#users'/'#assistant' 沿用 legacy 不重定向）。
//   2. 纯渲染：renderIconSprite/renderTopBar/renderTabBar/renderMorePage 返回
//      HTML 字符串；markup 用原型类名（.top/.tabbar/.list/.it/.lab…），样式全
//      在 relay.css 的 .rv2 作用域（其它 relay 线按同一约定）；数据一律 esc()。
//   3. createRelayShell(options)：DI（doc/win/mount/storage）挂载器；
//      hashchange 调度、重定向 location.replace（不留历史），lab/legacy 路由
//      时隐藏 relay 外壳。
// 外观：与 web/appearance.js 同键同语义（tango-donego.appearance.v1，html[data-
// appearance]），relay.css 在 html[data-appearance=X] .rv2 下重定义 §3 token；
// designer 深色对比度 ≥ 4.5:1（单测校验）。文案 zh/en 内置（§6），集中式表在
// web/relay/i18n.js，options.copy 可注入覆盖。

// ---------------------------------------------------------------------------
// 路由（SPEC §2 表）
// ---------------------------------------------------------------------------

export var RELAY_ROUTES = ['start', 'relay', 'me', 'discover', 'more'];
export var LAB_PAGES = ['today', 'line', 'review', 'agreements'];
export var LEGACY_ROUTES = ['settings', 'users', 'assistant'];
export var DEFAULT_HASH = '#/start';

// 旧 hash → 新 hash。'#today' 在 §2 里归到 #/start（首页就是新的"今天"）；
// line/review/agreements 是旧功能页，收进 #/lab/*（D2：旧功能不删）。
var LEGACY_REDIRECTS = {
  today: '#/start',
  line: '#/lab/line',
  review: '#/lab/review',
  agreements: '#/lab/agreements',
};

function none(value) { return value == null; }

export function parseHash(raw) {
  var value = String(none(raw) ? '' : raw);
  var queryAt = value.indexOf('?');
  var query = '';
  if (queryAt >= 0) {
    query = value.slice(queryAt + 1);
    value = value.slice(0, queryAt);
  }
  if (value.charAt(0) === '#') value = value.slice(1);
  if (value.charAt(0) === '/') value = value.slice(1);
  if (value.length > 1 && value.charAt(value.length - 1) === '/') value = value.slice(0, -1);
  return { path: value, query: query };
}

// → { redirect }                       需要重定向（调用方 location.replace）
// → { kind:'relay', route, query }     #/start #/relay #/me #/discover #/more
// → { kind:'lab', route:'lab', lab, query }  #/lab/today|line|review|agreements
// → { kind:'legacy', route, query }    #settings #users #assistant（沿用）
export function resolveRoute(raw) {
  var parsed = parseHash(raw);
  var path = parsed.path;
  if (path === '') return { redirect: DEFAULT_HASH };
  if (path.indexOf('lab/') === 0) {
    var lab = path.slice(4);
    return LAB_PAGES.indexOf(lab) >= 0
      ? { redirect: null, kind: 'lab', route: 'lab', lab: lab, query: parsed.query }
      : { redirect: DEFAULT_HASH };
  }
  if (RELAY_ROUTES.indexOf(path) >= 0) {
    return { redirect: null, kind: 'relay', route: path, query: parsed.query };
  }
  if (LEGACY_ROUTES.indexOf(path) >= 0) {
    return { redirect: null, kind: 'legacy', route: path, query: parsed.query };
  }
  if (Object.prototype.hasOwnProperty.call(LEGACY_REDIRECTS, path)) {
    return { redirect: LEGACY_REDIRECTS[path] };
  }
  return { redirect: DEFAULT_HASH };
}

var TAB_BY_ROUTE = { start: 'start', relay: 'start', me: 'me', discover: 'discover' };

export function activeTab(info) {
  if (!info || info.redirect || info.kind !== 'relay') return null;
  return Object.prototype.hasOwnProperty.call(TAB_BY_ROUTE, info.route) ? TAB_BY_ROUTE[info.route] : null;
}

// ---------------------------------------------------------------------------
// 身份徽标（SPEC §2：访客显示"访客"，登录后显示称呼首字）
// ---------------------------------------------------------------------------

export function identityBadge(user) {
  if (none(user) || typeof user !== 'object') return { kind: 'guest', label: '访客' };
  var displayName = String(user.displayName == null ? '' : user.displayName).trim();
  if (!displayName) displayName = String(user.username == null ? '' : user.username).trim();
  if (!displayName) {
    var email = String(user.email == null ? '' : user.email);
    var local = email.split('@')[0].trim();
    if (local) displayName = local;
  }
  if (!displayName) return { kind: 'user', label: '客' };
  // [...str] 取第一个字素（CJK / emoji 代理对都是一个元素）
  var first = Array.from(displayName)[0];
  return { kind: 'user', label: first };
}

// ---------------------------------------------------------------------------
// 外观 / 语言（与 web/appearance.js、web/app-auth.js 同键同语义）
// ---------------------------------------------------------------------------

export var APPEARANCES = ['standard', 'swiss', 'archive', 'designer', 'workbench'];
export var APPEARANCE_KEY = 'tango-donego.appearance.v1';
export var LANG_KEY = 'tango-donego.lang';
// relay v2 界面文案先做 zh / en，其余语言回退 en/zh（SPEC §6）。
export var SHELL_LANGS = ['zh', 'en'];

var APPEARANCE_COPY = {
  zh: { standard: '标准', swiss: '瑞士雪境研究桌', archive: '个人时间档案', designer: '夜间观测花园', workbench: '知识工作台' },
  en: { standard: 'Standard', swiss: 'Swiss snow study desk', archive: 'Personal time archive', designer: 'Night observatory garden', workbench: 'Knowledge workbench' },
};

export function appearanceLabel(theme, lang) {
  var key = APPEARANCES.indexOf(theme) >= 0 ? theme : 'standard';
  var table = APPEARANCE_COPY[lang === 'en' ? 'en' : 'zh'];
  return table[key];
}

function storageGet(storage, key) {
  try { return storage ? storage.getItem(key) : null; } catch (e) { return null; }
}

function storageSet(storage, key, value) {
  try { if (storage) storage.setItem(key, value); } catch (e) { /* 私隐模式等场景静默 */ }
}

export function applyAppearance(value, doc, storage) {
  var theme = APPEARANCES.indexOf(value) >= 0 ? value : 'standard';
  var root = doc && doc.documentElement;
  if (root) {
    root.setAttribute('data-appearance', theme);
    // 与 web/appearance.js apply() 保持一致：钉住 legacy color-scheme 选择器。
    root.setAttribute('data-theme', theme === 'designer' ? 'dark' : 'light');
    root.setAttribute('data-tone', theme === 'designer' ? 'dark' : 'light');
  }
  storageSet(storage, APPEARANCE_KEY, theme);
  return theme;
}

export function applyLanguage(lang, doc, storage) {
  var value = String(lang == null ? '' : lang);
  // SHELL_LANGS 之内自由切换；旧页语言值（ru/th/ar/ko）只调方向不进文案表。
  if (SHELL_LANGS.indexOf(value) < 0 && ['ar', 'ru', 'th', 'ko'].indexOf(value) < 0) value = 'zh';
  var root = doc && doc.documentElement;
  if (root) {
    root.setAttribute('lang', value);
    root.setAttribute('dir', value === 'ar' ? 'rtl' : 'ltr');
  }
  storageSet(storage, LANG_KEY, value);
  return value;
}

// ---------------------------------------------------------------------------
// 文案表（zh / en；i18n 线的 web/relay/i18n.js 可通过 options.copy 覆盖）
// ---------------------------------------------------------------------------

var COPY = {
  zh: {
    brandName: '探戈', brandSub: 'Done&Go',
    tabStart: '开始', tabMe: '我的用法', tabDiscover: '发现',
    moreTitle: '更多', moreAria: '更多', guest: '访客',
    account: '账号', accountGuest: '访客 · 去登录',
    language: '语言', appearance: '外观',
    aiRow: '我们用了哪些 AI', aiNote: '说明与出处',
    privacyRow: '隐私与数据', privacyNote: '导出 · 删除',
    labsCaption: '实验室（早期功能，不影响主流程）',
    labTime: '时间记录与回顾', labGroup: '约定与小组', legacyTag: '旧版',
    langZh: '中文', langEn: 'English',
    exportJson: '导出我的记录（JSON）', deleteLocal: '删除本机记录',
    aiIntro: '接力时，探戈通过自建网关 auto 调用大模型；接力棒里列出的外部应用，由你带着提示词去它们的官网自己使用。',
    aiGateway: '网关：auto',
    aiAppsHead: '外部应用清单与官方出处',
    aiAppsUnavailable: '外部应用清单暂不可用。',
  },
  en: {
    brandName: '探戈', brandSub: 'Done&Go',
    tabStart: 'Start', tabMe: 'My usages', tabDiscover: 'Discover',
    moreTitle: 'More', moreAria: 'More', guest: 'Guest',
    account: 'Account', accountGuest: 'Guest · Sign in',
    language: 'Language', appearance: 'Appearance',
    aiRow: 'About the AIs we use', aiNote: 'Notes & sources',
    privacyRow: 'Privacy & data', privacyNote: 'Export · Delete',
    labsCaption: 'Labs (early features, off the main path)',
    labTime: 'Time tracking & review', labGroup: 'Agreements & groups', legacyTag: 'Legacy',
    langZh: '中文', langEn: 'English',
    exportJson: 'Export my records (JSON)', deleteLocal: 'Delete local records',
    aiIntro: 'Relay drafts run through our own gateway (auto). The baton apps below are used by you, with your prompt, on their official sites.',
    aiGateway: 'Gateway: auto',
    aiAppsHead: 'External apps and official sources',
    aiAppsUnavailable: 'External app list unavailable.',
  },
};

// i18n 线（web/relay/i18n.js RELAY_COPY.*.shell）的键名别名，使
// copyGroup(lang, 'shell') 可以不做映射直接作为 options.copy 注入。
var COPY_ALIASES = {
  brandName: ['appName'],
  brandSub: ['appSub'],
  moreTitle: ['more'],
  moreAria: ['more'],
};

export function shellCopy(lang, overrides) {
  var table = COPY[lang === 'en' ? 'en' : 'zh'];
  if (overrides && typeof overrides === 'object') {
    var merged = {};
    for (var key in table) {
      merged[key] = table[key];
      if (Object.prototype.hasOwnProperty.call(overrides, key) && overrides[key] != null) {
        merged[key] = String(overrides[key]);
        continue;
      }
      var aliases = COPY_ALIASES[key];
      for (var i = 0; aliases && i < aliases.length; i += 1) {
        if (Object.prototype.hasOwnProperty.call(overrides, aliases[i]) && overrides[aliases[i]] != null) {
          merged[key] = String(overrides[aliases[i]]);
          break;
        }
      }
    }
    return merged;
  }
  return table;
}

// ---------------------------------------------------------------------------
// 渲染（纯字符串；markup 用原型类名，样式在 relay.css 的 .rv2 作用域）
// ---------------------------------------------------------------------------

var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) { return ESC_MAP[ch]; });
}

// 图标 sprite：lucide 风格 stroke path，id 沿用原型（#i-home…）——home.js 等
// 其它 relay 线的 markup 也引用同一组 symbol（旧页无 #i-* id，不冲突）。
var ICON_PATHS = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  medal: '<circle cx="12" cy="15" r="5"/><path d="M8.5 10.5 6 3h4l2 5 2-5h4l-2.5 7.5"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  doc: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M8 13h8M8 17h6"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  notes: '<path d="M9 4h6M9 4a2 2 0 0 0-2 2v0H5v15h14V6h-2a2 2 0 0 0-2-2"/><path d="M8 11h8M8 15h5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m4 6 1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>',
  pen: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13 7 4 4"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  redo: '<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  baton: '<path d="M4 20 16 8M14 4l6 6M12 6l6 6"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  lang: '<path d="M4 5h9M8.5 3v2M6 5c1 4 4 7 7 8M11 5c-1 4-4 7-7 8M13 21l4-9 4 9M14.5 18h5"/>',
  paint: '<circle cx="12" cy="12" r="9"/><circle cx="8" cy="10" r="1.2"/><circle cx="12" cy="7.5" r="1.2"/><circle cx="16" cy="10" r="1.2"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  shield: '<path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z"/>',
  flask: '<path d="M9 3h6M10 3v6L5 19a1 1 0 0 0 .9 1.5h12.2A1 1 0 0 0 19 19l-5-10V3"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  cap: '<path d="m2 9 10-5 10 5-10 5z"/><path d="M6 11v5c3 2 9 2 12 0v-5"/>',
};

export function renderIconSprite() {
  var symbols = '';
  for (var name in ICON_PATHS) {
    symbols += '<symbol id="i-' + name + '" viewBox="0 0 24 24">' + ICON_PATHS[name] + '</symbol>';
  }
  return '<svg class="rv2-sprite" width="0" height="0" aria-hidden="true" focusable="false"><defs>' + symbols + '</defs></svg>';
}

function icon(name, size) {
  var px = size || 20;
  return '<svg class="ic" width="' + px + '" height="' + px + '" aria-hidden="true" focusable="false"><use href="#i-' + name + '"></use></svg>';
}

// 探戈 logo（照 prototype .logo 抄；inline style + fill 属性保证按原型填充）。
var LOGO_SVG = '<svg class="logo" viewBox="0 0 100 100" aria-hidden="true" focusable="false" style="stroke:none">'
  + '<path d="M30 30 L28 12" stroke="#E95432" stroke-width="6" stroke-linecap="round"/>'
  + '<circle cx="27.5" cy="10" r="6" fill="#E95432"/>'
  + '<path d="M70 30 C71 18 74 13 79 14 C84 15 83 22 78 21" stroke="#E95432" stroke-width="6" fill="none" stroke-linecap="round"/>'
  + '<rect x="9" y="42" width="12" height="24" rx="5" fill="#E95432"/>'
  + '<rect x="79" y="42" width="12" height="24" rx="5" fill="#E95432"/>'
  + '<rect x="16" y="28" width="68" height="62" rx="18" fill="#E95432"/>'
  + '<path d="M33 45 H68 M51 46 L46 76" stroke="#FAF6EC" stroke-width="8" stroke-linecap="round" fill="none"/>'
  + '</svg>';

function tabEntries(copy) {
  return [
    { id: 'start', href: '#/start', label: copy.tabStart, icon: 'home' },
    { id: 'me', href: '#/me', label: copy.tabMe, icon: 'medal' },
    { id: 'discover', href: '#/discover', label: copy.tabDiscover, icon: 'compass' },
  ];
}

function badgeHtml(user, copy) {
  var badge = identityBadge(user);
  var title = badge.kind === 'guest' ? copy.guest : String(user && user.displayName != null ? user.displayName : badge.label);
  return '<span class="guest" data-badge-kind="' + badge.kind + '" title="' + esc(title) + '">' + esc(badge.label) + '</span>';
}

// 顶栏：手机与桌面共用（桌面多出 tabs，relay.css 按 900px 切换，原型 .top）。
export function renderTopBar(info, ctx) {
  var copy = shellCopy(ctx && ctx.lang, ctx && ctx.copy);
  var tab = activeTab(info) || '';
  var tabs = '';
  var entries = tabEntries(copy);
  for (var i = 0; i < entries.length; i += 1) {
    var entry = entries[i];
    var on = entry.id === tab;
    tabs += '<a class="' + (on ? 'on' : '') + '" href="' + entry.href + '"'
      + (on ? ' aria-current="page"' : '') + '>' + esc(entry.label) + '</a>';
  }
  return '<header class="top">'
    + LOGO_SVG
    + '<div class="name">' + esc(copy.brandName) + '<small>' + esc(copy.brandSub) + '</small></div>'
    + '<nav class="tabs-desk">' + tabs + '</nav>'
    + '<div class="sp"></div>'
    + badgeHtml(ctx && ctx.user, copy)
    + '<a class="iconbtn" href="#/more" aria-label="' + esc(copy.moreAria) + '">' + icon('more', 22) + '</a>'
    + '</header>';
}

// 手机底栏（<900px 显示；桌面隐藏，原型 .tabbar）。
export function renderTabBar(info, ctx) {
  var copy = shellCopy(ctx && ctx.lang, ctx && ctx.copy);
  var tab = activeTab(info) || '';
  var entries = tabEntries(copy);
  var buttons = '';
  for (var i = 0; i < entries.length; i += 1) {
    var entry = entries[i];
    var on = entry.id === tab;
    buttons += '<a class="tab' + (on ? ' on' : '') + '" href="' + entry.href + '" aria-label="' + esc(entry.label) + '"'
      + (on ? ' aria-current="page"' : '') + '>' + icon(entry.icon, 24) + '<span>' + esc(entry.label) + '</span></a>';
  }
  return '<nav class="tabbar"><div class="in">' + buttons + '</div></nav>';
}

// 更多页行组件（原型 .list/.it）。带 href 渲染成链接；否则按钮 + data-r-toggle。
function moreRow(copy, options) {
  var value = options.value == null ? '' : '<em>' + esc(options.value) + '</em>';
  var inner = icon(options.icon, 20) + '<span>' + esc(options.label) + '</span>' + value + icon('chev', 16);
  if (options.href) {
    return '<a class="it" href="' + esc(options.href) + '">' + inner + '</a>';
  }
  return '<button type="button" class="it" data-r-toggle="' + esc(options.toggle) + '"'
    + (options.expanded ? ' aria-expanded="true"' : ' aria-expanded="false"') + '>' + inner + '</button>';
}

function optionRow(label, attrs, selected) {
  return '<button type="button" class="opt' + (selected ? ' on' : '') + '"' + attrs + '>'
    + (selected ? icon('check', 18) : '<span class="opt-space"></span>')
    + '<span>' + esc(label) + '</span></button>';
}

function aiAppsHtml(apps, copy) {
  if (!apps || !apps.length) return '<p class="panel-note">' + esc(copy.aiAppsUnavailable) + '</p>';
  var items = '';
  for (var i = 0; i < apps.length; i += 1) {
    var app = apps[i] || {};
    var name = String(app.name == null ? '' : app.name).trim();
    var url = String(app.url == null ? '' : app.url).trim();
    if (!name || !url) continue;
    var note = app.note ? ' <span class="app-note">' + esc(app.note) + '</span>' : '';
    items += '<li><a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(name) + '</a>' + note + '</li>';
  }
  if (!items) return '<p class="panel-note">' + esc(copy.aiAppsUnavailable) + '</p>';
  return '<ul class="apps-list">' + items + '</ul>';
}

// 更多页（SPEC §4⑦ + 原型 s-more）。state = { user, lang, appearance, expanded, apps, copy }
// expanded ∈ null | 'language' | 'appearance' | 'ai' | 'privacy'。
export function renderMorePage(state) {
  var s = state || {};
  var copy = shellCopy(s.lang, s.copy);
  var expanded = s.expanded == null ? null : String(s.expanded);
  var lang = s.lang === 'en' ? 'en' : 'zh';
  var badge = identityBadge(s.user);
  var accountValue = badge.kind === 'guest' ? copy.accountGuest
    : String(s.user && s.user.displayName != null && String(s.user.displayName).trim() ? s.user.displayName : badge.label);

  var html = '<section id="more-page">';
  html += '<h1>' + esc(copy.moreTitle) + '</h1>';

  // 分组一：账号 / 语言 / 外观（SPEC §4⑦）
  html += '<div class="list">';
  html += moreRow(copy, { icon: 'user', label: copy.account, value: accountValue, href: '#settings' });
  html += moreRow(copy, { icon: 'lang', label: copy.language, value: lang === 'en' ? copy.langEn : copy.langZh, toggle: 'language', expanded: expanded === 'language' });
  if (expanded === 'language') {
    html += '<div class="panel" role="group" aria-label="' + esc(copy.language) + '">'
      + optionRow(copy.langZh, ' data-r-lang="zh"', lang !== 'en')
      + optionRow(copy.langEn, ' data-r-lang="en"', lang === 'en')
      + '</div>';
  }
  html += moreRow(copy, { icon: 'paint', label: copy.appearance, value: appearanceLabel(s.appearance, lang), toggle: 'appearance', expanded: expanded === 'appearance' });
  if (expanded === 'appearance') {
    var opts = '';
    for (var i = 0; i < APPEARANCES.length; i += 1) {
      var theme = APPEARANCES[i];
      opts += optionRow(appearanceLabel(theme, lang), ' data-r-appearance="' + theme + '"', theme === (s.appearance || 'standard'));
    }
    html += '<div class="panel" role="group" aria-label="' + esc(copy.appearance) + '">' + opts + '</div>';
  }
  html += '</div>';

  // 分组二：我们用了哪些 AI / 隐私与数据
  html += '<div class="list">';
  html += moreRow(copy, { icon: 'cpu', label: copy.aiRow, value: copy.aiNote, toggle: 'ai', expanded: expanded === 'ai' });
  if (expanded === 'ai') {
    html += '<div class="panel"><p class="panel-note">' + esc(copy.aiIntro) + '</p>'
      + '<p class="panel-note"><strong>' + esc(copy.aiGateway) + '</strong></p>'
      + '<p class="panel-head">' + esc(copy.aiAppsHead) + '</p>'
      + aiAppsHtml(s.apps, copy)
      + '</div>';
  }
  html += moreRow(copy, { icon: 'shield', label: copy.privacyRow, value: copy.privacyNote, toggle: 'privacy', expanded: expanded === 'privacy' });
  if (expanded === 'privacy') {
    html += '<div class="panel">'
      + '<button type="button" class="btn line wide" data-r-export>' + esc(copy.exportJson) + '</button>'
      + '<button type="button" class="btn line wide danger-btn" data-r-delete>' + esc(copy.deleteLocal) + '</button>'
      + '</div>';
  }
  html += '</div>';

  // 实验室：旧功能收进 #/lab/*（D2）。时间记录与回顾从旧首页（#/lab/today）进入，
  // 旧页内部导航可达 line/review；约定与小组 = #/lab/agreements。
  html += '<p class="lab">' + esc(copy.labsCaption) + '</p>';
  html += '<div class="list">';
  html += moreRow(copy, { icon: 'flask', label: copy.labTime, value: copy.legacyTag, href: '#/lab/today' });
  html += moreRow(copy, { icon: 'cal', label: copy.labGroup, value: copy.legacyTag, href: '#/lab/agreements' });
  html += '</div>';

  html += '</section>';
  return html;
}

// ---------------------------------------------------------------------------
// createRelayShell — 浏览器挂载器（DI：doc/win/mount/storage 全部可注入）
// ---------------------------------------------------------------------------

function defaultEmit(mount, win) {
  return function (name, detail) {
    var root = mount || null;
    if (root && typeof root.dispatchEvent === 'function') {
      var Ctor = (win && win.CustomEvent) || (typeof CustomEvent !== 'undefined' ? CustomEvent : null);
      if (Ctor) root.dispatchEvent(new Ctor(name, { detail: detail, bubbles: true }));
    }
  };
}

export function createRelayShell(options) {
  var o = options || {};
  var doc = o.doc || (typeof document !== 'undefined' ? document : null);
  var win = o.win || (typeof window !== 'undefined' ? window : null);
  var mount = o.mount || null;
  var storage = o.storage || (win && win.localStorage) || null;
  var getUser = typeof o.getUser === 'function' ? o.getUser : function () { return win ? win.TangoCurrentUser || null : null; };
  var getLang = typeof o.getLang === 'function' ? o.getLang : function () {
    var value = doc && doc.documentElement ? doc.documentElement.lang || '' : '';
    return String(value).split('-')[0] === 'en' ? 'en' : 'zh';
  };
  var emit = typeof o.emit === 'function' ? o.emit : defaultEmit(mount, win);
  var renderers = {};
  var state = { expanded: null, apps: null, appsLoading: false, lastInfo: null };

  function copyOverrides() { return o.copy || null; }

  function currentAppearance() {
    var value = doc && doc.documentElement ? doc.documentElement.getAttribute('data-appearance') : null;
    if (APPEARANCES.indexOf(value) >= 0) return value;
    var saved = storageGet(storage, APPEARANCE_KEY);
    return APPEARANCES.indexOf(saved) >= 0 ? saved : 'standard';
  }

  function pageHtml(info) {
    if (info.route === 'more') {
      return renderMorePage({
        user: getUser(),
        lang: getLang(),
        appearance: currentAppearance(),
        expanded: state.expanded,
        apps: state.apps,
        copy: copyOverrides(),
      });
    }
    var renderer = renderers[info.route];
    if (typeof renderer === 'function') {
      return renderer({
        route: info.route,
        query: info.query || '',
        user: getUser(),
        lang: getLang(),
        shell: api,
      }) || '';
    }
    return '';
  }

  function render(info) {
    state.lastInfo = info;
    if (!mount) return;
    if (info.kind !== 'relay') {
      // lab / legacy：旧页面原样接管（D2），relay 外壳整体让位。
      mount.style.display = 'none';
      if (mount.getAttribute('data-relay-active') === '1') {
        mount.setAttribute('data-relay-active', '0');
        emit('relay:route-legacy', info);
      }
      return;
    }
    mount.style.display = '';
    var wasActive = mount.getAttribute('data-relay-active') === '1';
    mount.setAttribute('data-relay-active', '1');
    var ctx = { user: getUser(), lang: getLang(), copy: copyOverrides() };
    // .rv2 是 relay.css 的 token/样式作用域根；内部结构 = 原型（.app 列 + .tabbar）。
    mount.innerHTML = '<div class="rv2">' + renderIconSprite()
      + '<div class="app">' + renderTopBar(info, ctx) + '<main id="rv2-main">' + pageHtml(info) + '</main></div>'
      + renderTabBar(info, ctx) + '</div>';
    if (win && win.scrollTo) win.scrollTo(0, 0);
    if (!wasActive) emit('relay:route', info);
  }

  function handleHash() {
    var info = resolveRoute(win ? win.location.hash : '');
    if (info.redirect) {
      if (win && win.location && typeof win.location.replace === 'function') {
        win.location.replace(info.redirect); // 触发 hashchange 后重新渲染
        return;
      }
      if (win && win.location) win.location.hash = info.redirect;
      return;
    }
    state.expanded = null; // 路由切换收起更多页面板
    render(info);
  }

  function rerenderMore() {
    if (!mount || !state.lastInfo || state.lastInfo.kind !== 'relay' || state.lastInfo.route !== 'more') return;
    var main = typeof mount.querySelector === 'function' ? mount.querySelector('#rv2-main') : null;
    if (main) {
      main.innerHTML = renderMorePage({
        user: getUser(),
        lang: getLang(),
        appearance: currentAppearance(),
        expanded: state.expanded,
        apps: state.apps,
        copy: copyOverrides(),
      });
    }
  }

  function loadApps() {
    // external-apps.js 归另一条线；动态 import()，缺文件时 reject → 面板降级为占位文案。
    if (state.apps || state.appsLoading) return;
    state.appsLoading = true;
    try {
      import('./external-apps.js').then(function (mod) {
        var list = mod && (mod.EXTERNAL_APPS || mod.default || mod.apps);
        if (Array.isArray(list)) {
          state.apps = list;
          rerenderMore();
        }
      }).catch(function () { /* 面板保持降级文案 */ });
    } catch (e) { /* 旧引擎无动态 import：面板保持降级文案 */ }
  }

  function onClick(event) {
    var target = event && event.target;
    if (!target || typeof target.closest !== 'function') return;
    var toggle = target.closest('[data-r-toggle]');
    if (toggle) {
      var key = toggle.getAttribute('data-r-toggle');
      state.expanded = state.expanded === key ? null : key;
      if (state.expanded === 'ai') loadApps();
      rerenderMore();
      return;
    }
    var langBtn = target.closest('[data-r-lang]');
    if (langBtn) {
      var nextLang = applyLanguage(langBtn.getAttribute('data-r-lang'), doc, storage);
      state.expanded = null;
      emit('relay:lang-change', nextLang);
      handleHash();
      return;
    }
    var themeBtn = target.closest('[data-r-appearance]');
    if (themeBtn) {
      var nextTheme = applyAppearance(themeBtn.getAttribute('data-r-appearance'), doc, storage);
      state.expanded = null;
      emit('relay:appearance-change', nextTheme);
      handleHash();
      return;
    }
    if (target.closest('[data-r-export]')) {
      emit('relay:export-records', null);
      if (typeof o.onExportRecords === 'function') o.onExportRecords();
      return;
    }
    if (target.closest('[data-r-delete]')) {
      emit('relay:delete-records', null);
      if (typeof o.onDeleteRecords === 'function') o.onDeleteRecords();
    }
  }

  var started = false;
  var api = {
    start: function () {
      if (started || !win || !mount) return;
      started = true;
      if (typeof mount.addEventListener === 'function') mount.addEventListener('click', onClick);
      if (typeof win.addEventListener === 'function') win.addEventListener('hashchange', handleHash);
      handleHash();
    },
    registerRoute: function (name, renderer) {
      if (RELAY_ROUTES.indexOf(name) >= 0 && name !== 'more' && typeof renderer === 'function') renderers[name] = renderer;
    },
    handleHash: handleHash,
    setAppearance: function (value) {
      var theme = applyAppearance(value, doc, storage);
      emit('relay:appearance-change', theme);
      handleHash();
      return theme;
    },
    setLanguage: function (value) {
      var lang = applyLanguage(value, doc, storage);
      emit('relay:lang-change', lang);
      handleHash();
      return lang;
    },
    identity: function () { return identityBadge(getUser()); },
    routeInfo: function () { return state.lastInfo; },
    state: state,
  };
  return api;
}
