// web/social/baton.js — 同频（社交游戏化）S6传棒线（PRD design/social-sync/PRD.md §4.4、§4.8，红线 D6）
//
// 交付：传棒弹层（发搭档/发圈/复制链接三途）、用法卡（只含 usageId+场景标题+
// 提示词模板）、传递链展示（最多 5 跳）、接收方打开即试用（访客可用）。
//
// 数据形状一律来自 web/social/contracts.js（绝不在此重定义）：
// validateBatonCard / BATON_CARD_FIELDS（D6 三字段白名单）、validateBatonShare /
// BATON_TARGET_KINDS（pair/circle/link）、validateBatonEvent / BATON_EVENTS
// （sent/opened/relay-completed/graduated）、clipBatonChain / BATON_CHAIN_MAX_HOPS
// （传递链最多展示 5 跳，保留最后 5 跳）。
//
// 只读 import（允许、绝不修改）：web/relay/contracts.js 的 validateUsage
// （场景库用法校验：天然剥离未知字段 → 私人内容进不了卡）与
// batonMaterialPreview（接收方材料前 200 字封顶，relay §4④ 同规）；
// web/relay/baton.js 的 copyText（已测过的剪贴板实现，Clipboard API +
// execCommand 兜底）。
//
// 隐私硬规则（D2/D6，unit 逐条证明）：
// - 卡只从【场景库用法】构建（buildBatonCard 先过 relay validateUsage），
//   用户做完的事项记录、材料、时间、地点、AI 结果一律建不出卡（null）。
// - 链接只含路由 + batonId（batonLinkHref），标题/模板/任何个人内容不上链接。
// - 接收方材料只进本机提示词（buildTryPrompt），不进任何卡或链接。
//
// 模块风格与 web/relay/baton.js 同：纯 ES module、无顶层 DOM，node --test 直接
// import；视图是 HTML 字符串（用户数据一律 esc），mount 用 v1 view()/onclick
// 委托模式；i18n 走 BATON_UI_STRINGS_ZH 默认 + options.strings 覆盖。
// 原型类名（.scrim/.sheet/.usecard/.chain/.pick/.pk/.note/.big）钉死自
// design/social-sync/prototype.html ②，并带内联兜底样式（social 样式表落地前
// 单文件可用）。

import {
  BATON_CHAIN_MAX_HOPS, BATON_TARGET_KINDS, STYLES,
  clipBatonChain, isAvatarColor, validateAlias,
  validateBatonCard, validateBatonEvent, validateBatonShare,
} from './contracts.js';
import { batonMaterialPreview, validateUsage } from '../relay/contracts.js';
import { copyText } from '../relay/baton.js';

// 接收方没贴材料时，提示词里的占位（relay §4④「……」同款）。
export var BATON_TRY_EMPTY_MATERIAL = '……';

export var BATON_UI_STRINGS_ZH = {
  // 发送弹层（原型②文案钉死）
  sheetTitle: '把这个用法传下去',
  cardKicker: 'AI 用法 · 接力棒',
  toLabel: '传给',
  linkPick: '生成链接',
  privacyNote: '🔒 对方只看到用法和提示词。TA 学会后，你的传棒 +1。',
  sendToPattern: '传给 {name}',
  copyLinkButton: '复制链接，发给任何人',
  // 传递链（PRD §4.4「这个用法经过了 N 个人」/ 原型②「已经过 2 个人，下一棒交给谁？」）
  chainPassed: '这个用法经过了 {n} 个人',
  chainFirstPassed: '新用法，这一棒从你开始',
  chainQuestion: '已经过 {n} 个人，下一棒交给谁？',
  chainFirstQuestion: '第一棒交给谁？',
  nextSlotLabel: '?',
  youSlotLabel: '你',
  // 接收方（PRD §4.8 打开即试用，访客可用，试完再引导注册）
  receiverKicker: '接力棒 · 来自同频',
  receiverTitle: '有人传给你一个用法',
  tryLabel: '现在就试这个用法',
  materialLabel: '把你的内容贴进来',
  materialHint: '只在你自己手里，不会发给任何人。',
  tryButton: '复制提示词，去试一次',
  guestNote: '不登录也能试（访客可用）',
  copiedLine: '已复制 ✓ 打开豆包、DeepSeek 等任意 AI，粘贴就能试',
  doneLink: '✓ 我完成接力了',
  registerCta: '试好了？登录后保存你学会的用法',
};

// options 可整包传 strings 字典（sendButtonLabel(state, targets, {copyLinkButton})），
// 也可传 {strings:{...}}（视图 options）——两种写法都允许覆盖。
function stringsFor(options) {
  var merged = Object.assign({}, BATON_UI_STRINGS_ZH, options && typeof options === 'object' ? options : {});
  if (options && options.strings && typeof options.strings === 'object') {
    Object.assign(merged, options.strings);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// D6 用法卡 — 只能从【场景库用法】建卡。relay validateUsage 先把对象净化成
// 已知字段的拷贝（私人字段在源头就被剥离），再抽取三字段，最后过 social
// contracts.validateBatonCard 白名单（未知字段拒绝，不是静默剥离）。
// 用户事项记录（event/material/doneAt…）过不了 validateUsage → null。
// ---------------------------------------------------------------------------

export function buildBatonCard(usage) {
  var u = validateUsage(usage);
  if (!u) return null;
  return validateBatonCard({
    usageId: u.id,
    scenarioTitle: u.title,
    promptTemplate: u.externalPrompt,
  });
}

function cardFrom(input) {
  if (!input || typeof input !== 'object') return null;
  if (input.usage != null) return buildBatonCard(input.usage);
  return validateBatonCard(input.card);
}

// ---------------------------------------------------------------------------
// baton share — 发搭档 / 发圈 / 复制链接 三途（BATON_TARGET_KINDS）。
// link 无直接接收者（targetId=null）；私信不是传棒目标（PRD §9 不做私信）。
// ---------------------------------------------------------------------------

export function buildBatonShare(input) {
  if (!input || typeof input !== 'object') return null;
  var card = cardFrom(input);
  if (!card) return null;
  return validateBatonShare({
    id: input.id,
    usageId: card.usageId,
    fromAccount: input.fromAccount,
    targetKind: input.targetKind,
    targetId: input.targetKind === 'link' ? null : input.targetId,
    card: card,
  });
}

// ---------------------------------------------------------------------------
// id 生成 — 契约 accountId 形状（非空 ≤64）。优先 webcrypto，退化 Math.random。
// 不带业务语义：id 只是句柄，永不编码任何内容。
// ---------------------------------------------------------------------------

function randomBase36(length, root) {
  var scope = root || (typeof globalThis !== 'undefined' ? globalThis : null);
  var cryptoObj = scope && scope.crypto;
  var out = '';
  while (out.length < length) {
    if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
      var buf = new Uint8Array(length);
      cryptoObj.getRandomValues(buf);
      for (var i = 0; i < buf.length && out.length < length; i += 1) {
        out += (buf[i] % 36).toString(36);
      }
    } else {
      out += Math.floor(Math.random() * 1e9).toString(36);
    }
  }
  return out.slice(0, length);
}

export function newBatonId(root) {
  return 'b' + randomBase36(16, root);
}

function newEventId(root) {
  return 'e' + randomBase36(16, root);
}

// ---------------------------------------------------------------------------
// baton_events（D6 四枚举）。id/at 可注入（测试确定性）；缺省用当前时间。
// 枚举外 kind、空 batonId/byAccount 都被 validateBatonEvent 拒绝（null）。
// ---------------------------------------------------------------------------

export function batonEvent(kind, batonId, byAccount, options) {
  options = options || {};
  return validateBatonEvent({
    id: options.id || newEventId(options.root),
    batonId: typeof batonId === 'string' ? batonId : '',
    kind: kind,
    at: options.at || new Date().toISOString(),
    byAccount: typeof byAccount === 'string' ? byAccount : '',
  });
}

// ---------------------------------------------------------------------------
// 传递链（D6 最多展示 5 跳）。裁剪一律走 contracts.clipBatonChain（保留最后
// 5 跳）；这里只做展示模型：条目可以是化名字符串或 {alias, avatarColor}，
// 无色条目按别名哈希落到 6 流派色板（确定性、可测）。
// ---------------------------------------------------------------------------

function aliasOf(entry) {
  if (typeof entry === 'string') {
    var t = entry.trim();
    return t || null;
  }
  if (entry && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.alias === 'string') {
    var a = entry.alias.trim();
    return a || null;
  }
  return null;
}

function colorOf(entry, alias) {
  if (entry && typeof entry === 'object' && isAvatarColor(entry.avatarColor)) {
    return entry.avatarColor.toUpperCase();
  }
  var hash = 0;
  for (var i = 0; i < alias.length; i += 1) hash = ((hash * 31) + alias.charCodeAt(i)) >>> 0;
  return STYLES[hash % STYLES.length].color.toUpperCase();
}

export function chainViewModel(chain, options) {
  var s = stringsFor(options);
  var entries = Array.isArray(chain) ? chain : [];
  var colors = {};
  var aliases = [];
  entries.forEach(function (entry) {
    var alias = aliasOf(entry);
    if (!alias) return;
    if (!(alias in colors)) colors[alias] = colorOf(entry, alias);
    aliases.push(alias);
  });
  var total = aliases.length;
  var shown = clipBatonChain(aliases); // contracts：白名单字符串、保留最后 5 跳
  var hops = shown.map(function (alias) {
    return { alias: alias, initial: alias.slice(0, 1), avatarColor: colors[alias] };
  });
  return {
    hops: hops,
    total: total,
    overLimit: total > BATON_CHAIN_MAX_HOPS,
    droppedFromStart: total - hops.length,
    summaryText: total === 0 ? s.chainFirstPassed : s.chainPassed.replace('{n}', String(total)),
    questionText: total === 0 ? s.chainFirstQuestion : s.chainQuestion.replace('{n}', String(total)),
  };
}

// ---------------------------------------------------------------------------
// 链接（§4.8 访客打开）— 只含路由 + batonId。标题、模板、化名、任何个人
// 内容都不编码进 URL；接收方拿 id 向服务端取卡（服务线职责）。
// ---------------------------------------------------------------------------

var BATON_ID_SAFE_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function batonLinkHref(batonId, options) {
  if (typeof batonId !== 'string' || !BATON_ID_SAFE_RE.test(batonId)) return null;
  var base = options && typeof options.base === 'string' ? options.base.replace(/\/+$/, '') : '';
  return (base ? base + '/' : '') + '#/social/baton/' + batonId;
}

// ---------------------------------------------------------------------------
// 发送弹层状态机 — 纯函数。{targetId, linkMode}：选人与生成链接互斥；
// 只认传入目标清单里的 id；没有搭档/圈时链接是唯一途（冷启动不造假人，D4）。
// ---------------------------------------------------------------------------

function validTargets(targets) {
  if (!Array.isArray(targets)) return [];
  return targets
    .filter(function (t) {
      return !!t && typeof t === 'object'
        && typeof t.id === 'string' && t.id.trim().length > 0 && t.id.length <= 64
        && BATON_TARGET_KINDS.indexOf(t.kind) >= 0 && t.kind !== 'link'; // 三途中 pair/circle 可选人
    })
    .map(function (t) {
      var alias = validateAlias(t.alias);
      return {
        id: t.id,
        kind: t.kind,
        alias: alias || String(t.alias || '').slice(0, 24),
        avatarColor: colorOf({ avatarColor: t.avatarColor }, alias || String(t.alias || 'x')),
      };
    })
    .filter(function (t) { return !!validateAlias(t.alias); });
}

export function initialSendState(targets) {
  var list = validTargets(targets);
  if (!list.length) return { targetId: null, linkMode: true };
  return { targetId: list[0].id, linkMode: false };
}

export function selectSendTarget(state, targetId, targets) {
  var found = validTargets(targets).filter(function (t) { return t.id === targetId; });
  if (!found.length) return null;
  return { targetId: targetId, linkMode: false };
}

export function selectSendLink(_state) {
  return { targetId: null, linkMode: true };
}

export function sendButtonLabel(state, targets, options) {
  var s = stringsFor(options);
  var st = state && typeof state === 'object' ? state : initialSendState(targets);
  if (st.linkMode || !st.targetId) return s.copyLinkButton;
  var found = validTargets(targets).filter(function (t) { return t.id === st.targetId; });
  if (!found.length) return s.copyLinkButton;
  return s.sendToPattern.replace('{name}', found[0].alias);
}

// ---------------------------------------------------------------------------
// 视图 — HTML 字符串（v1 模式），用户数据（标题/模板/化名）一律 esc。
// 类名钉原型②；内联样式兜底（social 样式表落地前单文件可用）。
// ---------------------------------------------------------------------------

var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) { return ESC_MAP[ch]; });
}

function avatarSpan(label, color, size, ring) {
  var dim = size || 24;
  var style = 'width:' + dim + 'px;height:' + dim + 'px;border-radius:50%;display:inline-grid;place-items:center;'
    + 'color:#fff;font-weight:700;font-size:' + Math.max(9, Math.round(dim * 0.42)) + 'px;'
    + 'background:' + esc(color) + ';flex:none';
  if (ring) style += ';box-shadow:0 0 0 3px #fff,0 0 0 5px #E95432';
  return '<span class="av" aria-hidden="true" style="' + style + '">' + esc(label) + '</span>';
}

function chainRowHtml(vm, options) {
  options = options || {};
  var parts = '';
  vm.hops.forEach(function (hop) {
    if (parts) parts += '<span class="arr" aria-hidden="true" style="color:#8E9086">→</span>';
    // title 带全名（转义）：圆点头像无文字，靠它可读也可测。
    parts += '<span class="hop" title="' + esc(hop.alias) + '">' + avatarSpan(hop.initial, hop.avatarColor, 24) + '</span>';
  });
  var tail = options.tailLabel;
  if (tail) {
    if (parts) parts += '<span class="arr" aria-hidden="true" style="color:#8E9086">→</span>';
    parts += avatarSpan(String(tail).slice(0, 1), options.tailColor || '#8E9086', 24);
  }
  var text = options.useSummary ? vm.summaryText : vm.questionText;
  return '<div class="chain" style="display:flex;align-items:center;gap:6px;margin-top:10px;font-size:12px;'
    + 'color:#64665D;flex-wrap:wrap">' + parts + '<span>' + esc(text) + '</span></div>';
}

function usecardHtml(card, chainRow, s) {
  return '<div class="usecard" style="margin-top:12px;border:2px solid #252722;border-radius:18px;padding:14px;'
    + 'background:linear-gradient(180deg,#fff,#FFF9F2)">'
    + '<div class="k" style="font-size:11.5px;font-weight:700;color:#E95432;letter-spacing:.6px">' + esc(s.cardKicker) + '</div>'
    + '<h3 style="font-size:18px;margin:4px 0">' + esc(card.scenarioTitle) + '</h3>'
    + '<p style="font-size:12.5px;color:#64665D;line-height:1.55;white-space:pre-wrap;max-height:120px;overflow:auto">'
    + esc(card.promptTemplate) + '</p>'
    + (chainRow || '')
    + '</div>';
}

function pickChipHtml(target, on) {
  return '<button type="button" class="pk' + (on ? ' on' : '') + '" data-target="' + esc(target.id) + '"'
    + ' aria-pressed="' + (on ? 'true' : 'false') + '"'
    + ' style="display:flex;flex-direction:column;align-items:center;gap:4px;font-size:11.5px;color:#64665D;'
    + 'border:0;background:none;padding:0;cursor:pointer">'
    + avatarSpan(target.alias.slice(0, 1), target.avatarColor, 48, on)
    + '<span>' + esc(target.alias) + '</span></button>';
}

function linkChipHtml(on, s) {
  return '<button type="button" class="pk link' + (on ? ' on' : '') + '" data-link="1"'
    + ' aria-pressed="' + (on ? 'true' : 'false') + '"'
    + ' style="display:flex;flex-direction:column;align-items:center;gap:4px;font-size:11.5px;color:#64665D;'
    + 'border:0;background:none;padding:0;cursor:pointer">'
    + avatarSpan('+', '#F3F0E8', 48, on).replace('color:#fff', 'color:#64665D')
    + '<span>' + esc(s.linkPick) + '</span></button>';
}

// 发送弹层（原型②）：非法卡 → ''（调用方隐藏）。
export function sendSheetView(state, options) {
  options = options || {};
  var card = validateBatonCard(options.card);
  if (!card) return '';
  var s = stringsFor(options);
  var st = state && typeof state === 'object' ? state : initialSendState(options.targets);
  var targets = validTargets(options.targets);
  var vm = chainViewModel(options.chain, options);

  var chips = '';
  targets.forEach(function (t) {
    chips += pickChipHtml(t, !st.linkMode && st.targetId === t.id);
  });
  chips += linkChipHtml(st.linkMode, s);

  return '<div class="scrim" data-close="1" style="position:fixed;inset:0;background:rgba(37,39,34,.4)"></div>'
    + '<div class="sheet" data-baton-sheet="1" role="dialog" aria-modal="true" aria-label="' + esc(s.sheetTitle) + '"'
    + ' style="position:fixed;left:0;right:0;bottom:0;background:#fff;border-radius:28px 28px 0 0;'
    + 'padding:14px 20px 26px;max-width:560px;margin:0 auto;z-index:30">'
    + '<div class="grab" aria-hidden="true" style="width:40px;height:5px;border-radius:3px;background:#E4E2D8;margin:0 auto 14px"></div>'
    + '<h2 style="font-size:20px">' + esc(s.sheetTitle) + '</h2>'
    + usecardHtml(card, chainRowHtml(vm, { strings: s, tailLabel: s.nextSlotLabel, tailColor: '#F3F0E8' }), s)
    + '<p class="to" style="margin-top:14px;font-size:13px;font-weight:600">' + esc(s.toLabel) + '</p>'
    + '<div class="pick" role="group" aria-label="' + esc(s.toLabel) + '"'
    + ' style="display:flex;gap:10px;margin-top:8px;overflow-x:auto;padding:2px">' + chips + '</div>'
    + '<p class="note" style="margin-top:12px;font-size:12px;color:#8E9086">' + esc(s.privacyNote) + '</p>'
    + '<button type="button" class="big" data-send="1" style="margin-top:14px;width:100%;height:52px;'
    + 'border-radius:16px;background:#E95432;color:#fff;font-weight:700;font-size:16px;border:0;cursor:pointer">'
    + esc(sendButtonLabel(st, targets, options)) + '</button>'
    + '</div>';
}

// ---------------------------------------------------------------------------
// 接收方（§4.8）— 打开链接即试用，访客可用。材料只进本机提示词；
// 注册引导只在试过之后出现（copied 状态）。
// ---------------------------------------------------------------------------

export function buildTryPrompt(card, material) {
  var c = validateBatonCard(card);
  if (!c) return null;
  var raw = String(material == null ? '' : material);
  var preview = raw.trim() ? batonMaterialPreview(raw) : BATON_TRY_EMPTY_MATERIAL;
  return c.promptTemplate.indexOf('{{material}}') >= 0
    ? c.promptTemplate.split('{{material}}').join(preview)
    : c.promptTemplate + '\n\n' + preview;
}

// 接收方视图：非法卡 → ''。material 用于复制后重渲时保留输入。
export function receiverCardView(card, options) {
  options = options || {};
  var c = validateBatonCard(card);
  if (!c) return '';
  var s = stringsFor(options);
  var vm = chainViewModel(options.chain, options);
  var material = typeof options.material === 'string' ? options.material : '';

  var afterTry = '';
  if (options.copied) {
    afterTry = '<p style="margin-top:10px;font-size:12.5px;color:#335D4B">' + esc(s.copiedLine) + '</p>'
      + '<button type="button" data-relay-done="1" style="margin-top:8px;border:0;background:none;padding:0;'
      + 'font-size:13px;font-weight:600;color:#E95432;cursor:pointer;text-decoration:underline">' + esc(s.doneLink) + '</button>'
      + '<button type="button" data-register="1" style="display:block;margin-top:8px;border:0;background:none;'
      + 'padding:0;font-size:12.5px;color:#64665D;cursor:pointer;text-decoration:underline">' + esc(s.registerCta) + '</button>';
  }

  return '<div class="baton-receive" data-baton-receive="1"'
    + ' style="max-width:560px;margin:0 auto;padding:16px 4px 32px">'
    + '<div class="k" style="font-size:11.5px;font-weight:700;color:#E95432;letter-spacing:.6px">' + esc(s.receiverKicker) + '</div>'
    + '<h2 style="font-size:20px;margin:4px 0 0">' + esc(s.receiverTitle) + '</h2>'
    + usecardHtml(c, chainRowHtml(vm, { strings: s, tailLabel: s.youSlotLabel, useSummary: true }), s)
    + '<div class="try" style="margin-top:14px">'
    + '<p style="font-size:14px;font-weight:600">' + esc(s.tryLabel) + '</p>'
    + '<textarea data-material="1" rows="4" aria-label="' + esc(s.materialLabel) + '" placeholder="' + esc(s.materialLabel) + '"'
    + ' style="margin-top:8px;width:100%;box-sizing:border-box;border:1px solid #E4E2D8;border-radius:12px;'
    + 'padding:10px 12px;font-size:14px;font-family:inherit;resize:vertical">' + esc(material) + '</textarea>'
    + '<p style="margin-top:6px;font-size:12px;color:#8E9086">' + esc(s.materialHint) + '</p>'
    + '<button type="button" data-try-copy="1" style="margin-top:10px;width:100%;height:48px;border-radius:14px;'
    + 'background:#252722;color:#fff;font-weight:700;font-size:15px;border:0;cursor:pointer">' + esc(s.tryButton) + '</button>'
    + '<p style="margin-top:8px;font-size:12px;color:#8E9086">' + esc(s.guestNote) + '</p>'
    + afterTry
    + '</div>'
    + '</div>';
}

// ---------------------------------------------------------------------------
// mount — 渲染 + onclick 委托（v1 模式）。集成方（第二期挂 serve-tango/
// social tab）通过回调接服务端：onSend(out)（out.share 过契约、out.event
// 是 sent 事件、link 模式多 out.link={href,copied}）、onEvent(ev)、
// onClose、onOpened/onRelayComplete/onRegister。
// ---------------------------------------------------------------------------

export function mountSendSheet(target, options) {
  if (!target) return null;
  options = options || {};
  var inputs = {
    usage: options.usage,
    card: options.card,
    fromAccount: options.fromAccount,
    chain: options.chain,
    targets: options.targets,
    batonId: options.batonId,
    strings: options.strings,
    root: options.root,
  };
  var state = initialSendState(inputs.targets);

  function cardNow() {
    return inputs.card != null ? validateBatonCard(inputs.card) : buildBatonCard(inputs.usage);
  }

  function render() {
    var card = cardNow();
    target.innerHTML = card
      ? sendSheetView(state, { card: card, chain: inputs.chain, targets: inputs.targets, strings: inputs.strings })
      : '';
  }

  async function handleSend() {
    var card = cardNow();
    if (!card) return null;
    var shareId = inputs.batonId && BATON_ID_SAFE_RE.test(inputs.batonId) ? inputs.batonId : newBatonId(inputs.root);
    var out = { share: null, event: null, link: null };
    if (state.linkMode) {
      out.share = buildBatonShare({ id: shareId, fromAccount: inputs.fromAccount, card: card, targetKind: 'link' });
      var href = batonLinkHref(shareId);
      var copied = await copyText(href, inputs.root);
      out.link = { href: href, copied: copied };
    } else {
      var found = validTargets(inputs.targets).filter(function (t) { return t.id === state.targetId; });
      if (!found.length) return null;
      out.share = buildBatonShare({
        id: shareId, fromAccount: inputs.fromAccount, card: card,
        targetKind: found[0].kind, targetId: found[0].id,
      });
    }
    if (!out.share) return null;
    out.event = batonEvent('sent', shareId, inputs.fromAccount, { root: inputs.root });
    if (typeof options.onSend === 'function') options.onSend(out);
    if (out.event && typeof options.onEvent === 'function') options.onEvent(out.event);
    return out;
  }

  target.onclick = async function (ev) {
    var node = ev && ev.target;
    if (!node || typeof node.hasAttribute !== 'function') return null;
    if (node.hasAttribute('data-close')) {
      if (typeof options.onClose === 'function') options.onClose();
      return null;
    }
    if (node.hasAttribute('data-target')) {
      var next = selectSendTarget(state, node.getAttribute('data-target'), inputs.targets);
      if (next) { state = next; render(); }
      return null;
    }
    if (node.hasAttribute('data-link')) {
      state = selectSendLink(state);
      render();
      return null;
    }
    if (node.hasAttribute('data-send')) return handleSend();
    return null;
  };
  render();
  return {
    render: render,
    update: function (next) {
      if (next && typeof next === 'object') {
        if ('usage' in next) { inputs.usage = next.usage; inputs.card = null; }
        if ('card' in next) inputs.card = next.card;
        if ('chain' in next) inputs.chain = next.chain;
        if ('targets' in next) { inputs.targets = next.targets; state = initialSendState(inputs.targets); }
      }
      render();
    },
    state: function () { return { targetId: state.targetId, linkMode: state.linkMode }; },
    unmount: function () { target.onclick = null; },
  };
}

// 接收方挂载：打开即 opened（需要 batonId+viewerAccount 才发事件——访客由
// 集成方发匿名访客 id；没有 id 就不造假事件）。材料在点击时从 DOM 读，
// 重渲后回填 value。relay-completed 只发一次。
export function mountReceiver(target, options) {
  if (!target) return null;
  options = options || {};
  var inputs = {
    card: options.card,
    chain: options.chain,
    batonId: options.batonId,
    viewerAccount: options.viewerAccount,
    strings: options.strings,
    root: options.root,
  };
  var state = { opened: false, copied: false, completed: false };
  var material = typeof options.material === 'string' ? options.material : '';

  function render() {
    target.innerHTML = receiverCardView(inputs.card, {
      chain: inputs.chain,
      strings: inputs.strings,
      material: material,
      copied: state.copied,
    });
  }

  function fireOpened() {
    if (state.opened) return;
    state.opened = true;
    if (typeof options.onOpened !== 'function') return;
    var ev = (BATON_ID_SAFE_RE.test(inputs.batonId || '') && inputs.viewerAccount)
      ? batonEvent('opened', inputs.batonId, inputs.viewerAccount, { root: inputs.root })
      : null;
    if (ev) options.onOpened(ev);
  }

  function readMaterial() {
    if (typeof target.querySelector !== 'function') return material;
    var node = target.querySelector('[data-material]');
    if (node && typeof node.value === 'string') material = node.value;
    return material;
  }

  target.onclick = async function (ev) {
    var node = ev && ev.target;
    if (!node || typeof node.hasAttribute !== 'function') return null;
    if (node.hasAttribute('data-try-copy')) {
      var prompt = buildTryPrompt(inputs.card, readMaterial());
      if (prompt != null) {
        await copyText(prompt, inputs.root);
        state.copied = true;
        render();
      }
      return null;
    }
    if (node.hasAttribute('data-relay-done')) {
      if (state.completed) return null;
      state.completed = true;
      if (typeof options.onRelayComplete === 'function') {
        var evDone = (BATON_ID_SAFE_RE.test(inputs.batonId || '') && inputs.viewerAccount)
          ? batonEvent('relay-completed', inputs.batonId, inputs.viewerAccount, { root: inputs.root })
          : null;
        if (evDone) options.onRelayComplete(evDone);
      }
      return null;
    }
    if (node.hasAttribute('data-register')) {
      if (typeof options.onRegister === 'function') options.onRegister();
      return null;
    }
    return null;
  };
  render();
  fireOpened();
  return {
    render: render,
    state: function () { return { opened: state.opened, copied: state.copied }; },
    unmount: function () { target.onclick = null; },
  };
}
