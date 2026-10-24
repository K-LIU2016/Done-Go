// web/social/onboarding.js — 首次 3 屏引导（S8分享引导线，PRD design/social-sync/PRD.md §5、§6）。
//
// §6：新用户首次进入的引导（3 屏）：同频是什么、会分享什么、开启。
// §5：同频默认关闭，开启前一屏讲清楚会分享什么（仅聚合特征和你选择分享的
// 事件）；可以随时关闭。—— 所以第 2 屏是白名单可视化，optIn 只能在看过
// 「会分享什么」之后（最后一屏，或完成过引导后从设置再开启）触发。
//
// 数据面（tests/unit/social-onboarding.test.mjs 逐条证明）：
// · 第 2 屏白名单可视化的一切键名/枚举 import 自 ./contracts.js
//   （FEATURES_UPLOAD_FIELDS / FORBIDDEN_UPLOAD_FIELDS / KUDOS_EVENT_KINDS /
//   KUDOS_EVENT_LABELS），本文件绝不重新定义；zh 标签是 UI copy（relay home.js
//   的 PERSONA_LABELS 同款先例）。
// · 「永远不会分享」清单覆盖 PRD 点名的五类：事项标题/材料/AI 结果/具体时间/地点。
//
// 状态机与持久化（relay web/relay/store.js 同款约定）：
// · storage 注入（options.storage || root.TangoAccountStorage || root.localStorage），
//   node --test 用 fake 驱动全部行为；键 tango-donego.social.onboarding.v1 是
//   relay 键的兄弟键（D9 账号作用域的接线归二期集成节点，见 store.js 头注先例）。
// · 读取零写入；坏 JSON / 未知键 / 越界值 → 状态作废重来（status:'corrupt'），
//   原文不动；写失败不丢内存态（state().saved=false）。
// · 落盘形状恰好 {v, step, seen, optedIn} 四键。
//
// 纯 ES module：顶层无 DOM；mount/unmount 才碰节点；node --test 直接 import。
// 「同频是什么」等三屏接进第 4 个 tab 的时机归二期集成节点（CTO 派单）。

import {
  FEATURES_UPLOAD_FIELDS, FORBIDDEN_UPLOAD_FIELDS,
  KUDOS_EVENT_KINDS, KUDOS_EVENT_LABELS,
} from './contracts.js';

export var SOCIAL_ONBOARDING_KEY = 'tango-donego.social.onboarding.v1';
export var SOCIAL_ONBOARDING_VERSION = 1;

export var ONBOARDING_STEPS = ['what', 'shares', 'enable'];

// ---------------------------------------------------------------------------
// zh 标签（UI copy；键名全部来自 contracts，绝不本地重定义枚举）。
// ---------------------------------------------------------------------------
export var SHARED_FIELD_LABELS = {
  week: '哪一周',
  kindMix: '事情类别的占比',
  rhythm: '做事时段的占比',
  usages: '用过的用法（只有编号）',
  relays: '接力次数',
  graduations: '毕业次数',
  rating: '自评三档的次数',
  freedTo: '空出来的时间去向占比',
  freedMinutesConfirmed: '确认过的空出分钟数',
};

export var FORBIDDEN_FIELD_LABELS = {
  title: '事项标题', itemTitle: '事项标题',
  note: '备注', notes: '备注',
  material: '材料', materials: '材料',
  content: '内容',
  aiResult: 'AI 结果', result: '结果',
  event: '事件原文', events: '事件原文',
  time: '具体时间', times: '具体时间',
  startTime: '开始时间', endTime: '结束时间',
  start: '开始时间', end: '结束时间',
  at: '时间点', date: '日期',
  location: '地点', place: '地点',
  schedule: '日程表',
};

// 第 2 屏的白名单可视化模型（纯函数；两次调用结果一致，无 IO）。
export function shareWhitelistView() {
  var shared = [];
  for (var i = 0; i < FEATURES_UPLOAD_FIELDS.length; i += 1) {
    var field = FEATURES_UPLOAD_FIELDS[i];
    shared.push({ field: field, label: SHARED_FIELD_LABELS[field] || field });
  }
  var sharedEvents = [];
  for (var e = 0; e < KUDOS_EVENT_KINDS.length; e += 1) {
    var kind = KUDOS_EVENT_KINDS[e];
    sharedEvents.push({ kind: kind, label: KUDOS_EVENT_LABELS[kind] });
  }
  var never = [];
  var seenLabels = [];
  for (var n = 0; n < FORBIDDEN_UPLOAD_FIELDS.length; n += 1) {
    var name = FORBIDDEN_UPLOAD_FIELDS[n];
    var label = FORBIDDEN_FIELD_LABELS[name] || name;
    never.push({ field: name, label: label });
    if (seenLabels.indexOf(label) < 0) seenLabels.push(label);
  }
  return {
    shared: shared,
    sharedEvents: sharedEvents,
    never: never,
    neverSummary: seenLabels.join('、'),
  };
}

// ---------------------------------------------------------------------------
// 文案（3 屏；zh 与 PRD §0/§5/§6 对齐）。
// ---------------------------------------------------------------------------
function sharedSummaryText() {
  var view = shareWhitelistView();
  return '每周只上传聚合数据：' + view.shared.map(function (s) { return s.label; }).join('、');
}

export var ONBOARDING_COPY = {
  what: {
    kicker: '同频 · 1/3',
    title: '同频是什么',
    body: '你学会的 AI 用法可以传给同频的人：对方学会了，你就传棒成功。每周根据你怎么用 AI、怎么分配空出来的时间，给出你的时间流派，找到同频的人。',
    bullets: [
      '时间流派：每周一种，附三条来自真实数据的证据',
      '接力搭档与同频圈：一起把用法传下去',
      '身份是化名 + 头像色，不显示真实姓名或邮箱',
    ],
    primary: '下一屏',
    secondary: '暂不开启',
  },
  shares: {
    kicker: '同频 · 2/3',
    title: '会分享什么',
    body: '同频默认不分享。开启后，也只上传聚合数据，看不出你做了哪一件事：',
    bullets: [
      sharedSummaryText(),
      '你选择分享的事件：学会了一个用法、自己做到了、把空出来的时间给了人 —— 只在你确认后出现',
      '永远不会上传：事项标题、材料、AI 结果、具体时间、地点',
    ],
    primary: '下一屏',
    secondary: '暂不开启',
  },
  enable: {
    kicker: '同频 · 3/3',
    title: '开启同频',
    body: '开启后才会进入同频池，收到每周 3 位同频推荐。不开启也能正常用探戈的全部功能。',
    bullets: [
      '随时可以关闭，并删除服务端数据（24 小时内完成）',
      '化名可以修改；可以屏蔽、举报、退出圈',
      '未满 18 岁只进入有邀请码的圈，不进公开同频池',
    ],
    primary: '开启同频',
    secondary: '暂不开启',
  },
};

// ---------------------------------------------------------------------------
// 状态：{v, step, seen, optedIn}，恰好四键。
// ---------------------------------------------------------------------------
export function sanitizeOnboardingState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  var keys = Object.keys(raw);
  var allowed = ['v', 'step', 'seen', 'optedIn'];
  if (keys.length !== allowed.length || allowed.some(function (k) { return keys.indexOf(k) < 0; })) return null;
  if (raw.v !== SOCIAL_ONBOARDING_VERSION) return null;
  if (typeof raw.step !== 'number' || !Number.isInteger(raw.step) || raw.step < 0 || raw.step >= ONBOARDING_STEPS.length) return null;
  if (typeof raw.seen !== 'boolean' || typeof raw.optedIn !== 'boolean') return null;
  return { v: raw.v, step: raw.step, seen: raw.seen, optedIn: raw.optedIn };
}

function freshState() {
  return { v: SOCIAL_ONBOARDING_VERSION, step: 0, seen: false, optedIn: false };
}

// ---------------------------------------------------------------------------
// 视图模型（纯函数）：当前屏的完整文案 + 进度。
// ---------------------------------------------------------------------------
export function onboardingView(state) {
  if (!state || typeof state !== 'object') return null;
  var step = state.step;
  if (typeof step !== 'number' || step < 0 || step >= ONBOARDING_STEPS.length) return null;
  var copy = ONBOARDING_COPY[ONBOARDING_STEPS[step]];
  return {
    step: step,
    stepId: ONBOARDING_STEPS[step],
    kicker: copy.kicker,
    title: copy.title,
    body: copy.body,
    bullets: copy.bullets.slice(),
    primary: copy.primary,
    secondary: copy.secondary,
  };
}

// ---------------------------------------------------------------------------
// Controller — storage 注入（relay store 同款链），读不写，写失败不丢内存。
// ---------------------------------------------------------------------------
function storageAt(root, name) {
  try { return root ? root[name] : null; } catch (e) { return null; }
}

function pickStorage(options) {
  options = options || {};
  if (options.storage !== undefined) return options.storage; // 显式注入（含 null = 无存储）
  var root = options.root || (typeof globalThis !== 'undefined' ? globalThis : null);
  return storageAt(root, 'TangoAccountStorage') || storageAt(root, 'localStorage') || null;
}

export function createOnboarding(options) {
  options = options || {};
  var storage = pickStorage(options);
  var callbacks = {
    onOptIn: typeof options.onOptIn === 'function' ? options.onOptIn : null,
    onOptOut: typeof options.onOptOut === 'function' ? options.onOptOut : null,
    onDone: typeof options.onDone === 'function' ? options.onDone : null,
  };

  var status = 'empty';
  var state = freshState();
  var saved = true;

  if (storage) {
    var raw = null;
    try { raw = storage.getItem(SOCIAL_ONBOARDING_KEY); } catch (e) { raw = null; }
    if (raw != null) {
      var parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
      var clean = sanitizeOnboardingState(parsed);
      if (clean) {
        state = clean;
        status = 'ok';
      } else {
        status = 'corrupt'; // 原文保留，读取零写入；状态作废重来
      }
    }
  } else {
    status = 'memory';
  }

  function persist() {
    if (!storage) { saved = false; return; }
    try {
      storage.setItem(SOCIAL_ONBOARDING_KEY, JSON.stringify(state));
      saved = true;
    } catch (e) {
      saved = false; // 内存态保留，调用方通过 state().saved 感知
    }
  }

  function publicState() {
    var last = ONBOARDING_STEPS.length - 1;
    return {
      step: state.step,
      stepId: ONBOARDING_STEPS[state.step],
      totalSteps: ONBOARDING_STEPS.length,
      firstVisit: !state.seen,
      seen: state.seen,
      optedIn: state.optedIn,
      canOptIn: state.step === last || state.seen,
      saved: saved,
    };
  }

  function emit(name) {
    if (callbacks[name]) callbacks[name](publicState());
  }

  var api = {
    status: status,
    state: publicState,
    view: function () { return onboardingView({ step: state.step, seen: state.seen, optedIn: state.optedIn }); },
    next: function () {
      if (state.step >= ONBOARDING_STEPS.length - 1) return false;
      state.step += 1;
      persist();
      render();
      return true;
    },
    back: function () {
      if (state.step <= 0) return false;
      state.step -= 1;
      persist();
      render();
      return true;
    },
    complete: function () {
      if (state.seen) return false;
      state.seen = true;
      persist();
      render();
      emit('onDone');
      return true;
    },
    optIn: function () {
      var last = ONBOARDING_STEPS.length - 1;
      if (state.step !== last && !state.seen) return false; // 没看过「会分享什么」就开不了
      if (state.optedIn) return false;
      state.optedIn = true;
      state.seen = true;
      persist();
      render();
      emit('onOptIn');
      return true;
    },
    optOut: function () {
      if (!state.optedIn) return false;
      state.optedIn = false;
      persist();
      render();
      emit('onOptOut');
      return true;
    },
    reset: function () {
      var next = freshState();
      if (next.step === state.step && next.seen === state.seen && next.optedIn === state.optedIn) return false;
      state = next;
      persist();
      render();
      return true;
    },
  };

  // -----------------------------------------------------------------------
  // DOM 薄层 — mount/unmount 才碰节点；类名 soc-onb-*，样式用 relay-v2
  // SPEC §3 同名 CSS 变量（带 fallback，未接入 shell 也能独立成屏）。
  // -----------------------------------------------------------------------
  var host = null;

  function esc(value) {
    return String(value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function cardHtml() {
    var view = api.view();
    if (!view) return '';
    var dots = '';
    for (var i = 0; i < ONBOARDING_STEPS.length; i += 1) {
      dots += '<i class="soc-onb-dot' + (i === view.step ? ' on' : '') + '"></i>';
    }
    var bullets = '';
    for (var b = 0; b < view.bullets.length; b += 1) {
      bullets += '<li>' + esc(view.bullets[b]) + '</li>';
    }
    return ''
      + '<div class="soc-onb-card" id="soc-onb-card">'
      + '<p class="soc-onb-kicker">' + esc(view.kicker) + '</p>'
      + '<h2 class="soc-onb-title">' + esc(view.title) + '</h2>'
      + '<p class="soc-onb-body">' + esc(view.body) + '</p>'
      + '<ul class="soc-onb-list">' + bullets + '</ul>'
      + '<div class="soc-onb-dots">' + dots + '</div>'
      + '<div class="soc-onb-actions">'
      + '<button type="button" class="soc-onb-btn pri" id="soc-onb-primary">' + esc(view.primary) + '</button>'
      + '<button type="button" class="soc-onb-btn ghost" id="soc-onb-secondary">' + esc(view.secondary) + '</button>'
      + '</div>'
      + '</div>';
  }

  function render() {
    if (!host) return;
    host.innerHTML = '<div class="soc-onb-overlay">' + cardHtml() + '</div>';
  }

  // 事件委托：mount 只在宿主上挂一个 click（relay home 同款接线方式，
  // 重渲染不重复挂 handler —— 测试 stub 的按 id 缓存节点因此无累积问题）。
  function onHostClick(event) {
    if (!host) return;
    var target = event && event.target;
    var id = target && target.id;
    if (id === 'soc-onb-primary') {
      var view = api.view();
      if (view && view.stepId === 'enable') api.optIn();
      else api.next();
    } else if (id === 'soc-onb-secondary') {
      api.complete();
    }
  }

  api.mount = function (el) {
    if (!el || typeof el.addEventListener !== 'function') return false;
    host = el;
    host.addEventListener('click', onHostClick);
    render();
    return true;
  };
  api.unmount = function () {
    if (host && typeof host.removeEventListener === 'function') {
      try { host.removeEventListener('click', onHostClick); } catch (e) { /* stub 无此方法时忽略 */ }
    }
    if (host) {
      try { host.innerHTML = ''; } catch (e) { /* 非 DOM 宿主静默 */ }
    }
    host = null;
  };

  return api;
}
