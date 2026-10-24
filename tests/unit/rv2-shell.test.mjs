import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// RV2 L1 外壳路由线: web/relay/shell.js + web/relay/relay.css。
// SPEC design/relay-v2/SPEC.md §2（路由表）、§3（设计 token）、§4⑦（更多页）、
// §6（无障碍 / RTL / reduced-motion）。视觉标准 = design/relay-v2/prototype.html。
//
// 钉死的决策：
// - 旧 hash 全部重定向: ''/'#today' → '#/start'; '#line'/'#review'/'#agreements'
//   → '#/lab/*'; '#settings'/'#users'/'#assistant' 沿用（legacy, 不重定向）。
// - relay.css 的 token 作用域在 .rv2（与旧页 appearance.css 的同名 :root
//   变量隔离），外观主题用 html[data-appearance=X] .rv2 重定义同名 token。
// - designer 主题深色，文本对比度必须 ≥ 4.5:1（SPEC §3 硬要求）。
// - D3: 外壳渲染输出不出现任何模型估算分钟数。

import {
  RELAY_ROUTES,
  LAB_PAGES,
  LEGACY_ROUTES,
  DEFAULT_HASH,
  parseHash,
  resolveRoute,
  activeTab,
  APPEARANCES,
  APPEARANCE_KEY,
  LANG_KEY,
  SHELL_LANGS,
  appearanceLabel,
  applyAppearance,
  applyLanguage,
  identityBadge,
  esc,
  renderIconSprite,
  renderTopBar,
  renderTabBar,
  renderMorePage,
  createRelayShell,
} from '../../web/relay/shell.js';

// ---------------------------------------------------------------------------
// CSS helpers — token blocks + WCAG contrast + scope check.
// ---------------------------------------------------------------------------

const cssPath = fileURLToPath(new URL('../../web/relay/relay.css', import.meta.url));
const cssText = readFileSync(cssPath, 'utf8');

// Strip comments, then drop @keyframes blocks (their inner percentage
// selectors are not element selectors).
function cssWithoutKeyframes(text) {
  const s = text.replace(/\/\*[\s\S]*?\*\//g, '');
  let cleaned = '';
  let i = 0;
  while (i < s.length) {
    const k = s.indexOf('@keyframes', i);
    if (k === -1) { cleaned += s.slice(i); break; }
    cleaned += s.slice(i, k);
    let depth = 0;
    let j = s.indexOf('{', k);
    for (; j < s.length; j += 1) {
      if (s[j] === '{') depth += 1;
      else if (s[j] === '}') { depth -= 1; if (depth === 0) break; }
    }
    i = j + 1;
  }
  return cleaned;
}

const cssFlat = cssWithoutKeyframes(cssText);

function cssSelectors() {
  const out = [];
  const re = /([^{}]+)\{/g;
  let m;
  while ((m = re.exec(cssFlat))) {
    const sel = m[1].trim();
    if (sel) out.push(sel);
  }
  return out;
}

// Extract the declarations of the first rule whose selector list contains
// `selector` as the final compound of a comma part (e.g. '.tabbar' matches
// both '.rv2 .tabbar' and '.tabbar').
function ruleBody(selectorPiece) {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(cssFlat))) {
    const parts = m[1].split(',').map((p) => p.trim());
    const hit = parts.some((p) => p === selectorPiece || p.endsWith(' ' + selectorPiece) || p.endsWith('>' + selectorPiece));
    if (hit) return m[2];
  }
  return null;
}

function tokenMap(blockText) {
  const map = {};
  const re = /(--[A-Za-z0-9-]+)\s*:\s*([^;{}]+)/g;
  let m;
  while ((m = re.exec(blockText))) map[m[1].trim()] = m[2].trim();
  return map;
}

// Balanced-brace walk from the first `html[data-appearance=X] .rv2 {` match.
function themeBlock(appearance) {
  const at = cssFlat.indexOf('html[data-appearance=' + appearance + '] .rv2');
  assert.notEqual(at, -1, 'relay.css must contain html[data-appearance=' + appearance + '] .rv2 token block');
  const open = cssFlat.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < cssFlat.length; i += 1) {
    if (cssFlat[i] === '{') depth += 1;
    else if (cssFlat[i] === '}') {
      depth -= 1;
      if (depth === 0) return tokenMap(cssFlat.slice(open + 1, i));
    }
  }
  throw new Error('unbalanced block for ' + appearance);
}

function relLuminance(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  assert.ok(m, 'not a #rrggbb color: ' + hex);
  const rgb = [m[1].slice(0, 2), m[1].slice(2, 4), m[1].slice(4, 6)]
    .map((pair) => parseInt(pair, 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function contrast(fg, bg) {
  const a = relLuminance(fg);
  const b = relLuminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// SPEC §3 exact tokens (standard appearance, prototype :root values).
const SPEC_TOKENS = {
  '--bg': '#FAF8F3', '--surface': '#FFFFFF', '--sunk': '#F3F0E8',
  '--ink': '#252722', '--ink2': '#64665D', '--ink3': '#8E9086', '--line': '#E4E2D8',
  '--brand': '#E95432', '--brand-soft': '#FDECE6',
  '--forest': '#335D4B', '--forest-soft': '#E7F0EA',
  '--gold': '#E8B04B', '--gold-soft': '#FBF1DC',
  '--ok': '#2F7D57', '--warn': '#B7791F', '--err': '#B4432F',
  '--r-lg': '20px', '--r-md': '14px', '--r-sm': '10px',
  '--shadow': '0 1px 2px rgba(37,39,34,.05),0 8px 24px rgba(37,39,34,.06)',
  '--t-hero': '28px', '--t-h2': '20px', '--t-body': '16px', '--t-sm': '14px', '--t-xs': '12px',
  '--tap': '48px',
};
const THEME_REQUIRED_TOKENS = [
  '--bg', '--surface', '--sunk', '--ink', '--ink2', '--ink3', '--line',
  '--brand', '--brand-ink', '--brand-soft', '--forest', '--forest-soft',
  '--gold', '--gold-soft', '--ok', '--warn', '--err',
  '--r-lg', '--r-md', '--r-sm', '--shadow',
];

// ---------------------------------------------------------------------------
// §2 路由：hash 解析、重定向矩阵、tab 高亮
// ---------------------------------------------------------------------------

test('RELAY_ROUTES / LAB_PAGES / LEGACY_ROUTES cover the SPEC §2 table', () => {
  assert.deepEqual(RELAY_ROUTES, ['start', 'relay', 'me', 'discover', 'more']);
  assert.deepEqual(LAB_PAGES, ['today', 'line', 'review', 'agreements']);
  assert.deepEqual(LEGACY_ROUTES, ['settings', 'users', 'assistant']);
  assert.equal(DEFAULT_HASH, '#/start');
});

test('parseHash: strips #, optional slash, query; keeps path only', () => {
  assert.deepEqual(parseHash('#/relay'), { path: 'relay', query: '' });
  assert.deepEqual(parseHash('#/relay?u=meeting-notes&x=1'), { path: 'relay', query: 'u=meeting-notes&x=1' });
  assert.deepEqual(parseHash('#relay'), { path: 'relay', query: '' });
  assert.deepEqual(parseHash(''), { path: '', query: '' });
  assert.deepEqual(parseHash('#'), { path: '', query: '' });
  assert.deepEqual(parseHash('#/lab/line'), { path: 'lab/line', query: '' });
});

test('resolveRoute: empty and #today redirect to #/start (SPEC §2)', () => {
  assert.equal(resolveRoute('').redirect, '#/start');
  assert.equal(resolveRoute('#').redirect, '#/start');
  assert.equal(resolveRoute('#today').redirect, '#/start');
  assert.equal(resolveRoute('#/today').redirect, '#/start');
});

test('resolveRoute: relay routes resolve without redirect', () => {
  for (const route of RELAY_ROUTES) {
    const info = resolveRoute('#/' + route);
    assert.equal(info.redirect, null, route);
    assert.equal(info.kind, 'relay', route);
    assert.equal(info.route, route, route);
  }
  // '#start' tolerated as the same canonical route (no leading slash).
  assert.equal(resolveRoute('#start').route, 'start');
  assert.equal(resolveRoute('#start').kind, 'relay');
});

test('resolveRoute: legacy #line/#review/#agreements redirect into #/lab/*', () => {
  assert.equal(resolveRoute('#line').redirect, '#/lab/line');
  assert.equal(resolveRoute('#review').redirect, '#/lab/review');
  assert.equal(resolveRoute('#agreements').redirect, '#/lab/agreements');
});

test('resolveRoute: #/lab/<page> resolves kind lab for all four pages', () => {
  for (const page of LAB_PAGES) {
    const info = resolveRoute('#/lab/' + page);
    assert.equal(info.redirect, null, page);
    assert.equal(info.kind, 'lab', page);
    assert.equal(info.lab, page, page);
  }
});

test('resolveRoute: #settings/#users/#assistant stay legacy, no redirect', () => {
  for (const name of LEGACY_ROUTES) {
    const info = resolveRoute('#' + name);
    assert.equal(info.redirect, null, name);
    assert.equal(info.kind, 'legacy', name);
    assert.equal(info.route, name, name);
  }
});

test('resolveRoute: unknown hashes fall back to #/start', () => {
  assert.equal(resolveRoute('#xyz').redirect, '#/start');
  assert.equal(resolveRoute('#/START').redirect, '#/start'); // ids are lowercase
  assert.equal(resolveRoute('#/lab/nope').redirect, '#/start');
  assert.equal(resolveRoute('#/lab/').redirect, '#/start');
  assert.equal(resolveRoute('#/lab').redirect, '#/start');
});

test('resolveRoute: query string survives on relay routes', () => {
  const info = resolveRoute('#/relay?u=meeting-notes');
  assert.equal(info.route, 'relay');
  assert.equal(info.query, 'u=meeting-notes');
});

test('activeTab: start+relay→start, me→me, discover→discover, others null', () => {
  assert.equal(activeTab(resolveRoute('#/start')), 'start');
  assert.equal(activeTab(resolveRoute('#/relay')), 'start');
  assert.equal(activeTab(resolveRoute('#/me')), 'me');
  assert.equal(activeTab(resolveRoute('#/discover')), 'discover');
  assert.equal(activeTab(resolveRoute('#/more')), null);
  assert.equal(activeTab(resolveRoute('#/lab/line')), null);
  assert.equal(activeTab(resolveRoute('#settings')), null);
  assert.equal(activeTab(resolveRoute('#line')), null); // redirecting — no tab
});

// ---------------------------------------------------------------------------
// 身份徽标（SPEC §2: 访客显示"访客"，登录后显示称呼首字）
// ---------------------------------------------------------------------------

test('identityBadge: guest shows 访客', () => {
  assert.deepEqual(identityBadge(null), { kind: 'guest', label: '访客' });
  assert.deepEqual(identityBadge(undefined), { kind: 'guest', label: '访客' });
});

test('identityBadge: logged-in shows first grapheme of 称呼', () => {
  assert.deepEqual(identityBadge({ displayName: '王小明' }), { kind: 'user', label: '王' });
  assert.deepEqual(identityBadge({ displayName: '小明', username: 'x' }), { kind: 'user', label: '小' });
  // surrogate pair / emoji is one grapheme for [...str]
  assert.equal(identityBadge({ displayName: '🎨设计' }).label, '🎨');
});

test('identityBadge: falls back username → email local part → 客', () => {
  assert.equal(identityBadge({ displayName: '   ', username: 'jc' }).label, 'j');
  assert.equal(identityBadge({ displayName: '', email: 'tim0n@qq.com' }).label, 't');
  assert.equal(identityBadge({ email: 'a@b.c' }).label, 'a');
  assert.equal(identityBadge({}).label, '客');
  assert.equal(identityBadge({}).kind, 'user');
});

// ---------------------------------------------------------------------------
// 外观（五种主题映射，SPEC §3 + web/appearance.js 主题名）
// ---------------------------------------------------------------------------

test('APPEARANCES: exactly the five legacy theme ids', () => {
  assert.deepEqual(APPEARANCES, ['standard', 'swiss', 'archive', 'designer', 'workbench']);
});

test('appearanceLabel: zh labels match web/appearance.js copy', () => {
  assert.equal(appearanceLabel('standard', 'zh'), '标准');
  assert.equal(appearanceLabel('swiss', 'zh'), '瑞士雪境研究桌');
  assert.equal(appearanceLabel('archive', 'zh'), '个人时间档案');
  assert.equal(appearanceLabel('designer', 'zh'), '夜间观测花园');
  assert.equal(appearanceLabel('workbench', 'zh'), '知识工作台');
  assert.equal(appearanceLabel('workbench', 'en'), 'Knowledge workbench');
  assert.equal(appearanceLabel('nope', 'zh'), '标准');
});

test('applyAppearance: sets html attrs + storage like web/appearance.js', () => {
  const html = fakeElement('html');
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  applyAppearance('designer', { documentElement: html }, storage);
  assert.equal(html.attributes['data-appearance'], 'designer');
  assert.equal(html.attributes['data-theme'], 'dark');
  assert.equal(html.attributes['data-tone'], 'dark');
  assert.equal(store.get(APPEARANCE_KEY), 'designer');
  applyAppearance('swiss', { documentElement: html }, storage);
  assert.equal(html.attributes['data-appearance'], 'swiss');
  assert.equal(html.attributes['data-theme'], 'light');
  assert.equal(store.get('tango-donego.appearance.v1'), 'swiss');
  applyAppearance('bogus', { documentElement: html }, storage); // rejected → standard
  assert.equal(html.attributes['data-appearance'], 'standard');
});

test('applyLanguage: sets lang/dir + storage; ar goes rtl (SPEC §6)', () => {
  const html = fakeElement('html');
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  applyLanguage('en', { documentElement: html }, storage);
  assert.equal(html.attributes.lang, 'en');
  assert.equal(html.attributes.dir, 'ltr');
  applyLanguage('ar', { documentElement: html }, storage);
  assert.equal(html.attributes.dir, 'rtl');
  assert.equal(store.get(LANG_KEY), 'ar');
  assert.deepEqual(SHELL_LANGS, ['zh', 'en']);
});

// ---------------------------------------------------------------------------
// 渲染：顶栏 / 底栏（原型 .top / .tabbar 的结构与文案）
// ---------------------------------------------------------------------------

test('renderTopBar: logo, tabs, badge, more button per prototype', () => {
  const html = renderTopBar(resolveRoute('#/start'), { user: null, lang: 'zh' });
  assert.match(html, /<header class="top">/);
  assert.match(html, /探戈/);
  assert.match(html, /Done&amp;Go/);
  assert.match(html, /href="#\/start"/);
  assert.match(html, /href="#\/me"/);
  assert.match(html, /href="#\/discover"/);
  assert.match(html, /我的用法/);
  assert.match(html, /发现/);
  assert.ok(html.includes('开始'));
  assert.match(html, /aria-label="更多"/);
  assert.match(html, /href="#\/more"/);
  assert.ok(html.includes('访客'), 'guest badge shows 访客');
  assert.match(html, /class="guest" data-badge-kind="guest"/);
  // active tab carries aria-current="page" (a11y, SPEC §6)
  assert.match(html, /aria-current="page"[^>]*href="#\/start"|href="#\/start"[^>]*aria-current="page"/);
});

test('renderTopBar: active tab follows the route; logged-in badge shows 称呼首字', () => {
  const me = renderTopBar(resolveRoute('#/me'), { user: { displayName: '王小明' }, lang: 'zh' });
  assert.match(me, /aria-current="page"[^>]*href="#\/me"|href="#\/me"[^>]*aria-current="page"/);
  assert.match(me, /class="guest" data-badge-kind="user"/);
  assert.ok(me.includes('>王<'), 'badge shows first char of 称呼');
  const relay = renderTopBar(resolveRoute('#/relay'), { user: null, lang: 'zh' });
  assert.match(relay, /aria-current="page"[^>]*href="#\/start"|href="#\/start"[^>]*aria-current="page"/);
});

test('renderTabBar: three mobile tabs with icons and active state', () => {
  const html = renderTabBar(resolveRoute('#/discover'), { lang: 'zh' });
  assert.match(html, /<nav class="tabbar">/);
  assert.match(html, /href="#\/start"/);
  assert.match(html, /href="#\/me"/);
  assert.match(html, /href="#\/discover"/);
  assert.ok(html.includes('开始') && html.includes('我的用法') && html.includes('发现'));
  assert.match(html, /#i-home/);
  assert.match(html, /#i-medal/);
  assert.match(html, /#i-compass/);
  // exactly one active tab
  const active = html.match(/class="tab on"/g) || [];
  assert.equal(active.length, 1, 'exactly one active tab');
  assert.match(html, /aria-label="发现"/);
});

test('renderIconSprite: hidden sprite defines prototype #i-* symbols', () => {
  const html = renderIconSprite();
  for (const name of ['home', 'medal', 'compass', 'more', 'mic', 'arrow', 'doc', 'spark', 'baton', 'user', 'paint', 'flask']) {
    assert.match(html, new RegExp('id="i-' + name + '"'), name);
  }
  assert.match(html, /aria-hidden="true"/);
});

// ---------------------------------------------------------------------------
// 更多页（SPEC §4⑦ + 原型 S7）
// ---------------------------------------------------------------------------

const MORE_BASE = { user: null, lang: 'zh', appearance: 'standard', expanded: null, apps: null };

test('renderMorePage: exact row copy from prototype S7', () => {
  const html = renderMorePage(MORE_BASE);
  assert.ok(html.includes('>更多</h1>'));
  assert.ok(html.includes('账号'));
  assert.ok(html.includes('访客 · 去登录'));
  assert.ok(html.includes('语言'));
  assert.ok(html.includes('外观'));
  assert.ok(html.includes('>标准</em>'));
  assert.ok(html.includes('我们用了哪些 AI'));
  assert.ok(html.includes('说明与出处'));
  assert.ok(html.includes('隐私与数据'));
  assert.ok(html.includes('导出 · 删除'));
  assert.ok(html.includes('实验室（早期功能，不影响主流程）'));
  assert.ok(html.includes('时间记录与回顾'));
  assert.ok(html.includes('约定与小组'));
  const legacyTags = html.match(/<em[^>]*>旧版<\/em>/g) || [];
  assert.equal(legacyTags.length, 2, 'both lab rows carry 旧版');
});

test('renderMorePage: account row links to legacy #settings; lab rows to #/lab/*', () => {
  const html = renderMorePage(MORE_BASE);
  assert.match(html, /href="#settings"/); // SPEC §2: 账号路由沿用现有无斜杠 hash
  assert.match(html, /href="#\/lab\/today"/);
  assert.match(html, /href="#\/lab\/agreements"/);
});

test('renderMorePage: appearance panel lists all five themes with data attrs', () => {
  const html = renderMorePage({ ...MORE_BASE, expanded: 'appearance' });
  for (const theme of APPEARANCES) {
    assert.match(html, new RegExp('data-r-appearance="' + theme + '"'));
  }
  assert.ok(html.includes('瑞士雪境研究桌'));
  assert.ok(html.includes('夜间观测花园'));
});

test('renderMorePage: language panel offers 中文 / English', () => {
  const html = renderMorePage({ ...MORE_BASE, expanded: 'language' });
  assert.match(html, /data-r-lang="zh"/);
  assert.match(html, /data-r-lang="en"/);
  assert.ok(html.includes('中文') && html.includes('English'));
});

test('renderMorePage: privacy panel exposes export + delete actions', () => {
  const html = renderMorePage({ ...MORE_BASE, expanded: 'privacy' });
  assert.match(html, /data-r-export/);
  assert.match(html, /data-r-delete/);
  assert.ok(html.includes('导出我的记录（JSON）'));
  assert.ok(html.includes('删除本机记录'));
});

test('renderMorePage: AI panel mentions gateway auto; apps list when provided', () => {
  const panel = renderMorePage({ ...MORE_BASE, expanded: 'ai' });
  assert.ok(panel.includes('auto'), 'gateway named auto');
  assert.ok(panel.includes('网关'));
  const withApps = renderMorePage({
    ...MORE_BASE, expanded: 'ai',
    apps: [{ id: 'doubao', name: '豆包', url: 'https://www.doubao.com/chat/', region: 'cn' }],
  });
  assert.ok(withApps.includes('豆包'));
  assert.match(withApps, /href="https:\/\/www\.doubao\.com\/chat\/"/);
  // without the external-apps module the panel degrades, never lies
  assert.ok(panel.includes('暂不可用'));
});

test('renderMorePage: logged-in account row shows 称呼 (escaped)', () => {
  const html = renderMorePage({ ...MORE_BASE, user: { displayName: '老王' } });
  assert.ok(html.includes('老王'));
  assert.ok(!html.includes('访客 · 去登录'));
});

test('renderMorePage: D3 — no estimated minutes anywhere', () => {
  for (const expanded of [null, 'language', 'appearance', 'ai', 'privacy']) {
    const html = renderMorePage({ ...MORE_BASE, expanded });
    assert.ok(!html.includes('estimatedSavedMinutes'), 'expanded=' + expanded);
    assert.ok(!html.includes('分钟'), 'expanded=' + expanded);
  }
});

test('esc: shell output escapes user-provided strings', () => {
  assert.equal(esc('<script>x</script>&"\''), '&lt;script&gt;x&lt;/script&gt;&amp;&quot;&#39;');
  const html = renderMorePage({ ...MORE_BASE, user: { displayName: '<script>alert(1)</script>王' } });
  assert.ok(!html.includes('<script>alert(1)'), 'raw script never reaches the DOM');
  const bar = renderTopBar(resolveRoute('#/start'), { user: { displayName: '<b>王</b>' }, lang: 'zh' });
  assert.ok(!bar.includes('<b>王</b>'));
});

test('renderMorePage: en copy falls in for lang=en', () => {
  const html = renderMorePage({ ...MORE_BASE, lang: 'en' });
  assert.ok(html.includes('Appearance'));
  assert.ok(html.includes('Privacy &amp; data'));
});

// ---------------------------------------------------------------------------
// 挂载（createRelayShell, DI 风格 — fake DOM）
// ---------------------------------------------------------------------------

function fakeElement(tag) {
  return {
    tagName: tag,
    style: {},
    attributes: {},
    listeners: {},
    innerHTML: '',
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    appendChild(child) { return child; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
}

function fakeWin(initialHash) {
  const location = {
    hash: initialHash,
    replaced: [],
    replace(target) { this.replaced.push(target); this.hash = target; },
  };
  return { location, addEventListener() {}, scrollTo() {}, CustomEvent: undefined };
}

function fakeDoc() {
  return { documentElement: fakeElement('html'), body: fakeElement('body'), createElement: fakeElement };
}

const memoryStorage = () => {
  const store = new Map();
  return { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
};

test('createRelayShell: legacy hashes are location.replace()d (no back-trap)', () => {
  const win = fakeWin('#line');
  const shell = createRelayShell({ doc: fakeDoc(), win, mount: fakeElement('div'), storage: memoryStorage() });
  shell.start();
  assert.deepEqual(win.location.replaced, ['#/lab/line']);
});

test('createRelayShell: #today and empty hash redirect to #/start', () => {
  for (const hash of ['#today', '', '#']) {
    const win = fakeWin(hash);
    const shell = createRelayShell({ doc: fakeDoc(), win, mount: fakeElement('div'), storage: memoryStorage() });
    shell.start();
    assert.deepEqual(win.location.replaced, ['#/start'], hash || '(empty)');
  }
});

test('createRelayShell: relay route renders chrome + page into mount', () => {
  const mount = fakeElement('div');
  const shell = createRelayShell({ doc: fakeDoc(), win: fakeWin('#/more'), mount, storage: memoryStorage() });
  shell.registerRoute('start', () => '<p data-start>开始页占位</p>');
  shell.start();
  assert.ok(mount.innerHTML.includes('class="rv2"'), '.rv2 scope root rendered');
  assert.ok(mount.innerHTML.includes('<header class="top"'), 'top bar rendered');
  assert.ok(mount.innerHTML.includes('更多'), 'more page rendered for #/more');
  assert.ok(mount.innerHTML.includes('访客'));
  assert.notEqual(mount.style.display, 'none');
});

test('createRelayShell: lab + legacy routes hide the relay shell', () => {
  for (const hash of ['#/lab/line', '#settings', '#users', '#assistant']) {
    const mount = fakeElement('div');
    const shell = createRelayShell({ doc: fakeDoc(), win: fakeWin(hash), mount, storage: memoryStorage() });
    shell.start();
    assert.equal(mount.style.display, 'none', hash);
  }
});

test('createRelayShell: registered route renderer fills the page area', () => {
  const mount = fakeElement('div');
  const shell = createRelayShell({ doc: fakeDoc(), win: fakeWin('#/start'), mount, storage: memoryStorage() });
  shell.registerRoute('start', (ctx) => '<section id="start-page">q=' + ctx.query + '</section>');
  shell.start();
  assert.ok(mount.innerHTML.includes('id="start-page"'));
});

// ---------------------------------------------------------------------------
// relay.css — token 化 + 五种外观映射 + 作用域隔离
// ---------------------------------------------------------------------------

test('relay.css: .rv2 base block defines every SPEC §3 token with exact values', () => {
  const at = cssFlat.search(/^\.rv2\s*\{/m);
  assert.notEqual(at, -1, '.rv2 base token block exists at line start');
  const open = cssFlat.indexOf('{', at);
  let depth = 0;
  let body = '';
  for (let i = open; i < cssFlat.length; i += 1) {
    if (cssFlat[i] === '{') depth += 1;
    else if (cssFlat[i] === '}') {
      depth -= 1;
      if (depth === 0) { body = cssFlat.slice(open + 1, i); break; }
    }
  }
  const base = tokenMap(body);
  for (const [name, value] of Object.entries(SPEC_TOKENS)) {
    assert.equal(base[name], value, name + ' must equal SPEC value ' + value);
  }
  assert.equal(base['--brand-ink'], '#FFFFFF', 'prototype --brand-ink');
});

test('relay.css: all five appearances redefine the full token set', () => {
  for (const theme of APPEARANCES) {
    const tokens = themeBlock(theme);
    for (const name of THEME_REQUIRED_TOKENS) {
      assert.ok(tokens[name], theme + ' redefines ' + name);
    }
  }
});

test('relay.css: swiss/workbench drop shadows and shrink radii; designer keeps 4.5:1 text pairs', () => {
  const swiss = themeBlock('swiss');
  assert.equal(swiss['--shadow'], 'none');
  assert.notEqual(swiss['--r-lg'], SPEC_TOKENS['--r-lg'], 'swiss has its own radius scale');
  const workbench = themeBlock('workbench');
  assert.equal(workbench['--shadow'], 'none');

  const designer = themeBlock('designer');
  const pairs = [
    ['--ink', '--bg'], ['--ink', '--surface'], ['--ink2', '--surface'], ['--ink3', '--surface'],
    ['--brand-ink', '--brand'], ['--forest', '--forest-soft'], ['--warn', '--gold-soft'],
    ['--ok', '--surface'],
  ];
  for (const [fg, bg] of pairs) {
    const ratio = contrast(designer[fg], designer[bg]);
    assert.ok(ratio >= 4.5, fg + ' on ' + bg + ' = ' + ratio.toFixed(2) + ' (needs ≥4.5, SPEC §3)');
  }
  // medal text is #fff on --gold in the prototype CSS — must hold in designer too
  const goldRatio = contrast('#FFFFFF', designer['--gold']);
  assert.ok(goldRatio >= 4.5, '#fff on --gold = ' + goldRatio.toFixed(2));
});

test('relay.css: every selector is scoped under .rv2 (legacy page untouched)', () => {
  const selectors = cssSelectors();
  assert.ok(selectors.length > 20, 'stylesheet actually parsed (' + selectors.length + ' selectors)');
  for (const selector of selectors) {
    if (selector.startsWith('@')) continue; // @media wrappers
    for (const part of selector.split(',')) {
      const sel = part.trim();
      if (!sel) continue;
      assert.ok(sel.includes('.rv2'), 'selector escapes the shell scope: "' + sel + '"');
    }
  }
});

test('relay.css: tab bar is fixed; app column 720px with bottom clearance', () => {
  const tabbar = ruleBody('.tabbar');
  assert.ok(tabbar, '.tabbar base rule exists');
  assert.match(tabbar, /position:\s*fixed/);
  assert.match(tabbar, /bottom:\s*0/);
  const app = ruleBody('.app');
  assert.ok(app, '.app column exists');
  assert.match(app, /max-width:\s*720px/);
  assert.match(app, /padding[^:]*:[^;]*104px/);
});

test('relay.css: carries the cross-line component contract (home/passport markup)', () => {
  // home.js / passport.js 发原型类名 markup，样式落在本文件（L1 名下）
  for (const cls of ['.ask', '.mic', '.btn', '.seg', '.grid', '.scene', '.badge', '.empty',
    '.steps', '.kicker', '.does', '.material', '.chip', '.privacy', '.baton', '.prompt',
    '.stats', '.skill', '.hist', '.cat', '.list', '.it', '.lab']) {
    assert.ok(ruleBody(cls), 'relay.css defines ' + cls);
  }
  // 跨线辅助类：home 线的 .micnote 状态行与 .sr 视觉隐藏 label
  const sr = ruleBody('.sr');
  assert.ok(sr, '.sr helper exists');
  assert.match(sr, /clip-path:inset\(50%\)/);
  assert.ok(ruleBody('.micnote'), '.micnote helper exists');
});

test('relay.css: reduced-motion + rtl-safe logical properties (SPEC §6)', () => {
  assert.match(cssText, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.ok(cssText.includes('margin-inline-start') || cssText.includes('padding-inline'), 'logical properties for RTL');
});

test('relay.css: desktop breakpoint 900px switches tabbar → top tabs (SPEC §2)', () => {
  assert.match(cssText, /@media\s*\(min-width:\s*900px\)/);
});
