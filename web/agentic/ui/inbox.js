// M14 · 「需要你」收件箱（Agent Inbox）—— 顶栏铃铛 + 未决计数徽标 + need 卡面板（纯核 + DOM 壳）
// 依据：PRD §5.5（L296-306：收件箱类型表——决定/数据/授权/到场/验收，交互=选项组作答；
//   规则「每条都有截止时刻和超时默认行为（继续/暂停/跳过该步）」——本组件每卡展示
//   截止 + 超时默认，超时默认态由 done='超时 · '+def 表达）、§5.1（L227：全局「需要你」
//   收件箱 = 顶栏铃铛）、§4（L174 Need 对象带截止和默认处理；L190 状态机
//   need: open → answered | defaulted(超时按默认) | waived | expired——answered/defaulted
//   都归入「已处理」降透明态）、§3.2（L139：收件箱弹出非阻塞，超时按默认继续）；
//   prototype.html（唯一视觉/交互标准）L37-38（.bell 相对定位 + b 徽标 20px 圆角
//   --you 色白字）、L125-128（.inbox fixed right16 top72 宽 min(380px,100vw-32px)
//   max-height 70vh 滚动 + 阴影 / .need 左 4px --you 边 + 12px .meta + .acts 换行
//   按钮组）、L135（.hidden display none）、L185（reduced-motion 禁动画）、
//   L195（铃铛按钮 aria-label=需要你 + b#bellN 计数徽标）、L236-239（面板
//   aside.card.inbox aria-label=需要你 + 头部 h2 + 关闭按钮 + #needs 空态文案）、
//   L515-523（renderNeeds：open=未 done 计数进徽标、0 隐藏；倒序渲染（最新在前）；
//   meta=所属块标题 · 截止 时刻 · 超时：默认；done → 卡 opacity.55 +「已处理：…」、
//   无按钮；未 done → .acts 选项按钮组 data-ans=needId data-v=选项）、L607（模拟时钟
//   超时：n.done='超时 · '+n.def —— 超时默认态）、L640（作答：data-ans 按钮 →
//   done='你选了「v」'——组件侧解耦为 onAnswer(needId, value) 回调，由宿主回写状态）、
//   L643-644（铃铛开合面板 / 关闭按钮）。
// 契约（tests/agentic/ui/inbox.spec.ts 组件页 + unit/inbox.test.mjs 纯核/壳桩）：
//   mount(el, { needs, blocks, onAnswer, onClose }) → handle{ el, update(props) }   面板
//   mountBell(el, { count, onToggle }) → handle{ el, update({ count }) }            铃铛
//   need = { id, title, body, opts, due, def, b, done }（done 非空 = 已处理；
//   '超时 · ' 前缀 = 超时默认态）；blocks = { id, title }[]（所属块标题查询）；
//   渲染序 = 给定数组倒序（最新在前，prototype L518 slice().reverse()）。
// 增量硬约束（PRD §5.2 末 L275 原型实测教训）：面板壳（.inbox 头部 + .needs 容器）与
//   铃铛壳只在首绘写一次；此后 update 只 ①对已知卡做内容补丁（同 id 同节点：done 态
//   变化只重写该卡 innerHTML + opacity，不重建节点）②新 need 按 DOM 位插入（后继卡
//   insertAdjacentHTML('beforebegin') / 容器 beforeend，既有卡节点/顺序全保留）
//   ③needs 收缩才 remove 对应卡；空态 ↔ 列表切换只写容器文案。铃铛徽标只动
//   textContent + classList，不重写按钮。
// a11y（BUILD-PLAN W5.3 硬性要求）：面板 aria-label=需要你；.needs 容器
//   aria-live=polite（新 need 进场播报）；按钮原生可聚焦 + :focus-visible 焦点可见；
//   Esc / 关闭按钮 → onClose；reduced-motion 压掉动画。
// esc/setHTML 探测 M01 web/agentic/ui/utils.js（同 registry/tiers/block-card/discuss/
//   五实体 + 内容比对跳过）。

// M01 utils.js 已落地为硬依赖：esc/setHTML 直引共享实现，单一来源
//（并行落地期的「动态探测 + 本地同规则兜底」已收编，组件顶层 await 随之移除）。
import { esc, setHTML } from './utils.js';

export { esc, setHTML }; // 保持既有 re-export 导入面（单测/组件页按组件模块导入）

// ---------- 常量（prototype 原文）与归一 ----------

export const INBOX_TITLE = '需要你'; // L195/L236-237
export const INBOX_EMPTY_TEXT = '现在没有需要你处理的事。'; // L238/L522
export const TIMEOUT_PREFIX = '超时 · '; // L607：n.done = '超时 · ' + n.def
export const DONE_OPACITY = '.55'; // L519：style="opacity:.55"

/** need 归一：{ id, title, body, opts, due, def, b, done }（id/title 必填非空，其余 trim 缺省空串；opts 剔非字符串保序）；无效 null */
export function normalizeNeed(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const id = typeof v.id === 'string' ? v.id.trim() : '';
  const title = typeof v.title === 'string' ? v.title.trim() : '';
  if (!id || !title) return null;
  const opts = Array.isArray(v.opts)
    ? v.opts.filter((o) => typeof o === 'string' && o.trim()).map((o) => o.trim())
    : [];
  const str = (x) => (typeof x === 'string' ? x.trim() : '');
  return {
    id, title,
    body: str(v.body),
    opts,
    due: str(v.due),
    def: str(v.def),
    b: str(v.b),
    done: str(v.done), // 非空 = 已处理（answered / defaulted）
  };
}

/** need 列表归一：过滤无效项保持给定顺序（时间正序给入约定）；非数组一律 [] */
export function normalizeNeeds(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const n of v) {
    const x = normalizeNeed(n);
    if (x) out.push(x);
  }
  return out;
}

/** blocks 归一：只收 { id, title }（均非空、trim）；非数组一律 [] */
export function normalizeBlocks(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const b of v) {
    if (!b || typeof b !== 'object') continue;
    const id = typeof b.id === 'string' ? b.id.trim() : '';
    const title = typeof b.title === 'string' ? b.title.trim() : '';
    if (id && title) out.push({ id, title });
  }
  return out;
}

/** 铃铛计数归一：非负整数；非法一律 0 */
export function normalizeCount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 所属块标题查询（prototype L520 blocks.find(…).title）；未知块兜底空串（原型会炸，组件不炸） */
export function blockTitle(blocks, b) {
  const list = normalizeBlocks(blocks);
  return list.find((x) => x.id === b)?.title ?? '';
}

/** 未决计数：done 为空的 need 数（prototype L516 filter(!n.done) → 徽标数字） */
export function pendingCount(needs) {
  return normalizeNeeds(needs).filter((n) => n.done === '').length;
}

/** 超时默认态：done 以「超时 · 」开头（prototype L607） */
export function isTimedOut(need) {
  const n = normalizeNeed(need);
  return !!n && n.done.startsWith(TIMEOUT_PREFIX);
}

/** meta 行：所属块 · 截止 时刻 · 超时：默认（prototype L520 原文格式；空段跳过不残留「 · 」） */
export function metaLine(need, blocks) {
  const n = normalizeNeed(need);
  if (!n) return '';
  const parts = [];
  const bt = blockTitle(blocks, n.b);
  if (bt) parts.push(bt);
  if (n.due) parts.push(`截止 ${n.due}`);
  if (n.def) parts.push(`超时：${n.def}`);
  return parts.join(' · ');
}

// ---------- 纯核：结构 HTML（prototype L518-522 原文结构） ----------

/** 选项按钮组：data-ans=needId data-v=选项（prototype L521；已处理/无效 → 空） */
export function actionsHTML(need) {
  const n = normalizeNeed(need);
  if (!n || n.done) return '';
  return `<div class="acts">${n.opts.map((o) => `<button class="btn" type="button" data-ans="${esc(n.id)}" data-v="${esc(o)}">${esc(o)}</button>`).join('')}</div>`;
}

/** 卡内层：标题 b + 正文 div + meta 行 + （已处理行 | acts 按钮组）（prototype L519-521） */
export function needCardInner(need, blocks) {
  const n = normalizeNeed(need);
  if (!n) return '';
  return `<b>${esc(n.title)}</b><div>${esc(n.body)}</div>`
    + `<div class="meta">${esc(metaLine(n, blocks))}</div>`
    + (n.done ? `<div class="meta">已处理：${esc(n.done)}</div>` : actionsHTML(n));
}

/** 整卡：.need + data-need 身份键；done 才带内联 opacity（prototype L519 原文值） */
export function needCardHTML(need, blocks) {
  const n = normalizeNeed(need);
  if (!n) return '';
  return `<div class="need" data-need="${esc(n.id)}"${n.done ? ` style="opacity:${DONE_OPACITY}"` : ''}>${needCardInner(n, blocks)}</div>`;
}

/** 面板壳：.card.inbox aria-label=需要你 + 头部（h2 + 关闭钮）+ .needs 容器（aria-live 播报新 need） */
export function inboxShellHTML() {
  return `<div class="card inbox" aria-label="${esc(INBOX_TITLE)}">`
    + `<div class="inbox-head"><h2>${esc(INBOX_TITLE)}</h2><span class="spacer"></span>`
    + `<button class="btn" type="button" data-inbox-close>关闭</button></div>`
    + `<div class="needs" aria-live="polite"></div></div>`;
}

/** 铃铛壳：按钮 aria-label=需要你 + b 计数徽标（初始 0 隐藏，prototype L195/L517） */
export function bellShellHTML() {
  return `<button class="btn bell" type="button" aria-label="${esc(INBOX_TITLE)}">${esc(INBOX_TITLE)}<b class="hidden">0</b></button>`;
}

/** 空态（prototype L238/L522 原文） */
export function emptyHTML() {
  return `<p class="small muted inbox-empty">${esc(INBOX_EMPTY_TEXT)}</p>`;
}

// ---------- 样式（prototype L37-38/L125-128 原文 + token 兜底 + a11y；M01 agentic.css 落地后共存无害） ----------

export const INBOX_CSS = `
.inbox{position:fixed;right:16px;top:72px;width:min(380px,calc(100vw - 32px));max-height:70vh;overflow:auto;z-index:20;box-shadow:0 16px 40px rgba(0,0,0,.18);background:var(--surface,#FFFFFF);border:1px solid var(--line,rgba(34,48,42,.14));border-radius:18px;padding:16px}
.inbox .inbox-head{display:flex;align-items:center}
.inbox h2{font-size:18px;font-family:var(--font-serif,"Noto Serif SC","Songti SC","STSong",serif);font-weight:400;margin:0}
.inbox .spacer{flex:1}
.inbox .needs p.inbox-empty{margin-top:10px;font-size:13px;color:var(--text-2,#5C6B61)}
.need{border:1px solid var(--line,rgba(34,48,42,.14));border-left:4px solid var(--you,#E95432);border-radius:12px;padding:10px 12px;display:grid;gap:8px;margin-top:10px}
.need .meta{font-size:12px;color:var(--text-2,#5C6B61)}
.need .acts{display:flex;gap:8px;flex-wrap:wrap}
.inbox .btn,.bell{border:1px solid var(--line,rgba(34,48,42,.14));background:var(--surface,#FFFFFF);border-radius:999px;padding:8px 16px;min-height:40px;cursor:pointer;font:inherit;color:inherit}
.bell{position:relative}
.bell b{position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;border-radius:10px;background:var(--you,#E95432);color:#fff;font-size:12px;display:grid;place-items:center;padding:0 5px}
.bell b.hidden{display:none !important}
.inbox button:focus-visible,.bell:focus-visible{outline:2px solid var(--you,#E95432);outline-offset:2px}
@media (prefers-reduced-motion: reduce){.inbox *,.inbox *::before,.inbox *::after,.bell,.bell b{animation:none !important;transition:none !important}}
`;

/** 幂等注入样式；无 DOM 环境（node 纯核）安全返回 false（M06/M07/M10/M12 同款） */
export function ensureStyles(doc) {
  if (!doc || typeof doc.createElement !== 'function') return false;
  if (doc.querySelector('style[data-agentic-inbox]')) return false;
  const st = doc.createElement('style');
  st.setAttribute('data-agentic-inbox', '');
  st.textContent = INBOX_CSS;
  const head = doc.head || doc.documentElement;
  if (!head || typeof head.appendChild !== 'function') return false;
  head.appendChild(st);
  return true;
}

// ---------- DOM 壳：mount（面板）/ mountBell（铃铛） ----------

/**
 * 面板壳（组件页 ?c=inbox / demo 装配）：mount(el, props) → handle。
 * props = { needs, blocks, onAnswer, onClose }；update(props) 合并语义（未传键不动旧值，
 *   回调仅函数可替换），链式返回 handle。
 * 增量：壳（.inbox 头部 + .needs 容器）首绘一次；此后 update 只做卡级补丁/插入/删除
 *   （见文件头「增量硬约束」）；空态 ↔ 列表切换只写容器文案。
 * 事件：el 上委托 click——button[data-ans] → onAnswer(needId, value)（prototype L640），
 *   [data-inbox-close] → onClose（L644）；document keydown Escape → onClose（键盘可达）。
 * el=null / 宿主缺 querySelector·insertAdjacentHTML：安全降级不抛（M10/M12 同款容忍）。
 */
export function mount(el, props = {}) {
  const doc = (el && el.ownerDocument) || (typeof document !== 'undefined' ? document : null);
  ensureStyles(doc);

  const state = {
    needs: [], blocks: [],
    cards: null,       // Map<id, cardEl>：已渲染卡（null = 壳未首绘）
    inner: new Map(),  // Map<id, innerHTML>：卡内容缓存（内容比对，未变零写）
    empty: false,      // .needs 是否处于空态文案
    onAnswer: null, onClose: null,
  };

  const zone = (sel) => (typeof el?.querySelector === 'function' ? el.querySelector(sel) : null);
  const listZone = () => {
    const panel = zone('.inbox');
    return panel && typeof panel.querySelector === 'function' ? panel.querySelector('.needs') : null;
  };

  const merge = (p) => {
    if (!p || typeof p !== 'object') return;
    if ('needs' in p) state.needs = normalizeNeeds(p.needs);
    if ('blocks' in p) state.blocks = normalizeBlocks(p.blocks);
    if (typeof p.onAnswer === 'function') state.onAnswer = p.onAnswer;
    if (typeof p.onClose === 'function') state.onClose = p.onClose;
  };

  /** 渲染序：给定数组倒序（最新在前，prototype L518），同 id 取最新版本不重复建卡 */
  const ordered = () => {
    const seen = new Set();
    const out = [];
    for (const n of state.needs.slice().reverse()) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      out.push(n);
    }
    return out;
  };

  /** 从 DOM 重取卡句柄（插入后一次性；dataset/getAttribute 双路取 data-need） */
  const syncCards = () => {
    const z = listZone();
    if (!z || typeof z.querySelectorAll !== 'function') return;
    for (const c of z.querySelectorAll('.need')) {
      const id = c?.dataset?.need ?? (typeof c?.getAttribute === 'function' ? c.getAttribute('data-need') : null);
      if (typeof id === 'string' && id) state.cards.set(id, c);
    }
  };

  const paintEmpty = (on) => {
    const z = listZone();
    if (!z) return;
    setHTML(z, on ? emptyHTML() : '');
    state.empty = on;
  };

  const apply = (p) => {
    merge(p);
    if (!state.cards) { // 首绘：壳一次
      setHTML(el, inboxShellHTML());
      state.cards = new Map();
      state.inner.clear();
    }
    const list = listZone();
    if (!list) return; // 宿主无子区（node 裸桩）：壳已写，安全跳过

    const want = ordered();
    if (!want.length) { // 空态：清卡 + 文案（prototype L522 分支）
      for (const [, c] of [...state.cards]) c?.remove?.();
      state.cards.clear();
      state.inner.clear();
      if (!state.empty) paintEmpty(true);
      return;
    }
    if (state.empty) paintEmpty(false);

    // 删：needs 收缩才 remove（未涉及卡不动）
    const wantIds = new Set(want.map((n) => n.id));
    for (const [id, c] of [...state.cards]) {
      if (!wantIds.has(id)) {
        c?.remove?.();
        state.cards.delete(id);
        state.inner.delete(id);
      }
    }
    // 补丁：内容（标题/正文/meta/acts/已处理行）或透明度变才写该卡
    for (const n of want) {
      const c = state.cards.get(n.id);
      if (!c) continue;
      const inner = needCardInner(n, state.blocks);
      if (state.inner.get(n.id) !== inner) {
        setHTML(c, inner);
        state.inner.set(n.id, inner);
      }
      const op = n.done ? DONE_OPACITY : '';
      if (c.style && c.style.opacity !== op) c.style.opacity = op;
    }
    // 增：按渲染位插入（找 DOM 里第一个应在其后的既有卡，beforebegin 前插；无则容器末尾）
    const fresh = want.filter((n) => !state.cards.has(n.id));
    for (const n of fresh) {
      const html = needCardHTML(n, state.blocks);
      let anchor = null;
      for (let j = want.indexOf(n) + 1; j < want.length && !anchor; j++) {
        anchor = state.cards.get(want[j].id) ?? null;
      }
      let inserted = false;
      if (anchor && typeof anchor.insertAdjacentHTML === 'function') {
        anchor.insertAdjacentHTML('beforebegin', html);
        inserted = true;
      } else if (typeof list.insertAdjacentHTML === 'function') {
        list.insertAdjacentHTML('beforeend', html);
        inserted = true;
      }
      if (inserted) state.inner.set(n.id, needCardInner(n, state.blocks));
    }
    if (fresh.length) syncCards();
  };

  if (typeof el?.addEventListener === 'function') {
    el.addEventListener('click', (ev) => {
      const t = ev?.target;
      if (!t || typeof t.closest !== 'function') return;
      const ans = t.closest('button[data-ans]');
      if (ans) { // 作答（prototype L640）
        const id = ans.dataset?.ans ?? (typeof ans.getAttribute === 'function' ? ans.getAttribute('data-ans') : null);
        const v = ans.dataset?.v ?? (typeof ans.getAttribute === 'function' ? ans.getAttribute('data-v') : null);
        if (id != null && state.onAnswer) state.onAnswer(String(id), String(v));
        return;
      }
      if (t.closest('[data-inbox-close]') && state.onClose) state.onClose(); // 关闭（L644）
    });
  }
  const onDocKey = (ev) => { // Esc 关闭（键盘可达；drawer 同款护栏）
    if (!ev || ev.key !== 'Escape' || ev.defaultPrevented) return;
    if (typeof ev.preventDefault === 'function') ev.preventDefault();
    if (state.onClose) state.onClose();
  };
  if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('keydown', onDocKey);

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

/**
 * 铃铛壳（组件页 ?c=inbox-bell / 顶栏装配）：mountBell(el, props) → handle。
 * props = { count, onToggle }；update({ count }) 增量——只动徽标 textContent +
 *   classList.toggle('hidden', !count)（prototype L517），按钮不重写；
 *   点击 → onToggle()（L643 开合面板由宿主决定）。
 * el=null / 裸宿主：安全降级不抛。
 */
export function mountBell(el, props = {}) {
  const doc = (el && el.ownerDocument) || (typeof document !== 'undefined' ? document : null);
  ensureStyles(doc);

  const state = { count: 0, onToggle: null };

  const merge = (p) => {
    if (!p || typeof p !== 'object') return;
    if ('count' in p) state.count = normalizeCount(p.count);
    if (typeof p.onToggle === 'function') state.onToggle = p.onToggle;
  };

  const badgeZone = () => {
    const btn = typeof el?.querySelector === 'function' ? el.querySelector('button') : null;
    return btn && typeof btn.querySelector === 'function' ? btn.querySelector('b') : null;
  };

  const sync = () => {
    const badge = badgeZone();
    if (!badge) return;
    badge.textContent = String(state.count);
    if (typeof badge.classList?.toggle === 'function') badge.classList.toggle('hidden', state.count === 0);
  };

  setHTML(el, bellShellHTML());
  merge(props);
  sync();

  if (typeof el?.addEventListener === 'function') {
    el.addEventListener('click', (ev) => {
      const t = ev?.target;
      const btn = typeof t?.closest === 'function' ? t.closest('button') : null;
      if (btn && state.onToggle) state.onToggle();
    });
  }

  const handle = {
    el,
    update(p) {
      merge(p);
      sync();
      return handle;
    },
  };
  return handle;
}
