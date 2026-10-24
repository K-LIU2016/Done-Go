// web/relay/baton.js — AI 接力 v2 接力棒（SPEC §4④ 结果页 / §4⑧ 失败页，L4接力棒线）
//
// D4: the baton must exist on BOTH the result page (full card: app 选择 +
// 提示词预览 + 复制并打开 + ✓我自己做到了) and the fail page (瘦身卡: 固定
// 豆包, 复制提示词并打开). Copy pins follow design/relay-v2/prototype.html
// sections S4 (result .baton) and S8 (fail .baton) verbatim; class names
// (.baton .k .apps .app-c .prompt .cp .done-link .btn pri/dark wide) are the
// prototype's, styled by web/relay/relay.css (UI line).
//
// All data shapes come from web/relay/contracts.js (never redefined here):
// validateUsage / batonMaterialPreview (200-char preview), sanitizeRecord
// (graduated + graduatedApp), metricPayload (baton_copy:<app>,
// graduated:<app>). App list comes from web/relay/external-apps.js.
//
// Module style: pure ES module, no top-level DOM — node --test imports it
// directly; DOM entry points (copy/open/mount) take `root`/`target` via
// options, following the v1 web/ai-relay.js view()/onclick pattern.
//
// i18n (SPEC §6): copy lives in BATON_STRINGS_ZH as defaults; the i18n line's
// web/relay/i18n.js dict is passed in via options.strings and merged over it.

import { batonMaterialPreview, metricPayload, sanitizeRecord, validateUsage } from './contracts.js';
import { DEFAULT_APP_ID, EXTERNAL_APPS, externalAppIds, findExternalApp } from './external-apps.js';

// Prototype S4 shows the empty-material slot as「会议内容：……」.
export var BATON_EMPTY_MATERIAL = '……';

export var BATON_STRINGS_ZH = {
  resultKicker: '接力棒 · 下次你自己来',
  resultTitle: '在你常用的 AI 里，自己做一次',
  resultBody: '复制这段话，粘贴到下面任意一个 AI，再贴上你的会议内容。做到一次，这个用法就真正是你的了。',
  failKicker: '不想等？自己接力',
  failTitle: '把这件事带去豆包，自己做',
  failBody: '复制下面这段话，粘贴到豆包，再贴上你的会议内容。',
  moreApps: '更多',
  fewerApps: '收起',
  appsLabel: '选择外部 AI 应用',
  copy: '复制',
  copyAndOpen: '复制并打开',
  doneLink: '✓ 我自己做到了',
};

function stringsFor(options) {
  return Object.assign({}, BATON_STRINGS_ZH, (options && options.strings) || {});
}

// ---------------------------------------------------------------------------
// §4④ 提示词组装 — 用法模板 + 材料前 200 字（BATON_MATERIAL_PREVIEW_MAX via
// contracts.batonMaterialPreview). Empty material keeps the prototype's 「……」
// placeholder instead of an empty slot. Usage must pass contracts.validateUsage
// (which already guarantees the {{material}} slot exists).
// ---------------------------------------------------------------------------

export function buildBatonPrompt(usage, material) {
  var u = validateUsage(usage);
  if (!u) return null;
  var raw = String(material == null ? '' : material);
  var preview = raw.trim() ? batonMaterialPreview(raw) : BATON_EMPTY_MATERIAL;
  return u.externalPrompt.split('{{material}}').join(preview);
}

// ---------------------------------------------------------------------------
// §4④ 应用选择 — 豆包默认，海外 3 家折叠在「更多」后面。Pure state helpers:
// state is a plain { appId, expanded } object, transitions return new objects.
// ---------------------------------------------------------------------------

export function initialBatonState(options) {
  var appId = options && options.appId != null ? String(options.appId) : DEFAULT_APP_ID;
  return { appId: appId, expanded: false };
}

export function selectApp(state, appId, apps) {
  if (!findExternalApp(appId, apps || EXTERNAL_APPS)) return null;
  return { appId: String(appId), expanded: !!(state && state.expanded) };
}

export function toggleExpanded(state) {
  return {
    appId: (state && state.appId) || DEFAULT_APP_ID,
    expanded: !(state && state.expanded),
  };
}

export function partitionApps(apps) {
  var list = Array.isArray(apps) ? apps : EXTERNAL_APPS;
  var cn = [];
  var global = [];
  list.forEach(function (app) {
    if (!app) return;
    if (app.region === 'global') global.push(app);
    else cn.push(app);
  });
  return { cn: cn, global: global };
}

// ---------------------------------------------------------------------------
// §4④ 复制并打开 — 先复制，再新标签打开官方入口（顺序是 SPEC 要求，也是
// popup-blocker 现实：先拿到剪贴板权限/用户手势，再 window.open）。
// Clipboard API first, textarea+execCommand fallback (微信内置浏览器等旧
// webview)。noopener: never hand a referrer/window handle to the opened app.
// ---------------------------------------------------------------------------

export async function copyText(text, root) {
  var value = String(text == null ? '' : text);
  var r = root || (typeof window !== 'undefined' ? window : null);
  if (!r) return false;
  var nav = r.navigator;
  if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
    try { await nav.clipboard.writeText(value); return true; } catch (e) { /* fall through */ }
  }
  var doc = r.document;
  if (doc && typeof doc.createElement === 'function') {
    var ta = null;
    try {
      ta = doc.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      if (doc.body && typeof doc.body.appendChild === 'function') doc.body.appendChild(ta);
      ta.focus();
      if (typeof ta.select === 'function') ta.select();
      var ok = typeof doc.execCommand === 'function' ? doc.execCommand('copy') : false;
      if (ta.parentNode && typeof ta.parentNode.removeChild === 'function') ta.parentNode.removeChild(ta);
      else if (typeof ta.remove === 'function') ta.remove();
      return ok === true;
    } catch (e) {
      if (ta && ta.parentNode && typeof ta.parentNode.removeChild === 'function') {
        try { ta.parentNode.removeChild(ta); } catch (e2) { /* best effort */ }
      }
      return false;
    }
  }
  return false;
}

export function openExternal(url, root) {
  var r = root || (typeof window !== 'undefined' ? window : null);
  if (!r || typeof r.open !== 'function') return false;
  var opened = r.open(String(url), '_blank', 'noopener');
  return !!opened;
}

export async function copyAndOpen(appId, prompt, options) {
  options = options || {};
  var apps = options.apps || EXTERNAL_APPS;
  var app = findExternalApp(appId, apps);
  if (!app) return { app: null, copied: false, opened: false };
  var copied = await copyText(prompt, options.root); // 先复制
  var opened = openExternal(app.url, options.root);  // 再打开
  return { app: app, copied: copied, opened: opened };
}

// ---------------------------------------------------------------------------
// §4④ 「✓ 我自己做到了」毕业记录 — stamps graduated:true + graduatedApp on a
// contracts record and re-validates through sanitizeRecord. Metric payloads:
// §5.5 baton_copy:<app> / graduated:<app>, gated on the real app-id list.
// Integration recipe on graduation click: markGraduated(record, appId) → save
// via the store line → graduationMetric(appId) → navigate #/me + highlight.
// ---------------------------------------------------------------------------

export function markGraduated(record, appId, options) {
  options = options || {};
  if (!findExternalApp(appId, options.apps || EXTERNAL_APPS)) return null;
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  return sanitizeRecord(Object.assign({}, record, { graduated: true, graduatedApp: String(appId) }));
}

export function batonCopyMetric(appId, options) {
  var opts = options || {};
  return metricPayload('baton_copy', appId, { apps: externalAppIds(opts.apps) });
}

export function graduationMetric(appId, options) {
  var opts = options || {};
  return metricPayload('graduated', appId, { apps: externalAppIds(opts.apps) });
}

// ---------------------------------------------------------------------------
// Views — HTML strings (v1 ai-relay.js pattern), escaped everywhere user data
// (material preview) touches markup. Chips are <button> (SPEC §6 键盘可走完
// 全流程) carrying the prototype's .app-c classes; the prototype's <span> is
// visual only, the a11y requirement upgrades it to a pressed-toggle button.
// ---------------------------------------------------------------------------

var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) { return ESC_MAP[ch]; });
}

function appChipHtml(app, on) {
  return '<button type="button" class="app-c' + (on ? ' on' : '') + '" data-app="' + esc(app.id) + '"'
    + ' aria-pressed="' + (on ? 'true' : 'false') + '">'
    + '<i style="background:' + esc(app.color) + '" aria-hidden="true">' + esc(app.initial) + '</i>'
    + esc(app.name) + '</button>';
}

// Collapsed renders CN 5 + 「更多」; expanded renders CN 5 + global 3 + 「收起」
// (global chips are simply absent while collapsed — [hidden] would lose to the
// .app-c{display:flex} author style).
function appsRowHtml(state, apps, strings) {
  var parts = partitionApps(apps);
  var chips = '';
  parts.cn.forEach(function (app) { chips += appChipHtml(app, app.id === state.appId); });
  if (state.expanded) {
    parts.global.forEach(function (app) { chips += appChipHtml(app, app.id === state.appId); });
  }
  chips += '<button type="button" class="app-c more" data-more="1" aria-expanded="' + (state.expanded ? 'true' : 'false') + '">'
    + esc(state.expanded ? strings.fewerApps : strings.moreApps) + '</button>';
  return '<div class="apps" role="group" aria-label="' + esc(strings.appsLabel) + '">' + chips + '</div>';
}

function promptBoxHtml(promptText, strings) {
  return '<div class="prompt" style="white-space:pre-wrap">'
    + '<button type="button" class="chip cp" data-copy="1"><svg aria-hidden="true"><use href="#i-copy"/></svg>'
    + esc(strings.copy) + '</button>' + esc(promptText) + '</div>';
}

function normalizedState(state, apps) {
  var st = state && typeof state === 'object' ? state : initialBatonState();
  var appId = findExternalApp(st.appId, apps) ? st.appId : DEFAULT_APP_ID;
  return { appId: appId, expanded: st.expanded === true };
}

// §4④ 结果页接力棒卡（黑边框 .baton）。Invalid usage → '' (caller hides).
export function batonCardView(state, options) {
  options = options || {};
  var usage = validateUsage(options.usage);
  if (!usage) return '';
  var promptText = buildBatonPrompt(usage, options.material);
  if (promptText == null) return '';
  var apps = options.apps || EXTERNAL_APPS;
  var st = normalizedState(state, apps);
  var app = findExternalApp(st.appId, apps) || apps[0];
  var s = stringsFor(options);
  return '<div class="baton" data-baton="result">'
    + '<div class="k"><svg aria-hidden="true"><use href="#i-baton"/></svg>' + esc(s.resultKicker) + '</div>'
    + '<h3>' + esc(s.resultTitle) + '</h3>'
    + '<p>' + esc(s.resultBody) + '</p>'
    + appsRowHtml(st, apps, s)
    + promptBoxHtml(promptText, s)
    + '<button type="button" class="btn pri wide" style="margin-top:12px" data-open="1">'
    + esc(s.copyAndOpen) + esc(app.name) + '<svg aria-hidden="true"><use href="#i-arrow"/></svg></button>'
    + '<button type="button" class="done-link" data-graduate="1">' + esc(s.doneLink) + '</button>'
    + '</div>';
}

// §4⑧ 失败页接力棒卡 — 固定豆包，无应用选择，无 done-link（prototype S8）。
export function batonFailCardView(options) {
  options = options || {};
  var usage = validateUsage(options.usage);
  if (!usage) return '';
  var promptText = buildBatonPrompt(usage, options.material);
  if (promptText == null) return '';
  var apps = options.apps || EXTERNAL_APPS;
  var app = findExternalApp(DEFAULT_APP_ID, apps) || apps[0];
  var s = stringsFor(options);
  return '<div class="baton" data-baton="fail">'
    + '<div class="k"><svg aria-hidden="true"><use href="#i-baton"/></svg>' + esc(s.failKicker) + '</div>'
    + '<h3>' + esc(s.failTitle) + '</h3>'
    + '<p>' + esc(s.failBody) + '</p>'
    + promptBoxHtml(promptText, s)
    + '<button type="button" class="btn dark wide" style="margin-top:12px" data-open="1">'
    + esc(s.copyAndOpen) + esc(app.name) + '<svg aria-hidden="true"><use href="#i-arrow"/></svg></button>'
    + '</div>';
}

// ---------------------------------------------------------------------------
// mount — render + event delegation (target.onclick survives innerHTML
// re-renders, v1 pattern). Integration wires this into #/relay result/fail
// views and owns persistence/navigation via the callbacks:
//   onMetric(payload)  — {event:'baton_copy:<app>'} from the main button
//   onGraduate(appId)  — ✓我自己做到了 click; integration then calls
//                        markGraduated + graduationMetric + jump to #/me.
// ---------------------------------------------------------------------------

export function mountBaton(target, options) {
  if (!target) return null;
  options = options || {};
  var variant = options.variant === 'fail' ? 'fail' : 'result';
  var inputs = {
    usage: options.usage,
    material: options.material,
    apps: options.apps || EXTERNAL_APPS,
  };
  var state = initialBatonState(options);

  function currentPrompt() {
    return buildBatonPrompt(inputs.usage, inputs.material);
  }

  function render() {
    target.innerHTML = variant === 'fail'
      ? batonFailCardView(inputs)
      : batonCardView(state, inputs);
  }

  async function handleOpen() {
    var appId = variant === 'fail' ? DEFAULT_APP_ID : state.appId;
    var result = await copyAndOpen(appId, currentPrompt(), { root: options.root, apps: inputs.apps });
    if (result.app && typeof options.onMetric === 'function') {
      var payload = batonCopyMetric(appId, inputs.apps);
      if (payload) options.onMetric(payload);
    }
    return result;
  }

  async function handleClick(ev) {
    var node = ev && ev.target;
    if (!node || typeof node.hasAttribute !== 'function') return null;
    if (node.hasAttribute('data-app')) {
      var next = selectApp(state, node.getAttribute('data-app'), inputs.apps);
      if (next) { state = next; render(); }
      return null;
    }
    if (node.hasAttribute('data-more')) {
      state = toggleExpanded(state);
      render();
      return null;
    }
    if (node.hasAttribute('data-copy')) {
      await copyText(currentPrompt(), options.root);
      return null;
    }
    if (node.hasAttribute('data-open')) return handleOpen();
    if (node.hasAttribute('data-graduate')) {
      if (typeof options.onGraduate === 'function') options.onGraduate(state.appId);
      return null;
    }
    return null;
  }

  target.onclick = handleClick;
  render();
  return {
    render: render,
    update: function (next) {
      if (next && typeof next === 'object') {
        if ('usage' in next) inputs.usage = next.usage;
        if ('material' in next) inputs.material = next.material;
        if (next.apps) inputs.apps = next.apps;
      }
      render();
    },
    state: function () { return { appId: state.appId, expanded: state.expanded }; },
    unmount: function () { target.onclick = null; },
  };
}
