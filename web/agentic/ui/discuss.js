// M10 · 讨论框 + 差异高亮 —— 例句 chips + 输入行 + patchNote 播报（纯核 + DOM 壳）
// 依据：PRD §5.2 讨论（L271：对着预演说话/打字 → 结构化补丁 → 只重渲染受影响层 →
//   差异高亮「新增绿 / 删除删除线 / 变更黄」，L0 更新 ≤3 秒）+ §5.2 末「原型实测教训」
//   （整块重绘会冲掉输入/焦点——本组件的增量硬约束来源）；
//   prototype.html（唯一视觉标准）L96-98（.discuss/.row/input 样式）、L409-412（结构：
//   small 提示 + .chips 例句 + .row 输入行 + #patchNote[aria-live]）、L452-459（applySay：
//   空文本 return；已按「…」更新： + .add/.del/.chg）、L629（#sayBtn → value.trim()）、
//   L648（Enter on #sayInput）。
// 契约（tests/agentic/ui/discuss.spec.ts 组件页 + unit/discuss.test.mjs 纯核/壳桩）：
//   mount(el, { examples, note, onSay }) → handle{ el, update(props), say(text) }
//   examples: string[] 例句 chips（data-say，点击 → onSay(原文)）；
//   note: { utterance, summary } 补丁结果——summary 按「新增/删除/变更」前缀分段包
//   .add/.del/.chg（prototype L458 原文结构），#patchNote aria-live=polite 播报；
//   输入行 Enter（L648）与「改」按钮（L629）都 → onSay(value.trim())，空输入忽略，
//   提交不清空输入框（spec 双提交契约）。
// 增量硬约束（spec「更新 patchNote 后输入框不丢焦点」）：壳（提示行/.chips/.row/#patchNote）
//   只在 mount 写一次；update 仅打 .chips / .patch-note 两子区（setHTML 内容比对），
//   输入行节点永不重建 → 焦点与输入值跨 update 存活（PRD §5.2 末教训的组件级落实）。
// esc/setHTML 探测 M01 web/agentic/ui/utils.js（同 registry/tiers/block-card 并行落地模式），

// M01 utils.js 已落地为硬依赖：esc/setHTML 直引共享实现，单一来源
//（并行落地期的「动态探测 + 本地同规则兜底」已收编，组件顶层 await 随之移除）。
import { esc, setHTML } from './utils.js';

export { esc, setHTML }; // 保持既有 re-export 导入面（单测/组件页按组件模块导入）

// ---------- 常量（prototype L409/L411 原文）与状态归一 ----------

export const DISCUSS_HEADING = '对着预演说说你的想法（试试下面的例子）';
export const SAY_PLACEHOLDER = '比如：别读我的邮箱 / 篇幅短一点';
export const SAY_LABEL = '改';

/** 例句归一：只留非空字符串项；非数组一律 []（chips 死按钮宁缺勿留） */
export function normalizeExamples(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((s) => typeof s === 'string' && s.trim().length > 0);
}

/** note 归一：{ utterance, summary } 对象收下（缺省字段空串）；其余一律 null（不播报） */
export function normalizeNote(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return { utterance: v.utterance ?? '', summary: v.summary ?? '' };
}

// ---------- 纯核：差异高亮（PRD §5.2 L271 / prototype L458） ----------

const KW_CLASS = { 新增: 'add', 删除: 'del', 变更: 'chg' };

/**
 * 差异摘要分段高亮：按中文/ASCII 分号切段，「新增/删除/变更」前缀的关键字包进
 * .add/.del/.chg span（prototype L458 `<span class="add">新增</span> 课堂实践…` 原文结构），
 * 其余文本 esc 纯文本；无前缀的段保持原样（如「课程改为 4 课时工作坊」）。
 */
export function markSummary(summary) {
  const s = String(summary ?? '');
  if (!s) return '';
  return s.split(/[；;]/).map((seg) => {
    const m = seg.match(/^(新增|删除|变更)\s?([\s\S]*)$/);
    if (!m) return esc(seg);
    const span = `<span class="${KW_CLASS[m[1]]}">${m[1]}</span>`;
    return m[2] ? `${span} ${esc(m[2])}` : span;
  }).join('；');
}

/** patchNote 内容：null → 空；「已按「utterance」更新：」+ markSummary（空摘要不带尾冒号） */
export function patchNoteHTML(note) {
  const n = normalizeNote(note);
  if (!n) return '';
  const body = markSummary(n.summary);
  const head = `已按「${esc(n.utterance)}」更新`;
  return body ? `${head}：${body}` : head;
}

// ---------- 纯核：结构 HTML ----------

/** 例句按钮组内层（宿主 .chips 容器的子树，供增量打补丁复用） */
export function chipsInner(examples) {
  return normalizeExamples(examples)
    .map((ex) => `<button type="button" class="chip" data-say="${esc(ex)}">${esc(ex)}</button>`)
    .join('');
}

/** .chips 容器（prototype L410） */
export function chipsHTML(examples) {
  return `<div class="chips">${chipsInner(examples)}</div>`;
}

/** 输入行：#sayInput(placeholder/aria-label) + #sayBtn「改」（prototype L411 原文 + type=button） */
export function rowHTML() {
  return `<div class="row"><input id="sayInput" placeholder="${esc(SAY_PLACEHOLDER)}" aria-label="讨论">`
    + `<button type="button" class="btn" id="sayBtn" data-saybtn="1">${esc(SAY_LABEL)}</button></div>`;
}

/** 整壳：mount 首绘一次（此后只打 .chips/.patch-note 子区补丁） */
export function discussHTML(props = {}) {
  return '<div class="discuss">'
    + `<p class="small muted">${esc(DISCUSS_HEADING)}</p>`
    + chipsHTML(props.examples)
    + rowHTML()
    + `<p class="small patch-note" id="patchNote" aria-live="polite" role="status">${patchNoteHTML(props.note)}</p>`
    + '</div>';
}

// ---------- 样式（prototype L96-98/L53-54/L83-85 原文 + token 兜底；M01 agentic.css 落地后共存无害） ----------

export const DISCUSS_CSS = `
.discuss { margin-top: 14px; display: grid; gap: 8px; }
.discuss .row { display: flex; gap: 8px; }
.discuss input { flex: 1; min-height: 42px; border-radius: 12px; border: 1px solid var(--line, rgba(34,48,42,.14)); background: var(--surface, #FFFFFF); color: var(--text, #22302A); padding: 0 12px; font: inherit; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.discuss .chip { font-size: 12px; border-radius: 999px; padding: 2px 9px; background: var(--paper, #FCFBF6); border: 1px solid var(--line, rgba(34,48,42,.14)); color: var(--text-2, #5C6B61); }
.discuss .btn { border: 1px solid var(--line, rgba(34,48,42,.14)); background: var(--surface, #FFFFFF); border-radius: 999px; padding: 8px 16px; min-height: 40px; }
.patch-note .add { background: var(--add, rgba(63,122,85,.14)); border-radius: 4px; }
.patch-note .del { background: var(--del, rgba(165,59,37,.12)); text-decoration: line-through; border-radius: 4px; }
.patch-note .chg { background: var(--chg, rgba(238,240,190,.9)); border-radius: 4px; }
@media (prefers-reduced-motion: reduce) { .discuss, .discuss * { transition: none !important; animation: none !important; } }
`;

/** 幂等注入样式；无 DOM 环境（node 纯核）安全返回 false（M06/M07 同款） */
export function ensureStyles(doc) {
  if (!doc || typeof doc.createElement !== 'function') return false;
  if (doc.querySelector('style[data-agentic-discuss]')) return false;
  const st = doc.createElement('style');
  st.setAttribute('data-agentic-discuss', '');
  st.textContent = DISCUSS_CSS;
  const head = doc.head || doc.documentElement;
  if (!head || typeof head.appendChild !== 'function') return false;
  head.appendChild(st);
  return true;
}

// ---------- DOM 壳：mount / update ----------

/**
 * 壳（组件页 ?c=discuss / demo 装配）：mount(el, props) → handle。
 * props = { examples, note, onSay }；update(props) 合并语义（未传键不动旧值），链式返回 handle。
 * 增量：壳只写一次；此后 update 只 setHTML 两个子区（.chips / .patch-note），内容未变零写；
 *   输入行（#sayInput/#sayBtn）节点永不重建 → 更新后不丢焦点、输入值不丢（spec 硬约束）。
 * 事件：容器级委托单监听——click：[data-say] 例句 → onSay(原文)、[data-saybtn] → onSay(input
 *   .value.trim())（prototype L629）；keydown：Enter 且 target#sayInput → onSay(value.trim())
 *   （prototype L648）。submit 统一 trim，空输入（含纯空白）忽略，提交不清空输入框。
 */
export function mount(el, props) {
  const state = { examples: [], note: null, onSay: null };
  let shellDone = false;

  const merge = (p) => {
    if (!p || typeof p !== 'object') return;
    if ('examples' in p) state.examples = normalizeExamples(p.examples);
    if ('note' in p) state.note = normalizeNote(p.note);
    if ('onSay' in p) state.onSay = typeof p.onSay === 'function' ? p.onSay : null;
  };

  /** 统一提交口：trim 后空文本忽略（prototype applySay L453 `if (!text) return`）；返回是否触发 */
  const submit = (raw) => {
    const text = String(raw ?? '').trim();
    if (!text) return false;
    if (typeof state.onSay === 'function') state.onSay(text);
    return true;
  };

  const zone = (sel) => (typeof el?.querySelector === 'function' ? el.querySelector(sel) : null);

  const apply = (p) => {
    merge(p);
    if (!shellDone) {
      setHTML(el, discussHTML(state));
      shellDone = true;
    }
    const chipsZone = zone('.chips');
    if (chipsZone) setHTML(chipsZone, chipsInner(state.examples));
    const noteZone = zone('.patch-note');
    if (noteZone) setHTML(noteZone, patchNoteHTML(state.note));
  };

  if (typeof el?.addEventListener === 'function') {
    el.addEventListener('click', (e) => {
      const t = e?.target;
      const chip = t?.closest?.('[data-say]');
      if (chip) {
        submit(chip.dataset?.say);
        return;
      }
      const btn = t?.closest?.('[data-saybtn]');
      if (btn) submit(zone('input')?.value);
    });
    el.addEventListener('keydown', (e) => {
      if (e?.key !== 'Enter') return;
      const t = e?.target;
      if (t && t.id === 'sayInput') submit(t.value);
    });
  }

  const doc = (el && el.ownerDocument) || (typeof document !== 'undefined' ? document : null);
  ensureStyles(doc);

  apply(props);
  const handle = {
    el,
    say: submit,
    update(p) {
      apply(p);
      return handle;
    },
  };
  return handle;
}
