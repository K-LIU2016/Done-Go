// M08 样张画廊 —— 预演 tab 的样张陈列（L1 样，PRD §5.2.1）
// 结构照 prototype.html（唯一视觉标准）：
//   div.gallery（prototype L141/L405 容器）> figure.samp（L142-143）
//     > .frame（L144：4:3 圆角框，比例本体在 M01 agentic.css）
//         > 四模板之一 + span.wm「示意」（L146：右下半透明水印）
//     > figcaption 说明（L143）
// 四模板（prototype L366-370 sampleHTML 分支）：
//   cover（L153-157/L370：.cover = .pic 配图 + .meta{b 标题 + .small.muted 副题 + .nums 数字行}）
//   slide（L147-152/L369：.slide 双栏 = .txt{.tag + h4 + ul 要点} + .pic 配图 —— 文字由代码排版）
//   img（L367：纯 <img> —— 整页由生图模型生成；与 slide 并列即"代码排版 vs 整页生成"对照）
//   route（L159-161/L370：.route = b 标题 + .line 条目行）
// 规则（PRD §5.2.1）：
//   - 示意标注：所有生成画面右下角标"示意"（P1 诚实原则），每帧必备、位置固定模板之后；
//   - 文字不交给生图：slide/cover 的标题要点由代码排版（本模板），img 仅作对照并列展示；
//   - 图片仅 ui/assets/ 相对路径白名单（plan §1.7）：裸文件名补 assets/ 前缀（prototype ASSET
//     L353 语义），协议/绝对路径/../data: 一律拒绝——拒绝即不输出该图片节点，绝不写进 src/style。
// 分层：纯核（HTML 字符串纯函数，node --test 可测）+ DOM 壳 mount/update。
// 增量（PRD §5.2 末教训 + DAG M08「update 换样张不整绘」）：
//   同内容 update 零写；同数量换内容只逐 figure 打补丁（figure 节点身份保留）；
//   变数量/补不了才整绘。

// M01 utils.js 已落地为硬依赖：esc/setHTML 直引共享实现，单一来源
//（并行落地期的「动态探测 + 本地同规则兜底」已收编，组件顶层 await 随之移除）。
import { esc, setHTML } from './utils.js';

export { esc, setHTML }; // 保持既有 re-export 导入面（单测/组件页按组件模块导入）

const arr = (v) => (Array.isArray(v) ? v : []);

/** 水印文案（PRD §5.2.1：所有生成画面右下角标"示意"） */
export const WATERMARK = '示意';

/** 图片白名单根：样张配图只允许 ui/assets/ 相对路径（plan §1.7） */
export const ASSET_PREFIX = 'assets/';
const SAFE_ASSET = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/; // 禁协议/冒号/问号/井号；首字符须文件名安全

/**
 * 样张图片 URL 白名单：裸相对文件名补 assets/ 前缀（prototype ASSET L353），已带前缀原样；
 * 协议（http:/data:/javascript:）、绝对路径（/…、//…）、路径穿越（..）、空名一律拒绝返回 ''。
 */
export function assetURL(src) {
  if (typeof src !== 'string' || src === '') return '';
  let path = src;
  if (!path.startsWith(ASSET_PREFIX)) {
    if (path.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) return '';
    path = ASSET_PREFIX + path;
  }
  const rest = path.slice(ASSET_PREFIX.length);
  if (rest === '' || !SAFE_ASSET.test(rest) || path.includes('..')) return '';
  return path;
}

/** 配图节点：URL 过白名单才输出（prototype L369/370 .pic，背景图不写非法 URL） */
function picHTML(src) {
  const url = assetURL(src);
  return url ? `<div class="pic" style="background-image:url('${esc(url)}')"></div>` : '';
}

// 缺省内容 = prototype 黄金场景硬编码（L369-370）：只给 kind/cap 也完整还原原型视觉；
// 字段（title/tag/bullets/sub/nums/lines/pic/src）可由 fixtures/上游 Preview 覆盖。
export const DEFAULT_CONTENT = {
  cover: {
    pic: 'illus-lesson.jpg',
    title: 'AI 教育现状与趋势',
    sub: '研究报告 · 约 3000 字',
    nums: [['5', '节'], ['7–12', '引用'], ['100%', '结论挂来源']],
  },
  slide: {
    pic: 'illus-lesson.jpg',
    tag: 'AI 进课堂 · 第 2 课时',
    title: '用 AI 备课：提示词与核对',
    bullets: ['让 AI 生成 3 个导入问题', '对照课标逐条核对，删掉不准的', '1 分钟说"AI 帮了哪、错在哪"'],
  },
  route: {
    title: '18:25 出发 · 地铁 32 分钟',
    lines: ['家 → 2 号线 → 静安寺站 3 口', '步行 6 分钟到「小南国」', '带上：上次借的书', '要点：小王在找新工作；聊 Argus 合作'],
  },
};

/** 数字行条目：兼容 [值,标签] 数组与 {v,label} 对象（prototype L157 <span><i>v</i>label</span>） */
function numHTML(n) {
  if (!Array.isArray(n) && typeof n !== 'object') return '';
  const v = Array.isArray(n) ? n[0] : n.v;
  const label = Array.isArray(n) ? n[1] : n.label;
  return `<span><i>${esc(v ?? '')}</i>${esc(label ?? '')}</span>`;
}

/** cover 模板：报告封面/首页（.cover = .pic + .meta，prototype L153-157/L370） */
export function coverHTML(sample) {
  const sm = sample ?? {};
  const d = DEFAULT_CONTENT.cover;
  const nums = arr(sm.nums).length ? arr(sm.nums) : d.nums;
  return `<div class="cover">${picHTML(sm.pic ?? d.pic)}<div class="meta">`
    + `<b>${esc(sm.title ?? d.title)}</b>`
    + `<span class="small muted">${esc(sm.sub ?? d.sub)}</span>`
    + `<div class="nums">${nums.map(numHTML).join('')}</div>`
    + `</div></div>`;
}

/** slide 模板：幻灯片页（.slide 双栏 .txt+.pic，文字代码排版，prototype L147-152/L369） */
export function slideHTML(sample) {
  const sm = sample ?? {};
  const d = DEFAULT_CONTENT.slide;
  const tag = sm.tag ?? d.tag;
  const bullets = arr(sm.bullets).length ? arr(sm.bullets) : d.bullets;
  return `<div class="slide"><div class="txt">`
    + (tag ? `<span class="tag">${esc(tag)}</span>` : '')
    + `<h4>${esc(sm.title ?? d.title)}</h4>`
    + `<ul>${bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`
    + `</div>${picHTML(sm.pic ?? d.pic)}</div>`;
}

/** img 模板：整页生成图（纯 <img>，prototype L367）；src 过不了白名单不输出 */
export function imgHTML(sample) {
  const url = assetURL(sample?.src);
  return url ? `<img src="${esc(url)}" alt="">` : '';
}

/** route 模板：行前简报卡（.route = b 标题 + .line 条目，prototype L159-161/L370） */
export function routeHTML(sample) {
  const sm = sample ?? {};
  const d = DEFAULT_CONTENT.route;
  const title = sm.title ?? d.title;
  const lines = arr(sm.lines).length ? arr(sm.lines) : d.lines;
  return `<div class="route">${title ? `<b>${esc(title)}</b>` : ''}`
    + lines.map((l) => `<div class="line">${esc(l)}</div>`).join('')
    + `</div>`;
}

const TEMPLATES = { cover: coverHTML, slide: slideHTML, img: imgHTML, route: routeHTML };

/** 模板内容 + 统一水印（frame 内核；patch 与 frameHTML 同一来源） */
export function frameInner(sample) {
  const tpl = TEMPLATES[sample?.kind];
  return `${tpl ? tpl(sample) : ''}<span class="wm">${WATERMARK}</span>`;
}

/** .frame 外壳（4:3 比例本体在 M01 agentic.css L144） */
export function frameHTML(sample) {
  return `<div class="frame">${frameInner(sample)}</div>`;
}

/**
 * 说明文字：esc 后仅放行完整 <b>…</b> 对（prototype L368 cap 含 <b>；M04 sample 白名单规则）。
 * 配对放行：开标签必须是整串 <b>（带属性不放行）；闭标签仅在存在未闭合的白名单开标签时放行，
 * 孤立/非白名单的 </b> 保持转义，绝不从非白名单输入产出真实标记。
 */
export function capHTML(sample) {
  const escaped = esc(sample?.cap ?? ''); // 五实体转义同 ESC_MAP（共享 esc，单一来源）
  let out = '';
  let open = false;
  let i = 0;
  while (i < escaped.length) {
    if (!open && escaped.startsWith('&lt;b&gt;', i)) { out += '<b>'; open = true; i += 9; continue; }
    if (open && escaped.startsWith('&lt;/b&gt;', i)) { out += '</b>'; open = false; i += 10; continue; }
    out += escaped[i];
    i += 1;
  }
  return out;
}

/** 单样张：figure.samp > .frame(模板+示意水印) + figcaption（prototype L372 原样） */
export function sampleHTML(sample) {
  return `<figure class="samp">${frameHTML(sample)}<figcaption>${capHTML(sample)}</figcaption></figure>`;
}

/** 样张序列（无容器）：null/undefined 条目过滤（M05 listHTML 同规则） */
export function figuresHTML(samples) {
  return arr(samples).filter(Boolean).map(sampleHTML).join('');
}

/** 带容器整廊：<div class="gallery">…</div>（prototype L405；mount 直挂宿主时由宿主任意携带） */
export function galleryHTML(samples) {
  return `<div class="gallery">${figuresHTML(samples)}</div>`;
}

/** 样张集合签名：变了才动 DOM（同签名零写） */
function signature(samples) {
  return samples.filter(Boolean).map((s) => JSON.stringify(s)).join('\u0001');
}

/**
 * 逐 figure 打补丁：数量一致时只 setHTML 各自 .frame/.figcaption（内容比对，同内容跳过），
 * figure 节点永不重建（换样张不整绘）。返回 false = 补不了（数量变/容器查不到/子节点被剥），
 * 由调用方兜底整绘。空集合恒 false（清空交给整绘）。
 */
function patchFigures(el, samples) {
  if (typeof el?.querySelectorAll !== 'function' || samples.length === 0) return false;
  const figs = el.querySelectorAll('figure.samp');
  if (!figs || figs.length !== samples.length) return false;
  for (let i = 0; i < samples.length; i += 1) {
    const fig = figs[i];
    if (!fig || typeof fig.querySelector !== 'function') return false;
    const frame = fig.querySelector('.frame');
    const cap = fig.querySelector('figcaption');
    if (!frame || !cap) return false; // 宿主 DOM 被外部剥壳 → 兜底整绘，不静默丢更新
    setHTML(frame, frameInner(samples[i]));
    setHTML(cap, capHTML(samples[i]));
  }
  return true;
}

/**
 * DOM 壳（组件页 ?c=gallery / demo 装配）：mount(el, props) → handle。
 * props = { samples }；update(props) 合并语义（未传键不动旧值），链式返回 handle。
 * 增量：同签名零写 → 同数量打补丁（figure 身份保留）→ 变数量/补不了整绘（setHTML 内容比对）。
 */
export function mount(el, props) {
  const state = { samples: [] };
  let sig = null;

  const merge = (p) => {
    if (!p || typeof p !== 'object') return;
    if ('samples' in p) state.samples = Array.isArray(p.samples) ? p.samples : [];
  };

  const apply = (p) => {
    merge(p);
    const usable = state.samples.filter(Boolean);
    const next = signature(usable);
    if (next === sig) return; // 同集合：零写（外部自定义属性/图片加载态不丢）
    if (patchFigures(el, usable)) {
      sig = next;
      return;
    }
    sig = next;
    setHTML(el, figuresHTML(usable));
  };

  if (el && el.classList && typeof el.classList.add === 'function') el.classList.add('gallery');

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
