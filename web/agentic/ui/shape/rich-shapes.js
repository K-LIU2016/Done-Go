// M04 · shape 渲染器 B —— 富媒体/清单类（纯核 + 组件壳）
// 依据：PRD §10.3 组件目录（checklist/timeline/slides 缩略/diffSummary/mapRoute/personCard/sample，
//   sample = Markdown 子集白名单渲染）；prototype.html L83-85（.add/.del/.chg）、L147-151（.slide 双栏）、
//   L159-161（.route/.line）、L281（样张 .sample 与 <b> 样张文本）；plan.md M04。
// 契约：
//   纯核：richShapes.checklist/timeline/slides/diffSummary/mapRoute/personCard/sample(block) → html string
//   壳：mount(el, { blocks }) → handle；handle.update({ blocks }) 增量（内容未变不重写，prototype L328 语义）
//   自注册：import 本模块即把七个类型 registerShape 进 registry（M03），renderShape 可直接分发。
// esc/setHTML 经 registry 共享（registry 自身探测 M01 utils.js，未落地时本地兜底，同 M03 模式）。
import { esc, setHTML, registerShape, renderShape } from './registry.js';

const arr = (v) => (Array.isArray(v) ? v : []);

// ---- checklist：完成态可区分（PRD §10.3；plan M04「含完成态」）----
export function checklist(block) {
  const items = arr(block && block.items);
  return `<ul class="checklist">${items.map((it) => {
    const text = esc(it && it.text != null ? it.text : '');
    const done = !!(it && it.done);
    return `<li class="${done ? 'done' : 'todo'}"><span class="box" aria-hidden="true">${done ? '✓' : ''}</span><span class="tx">${text}</span></li>`;
  }).join('')}</ul>`;
}

// ---- timeline：横向刻度 + 事件点；you 触点高亮（prototype 分镜事件形状 L415-418）----
export function timeline(block) {
  const items = arr(block && block.items);
  return `<ol class="timeline">${items.map((it) => {
    const at = esc(it && it.at != null ? it.at : '');
    const text = esc(it && it.text != null ? it.text : '');
    const you = !!(it && it.you);
    return `<li class="ev${you ? ' you' : ''}" data-at="${at}"><time>${at}</time><span class="tx">${text}</span></li>`;
  }).join('')}</ol>`;
}

// ---- slides：缩略幻灯片（.slide 双栏 tag/title/bullets，prototype L147-151）----
const SAFE_SRC = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/; // 相对路径白名单：禁协议/绝对路径/..
export function slides(block) {
  const pages = arr(block && block.pages);
  return `<div class="slides">${pages.map((pg) => {
    const tag = pg && pg.tag != null ? esc(pg.tag) : '';
    const title = pg && pg.title != null ? esc(pg.title) : '';
    const bullets = arr(pg && pg.bullets).map((b) => `<li>${esc(b)}</li>`).join('');
    const src = pg && typeof pg.image === 'string' && SAFE_SRC.test(pg.image) && !pg.image.includes('..') ? pg.image : '';
    const pic = src ? `<div class="pic" style="background-image:url('${esc(src)}')"></div>` : '';
    return `<div class="slide"><div class="txt">${tag ? `<span class="tag">${tag}</span>` : ''}<h4>${title}</h4><ul>${bullets}</ul></div>${pic}</div>`;
  }).join('')}</div>`;
}

// ---- diffSummary：新增绿 / 删除线 / 变更黄（.add/.del/.chg，prototype L83-85 + L458）----
export function diffSummary(block) {
  const b = block || {};
  const reason = b.reason != null ? esc(b.reason) : '';
  const li = (cls, list) => arr(list).map((x) => `<li class="${cls}">${esc(x)}</li>`).join('');
  return `<div class="diffSummary">${reason ? `<p class="reason">${reason}</p>` : ''}<ul>${li('add', b.added)}${li('del', b.removed)}${li('chg', b.changed)}</ul></div>`;
}

// ---- mapRoute：路线卡（.route + .line 条目，prototype L159-161）----
export function mapRoute(block) {
  const b = block || {};
  const title = b.title != null ? esc(b.title) : '';
  return `<div class="route">${title ? `<b>${title}</b>` : ''}${arr(b.lines).map((l) => `<div class="line">${esc(l)}</div>`).join('')}</div>`;
}

// ---- personCard：会面对方背景摘要（姓名/关系/要点，PRD §5.2.2 R1）----
export function personCard(block) {
  const b = block || {};
  const name = b.name != null ? esc(b.name) : '';
  const role = b.role != null ? esc(b.role) : '';
  const notes = arr(b.notes).map((n) => `<li>${esc(n)}</li>`).join('');
  return `<div class="personCard"><p class="name">${name}</p>${role ? `<p class="role">${role}</p>` : ''}${notes ? `<ul>${notes}</ul>` : ''}</div>`;
}

// ---- sample：一页样张，Markdown 子集白名单（**b**/无序列表/段落；plan M04）----
// 规则：先整段 esc，再转 **x** → <b>x</b>，最后只放行与 <b></b> 完全一致的已转义序列；
// 白名单外标签（script/img/onerror…）一律以纯文本呈现，绝不成为可执行标记。
function sampleInline(text) {
  return String(text)
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/&lt;b&gt;/g, '<b>')
    .replace(/&lt;\/b&gt;/g, '</b>');
}
export function sample(block) {
  const raw = block && block.text != null ? String(block.text) : '';
  const out = [];
  let list = null;
  const flushList = () => { if (list) { out.push(`<ul>${list}</ul>`); list = null; } };
  for (const line of raw.split('\n')) {
    const m = /^-\s+(.*)$/.exec(line);
    if (m) { list = list || []; list.push(`<li>${sampleInline(esc(m[1]))}</li>`); continue; }
    flushList();
    if (line.trim() !== '') out.push(`<p>${sampleInline(esc(line))}</p>`);
  }
  flushList();
  return `<div class="sample">${out.join('')}</div>`;
}

export const richShapes = { checklist, timeline, slides, diffSummary, mapRoute, personCard, sample };

// ---- 组件壳：component.html 组件页契约（M02 __mount/__update；plan §1.1 mount/update 增量）----
const blocksHTML = (blocks) => arr(blocks).map((b) => renderShape(b)).join('');

export function mount(el, props) {
  const render = (p) => setHTML(el, blocksHTML(p?.blocks));
  render(props ?? {});
  return {
    update(p) {
      render(p ?? {});
      return this;
    },
  };
}

/** 别名：避免与组件页其它 mount 混淆（同 M03 mountShapes） */
export const mountRichShapes = mount;

// 自注册进 registry（M03）：import 本模块即七个类型可用 renderShape 分发
for (const [type, fn] of Object.entries(richShapes)) registerShape(type, fn);
