// M13 · 验收页 —— artifact + 证据区 + 接受/要求修改/拒绝 + gain 计时收益（纯核 + DOM 壳）
// 依据：PRD §5.6 验收与合入（L308-313：交付物页 = 成品 + 证据区 + 版本历史；
//   接受计入时间收益 / 要求修改（自然语言意见 → 新一轮 Run，保留旧版本）/
//   拒绝（原因可选，进入学习信号））+ §5.8 a11y 底线；
//   prototype.html（唯一视觉标准）L128-131（.artifact grid / .evidence 纸底 / .gain ok 色）、
//   L477-488（renderArt：未就绪文案、h3 标题 + p.small 规模 + .evidence 证据、
//   已接受「✓ 已接受 · 计入为你腾出的时间 约 45 分钟（按你过去同类任务实测）」、
//   接受(primary)/要求修改/拒绝(danger) 三操作）。
// 契约（tests/agentic/ui/acceptance.spec.ts 组件页 + unit/acceptance.test.mjs 纯核/壳桩）：
//   mount(el, { ready, artifact, accepted, gainText, onAccept, onRevise, onReject })
//   → { el, update(props) }（合并语义：未传键不动旧值，链式返回 handle）。
//   artifact = { title, meta, evidence } 字符串三字段（证据文案自带「证据：」前缀，原样渲染）。
//   回调（spec deepEqual 钉死）：接受 → onAccept({ opinion: '' })；
//   要求修改 → 先出意见输入，确认 → onRevise({ opinion })（恰此一键载荷）；
//   拒绝 → onReject()。「保留旧版本」由宿主的新一轮 Run 承载（PRD §5.6），
//   本组件在意见占位文案里向用户传达 v1 保留语义。
// 与原型有意差异（记录）：① prototype data-rev 点按即回灌固定意见「第 4 节再短一点」
//   并跳活动流标签（L635）——组件按 spec 细化为真实意见输入 + 回调，语义归宿主；
//   ② prototype .acts 为内联 style（L488）——组件改类样式，渲染等价；
//   ③ gain 段补 role=status + aria-live=polite（BUILD-PLAN W5「aria-live 用在状态」硬性
//   要求，原型无此属性）；④ 拒绝原因收集不在本组件契约（PRD「原因可选」由宿主/学习信号
//   线承接），onReject() 一键拒绝；⑤ 版本历史由 artifact.meta/title 里的「· v1」承载，
//   不单列版本列表（plan.md M13 未要求）。
// 增量（BUILD-PLAN W5 硬性要求 / PRD §5.2 末教训）：壳（.artifact/.acts/.revise 三子区）
//   只在 mount 写一次；update 仅 setHTML 打子区（内容比对）——换证据不碰裁决区，
//   签收态翻转不碰证据区，意见输入节点在 update 间保活（打字不打断）。
// esc/setHTML 探测 M01 web/agentic/ui/utils.js（同 boundaries/discuss 并行落地模式），
//   未落地本地兜底（规则与 prototype L328-329 一致：五实体 + 内容比对跳过）。
let escShared = null;
let setHTMLShared = null;
try {
  const utils = await import('./utils.js');
  if (typeof utils.esc === 'function') escShared = utils.esc;
  if (typeof utils.setHTML === 'function') setHTMLShared = utils.setHTML;
} catch {
  // utils.js 不存在（M01 未落地）：本地兜底
}

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** 五实体转义（M01 XSS 基线）：外部字符串入 HTML 必经 */
export const esc = escShared ?? ((s) => String(s).replace(/[&<>"']/g, (c) => ESC_MAP[c]));
/** 内容没变就不重写 DOM（prototype L328：增量更新基石） */
export const setHTML = setHTMLShared ?? ((el, html) => {
  if (!el || el._h === html) return false;
  el._h = html;
  el.innerHTML = html;
  return true;
});

// ---------- 常量（prototype L481/L487-488 原文）与状态归一 ----------

/** 未就绪占位（prototype L481 原文：只有你接受的交付才计入时间收益） */
export const NOT_READY_TEXT = '交付物完成后在这里验收：成品 + 证据 + 版本。只有你接受的交付，才计入「为你腾出的时间」。';
/** gain 首尾（prototype L487：✓ 已接受 · 计入为你腾出的时间 <gain>（按你过去同类任务实测）） */
export const GAIN_HEAD = '✓ 已接受 · 计入为你腾出的时间';
export const GAIN_TAIL = '（按你过去同类任务实测）';
/** 三操作文案（prototype L488） */
export const ACCEPT_TEXT = '接受';
export const REVISE_TEXT = '要求修改';
export const REJECT_TEXT = '拒绝';
/** 意见占位：传达「保留旧版本，改好再看」（PRD §5.6 要求修改语义） */
export const REVISE_PLACEHOLDER = '说一句要改什么（这一版会保留，改好再给你看）';
export const REVISE_LABEL = '修改意见';
export const CONFIRM_REVISE_TEXT = '提交意见';
export const CANCEL_REVISE_TEXT = '取消';

const txt = (v) => esc(v ?? '');

/** 非空字符串或 ''（trim 后判空；非串丢弃） */
const nonEmptyStr = (v) => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : '');

/** artifact 归一：{ title, meta, evidence } 三字段各取非空串；非对象 → 空三栏（宁缺勿假） */
export function normalizeArtifact(v) {
  const src = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  return {
    title: nonEmptyStr(src.title),
    meta: nonEmptyStr(src.meta),
    evidence: nonEmptyStr(src.evidence),
  };
}

/** gain 收益文案：非空串 trim 收下；空/缺省/非串 ''（缺省不编数字，P5 估算不是收益） */
export function gainTextOf(v) {
  return nonEmptyStr(v);
}

// ---------- 纯核：HTML 构建 ----------

/**
 * artifact 子区内层（update 打 .artifact 子区用；prototype L482-483 原文结构）：
 *   就绪 → h3 标题 + p.small 规模 + .evidence 证据区（空字段省略对应节点）；
 *   未就绪 → prototype L481 占位文案（muted 段）。
 */
export function artifactInner(props = {}) {
  if (!props.ready) return `<p class="muted">${txt(NOT_READY_TEXT)}</p>`;
  const a = normalizeArtifact(props.artifact);
  return (a.title ? `<h3>${txt(a.title)}</h3>` : '')
    + (a.meta ? `<p class="small">${txt(a.meta)}</p>` : '')
    + (a.evidence ? `<div class="evidence">${txt(a.evidence)}</div>` : '');
}

/** 三操作（prototype L488 原文按钮；补 type=button 键盘可达 + data 咨询钩） */
export function actionsHTML() {
  return `<button type="button" class="btn primary" data-acc="1">${ACCEPT_TEXT}</button>`
    + `<button type="button" class="btn" data-rev="1">${REVISE_TEXT}</button>`
    + `<button type="button" class="btn danger" data-rej="1">${REJECT_TEXT}</button>`;
}

/** 已接受收益段（prototype L487 原文；role=status + aria-live 播报签收态） */
export function gainHTML(props = {}) {
  const g = gainTextOf(props.gainText);
  return `<p class="gain" role="status" aria-live="polite">${GAIN_HEAD}${g ? ` ${txt(g)}` : ''}${GAIN_TAIL}</p>`;
}

/** 意见输入（要求修改展开；data-confirm-revise/data-cancel-revise 为 spec 咨询钩） */
export function reviseFormHTML() {
  return `<textarea class="opinion" aria-label="${txt(REVISE_LABEL)}" placeholder="${txt(REVISE_PLACEHOLDER)}"></textarea>`
    + `<div class="revise-acts">`
    + `<button type="button" class="btn primary" data-confirm-revise="1">${CONFIRM_REVISE_TEXT}</button>`
    + `<button type="button" class="btn" data-cancel-revise="1">${CANCEL_REVISE_TEXT}</button>`
    + `</div>`;
}

/** 裁决子区内层：未就绪空；已接受 = gain；默认 = 三操作（update 打 .acts 子区用） */
export function verdictInner(props = {}) {
  if (!props.ready) return '';
  if (props.accepted) return gainHTML(props);
  return actionsHTML();
}

/** 意见子区内层：仅「就绪且未接受且正在修改」时展开，其余一律空（空段 CSS display:none） */
export function reviseInner(state = {}) {
  return state.revising && state.ready && !state.accepted ? reviseFormHTML() : '';
}

/** 整壳：mount 首绘一次（此后只打 .artifact/.acts/.revise 三子区补丁） */
export function acceptanceHTML(props = {}) {
  return `<div class="artifact" data-artifact="1">${artifactInner(props)}</div>`
    + `<div class="acts" data-acts="1">${verdictInner(props)}</div>`
    + `<div class="revise" data-revise="1">${reviseInner(props)}</div>`;
}

// ---------- 样式（prototype L128-131 + L488 内联转类 + token 兜底 + 焦点/reduced-motion；M01 agentic.css 落地后共存无害） ----------

export const ACCEPT_CSS = `
.artifact { display: grid; gap: 10px; }
.artifact h3 { font-family: var(--font-serif, "Noto Serif SC", "Songti SC", serif); font-weight: 400; margin: 0; }
.artifact .small { font-size: 13px; color: var(--text-2, #5C6B61); }
.artifact .muted { color: var(--text-2, #5C6B61); }
.evidence { font-size: 13px; border-radius: 10px; background: var(--paper, #FCFBF6); border: 1px solid var(--line, rgba(34,48,42,.14)); padding: 10px 12px; }
.acts { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.acts .btn, .revise .btn { border: 1px solid var(--line, rgba(34,48,42,.14)); background: var(--surface, #FFFFFF); border-radius: 999px; padding: 8px 16px; min-height: 40px; font: inherit; cursor: pointer; }
.acts .btn.primary, .revise .btn.primary { background: var(--accent, #3E5A47); border-color: var(--accent, #3E5A47); color: var(--surface, #FFFFFF); }
.acts .btn.danger { color: var(--bad, #A53B25); }
.acts button:focus-visible, .revise button:focus-visible, .revise textarea:focus-visible { outline: 2px solid var(--accent, #3E5A47); outline-offset: 2px; }
.gain { font-size: 14px; color: var(--ok, #3F7A55); margin: 0; }
.revise { display: grid; gap: 8px; }
.revise:empty { display: none; }
.revise textarea { min-height: 42px; border-radius: 12px; border: 1px solid var(--line, rgba(34,48,42,.14)); background: var(--surface, #FFFFFF); color: var(--text, #22302A); padding: 10px 12px; font: inherit; resize: vertical; }
.revise-acts { display: flex; gap: 8px; flex-wrap: wrap; }
@media (prefers-reduced-motion: reduce) { .artifact *, .acts *, .revise * { transition: none !important; animation: none !important; } }
`;

/** 幂等注入样式；无 DOM 环境（node 纯核）安全返回 false（M06/M07/M11 同款） */
export function ensureStyles(doc) {
  if (!doc || typeof doc.createElement !== 'function') return false;
  if (doc.querySelector('style[data-agentic-accept]')) return false;
  const st = doc.createElement('style');
  st.setAttribute('data-agentic-accept', '');
  st.textContent = ACCEPT_CSS;
  const head = doc.head || doc.documentElement;
  if (!head || typeof head.appendChild !== 'function') return false;
  head.appendChild(st);
  return true;
}

// ---------- DOM 壳：mount / update ----------

/**
 * 壳（组件页 ?c=acceptance / demo 装配）：mount(el, props) → handle。
 * props = { ready, artifact, accepted, gainText, onAccept, onRevise, onReject }。
 * 增量：壳只写一次；update/交互只 setHTML 三子区——.artifact（ready/artifact）、
 *   .acts（accepted/gainText）、.revise（意见表单开合），内容未变零写；
 *   证据与按钮节点跨 update 保活，意见输入打字不被 update 打断（PRD §5.2 末教训）。
 * 事件：容器级委托单监听——click [data-acc] → onAccept({opinion:''})；
 *   [data-rev] → 展开意见输入；[data-confirm-revise] → 读输入值 trim，
 *   空意见忽略（表单保留），否则收起表单并 onRevise({opinion})；
 *   [data-cancel-revise] → 收起零回调；[data-rej] → onReject()。
 *   按钮均原生 type=button（Enter/Space 原生触发 click = 键盘可达）。
 */
export function mount(el, props) {
  const state = {
    ready: false, artifact: normalizeArtifact(undefined), accepted: false,
    gainText: '', revising: false, onAccept: null, onRevise: null, onReject: null,
  };
  let shellDone = false;

  const merge = (p) => {
    if (!p || typeof p !== 'object') return;
    if ('ready' in p) state.ready = Boolean(p.ready);
    if ('artifact' in p) state.artifact = normalizeArtifact(p.artifact);
    if ('accepted' in p) state.accepted = Boolean(p.accepted);
    if ('gainText' in p) state.gainText = gainTextOf(p.gainText);
    if ('onAccept' in p) state.onAccept = typeof p.onAccept === 'function' ? p.onAccept : null;
    if ('onRevise' in p) state.onRevise = typeof p.onRevise === 'function' ? p.onRevise : null;
    if ('onReject' in p) state.onReject = typeof p.onReject === 'function' ? p.onReject : null;
  };

  const zone = (sel) => (typeof el?.querySelector === 'function' ? el.querySelector(sel) : null);

  const renderZones = () => {
    const artifactZone = zone('.artifact');
    if (artifactZone) setHTML(artifactZone, artifactInner(state));
    const actsZone = zone('.acts');
    if (actsZone) setHTML(actsZone, verdictInner(state));
    const reviseZone = zone('.revise');
    if (reviseZone) setHTML(reviseZone, reviseInner(state));
  };

  const apply = (p) => {
    merge(p);
    if (!state.ready || state.accepted) state.revising = false;
    if (!shellDone) {
      setHTML(el, acceptanceHTML(state));
      shellDone = true;
    }
    renderZones();
  };

  if (typeof el?.addEventListener === 'function') {
    el.addEventListener('click', (e) => {
      const t = e?.target;
      const acc = t?.closest?.('[data-acc]');
      if (acc) {
        state.revising = false;
        renderZones();
        if (typeof state.onAccept === 'function') state.onAccept({ opinion: '' });
        return;
      }
      const rev = t?.closest?.('[data-rev]');
      if (rev) {
        state.revising = true;
        renderZones();
        return;
      }
      const rej = t?.closest?.('[data-rej]');
      if (rej) {
        state.revising = false;
        renderZones();
        if (typeof state.onReject === 'function') state.onReject();
        return;
      }
      const confirm = t?.closest?.('[data-confirm-revise]');
      if (confirm) {
        const reviseZone = zone('.revise');
        const input = typeof reviseZone?.querySelector === 'function'
          ? reviseZone.querySelector('textarea, input[type=text]')
          : null;
        const opinion = typeof input?.value === 'string' ? input.value.trim() : '';
        if (!opinion) return; // 空意见忽略（表单保留，同 discuss 空提交语义）
        state.revising = false;
        renderZones();
        if (typeof state.onRevise === 'function') state.onRevise({ opinion });
        return;
      }
      const cancel = t?.closest?.('[data-cancel-revise]');
      if (cancel) {
        state.revising = false;
        renderZones();
      }
    });
  }

  const doc = (el && el.ownerDocument) || (typeof document !== 'undefined' ? document : null);
  ensureStyles(doc);

  apply(props);
  const handle = {
    el,
    update(p) {
      apply(p);
      return handle;
    },
  };
  return handle;
}
