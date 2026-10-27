// W11 composer · HTML 安全工具——安全门禁「HTML 模板转义」（BUILD-PLAN §3 W11.6）的唯一落点。
// 依据：PRD §10.3「reel.composition 是我们自有模板渲染出的 HTML，agent 只提供数据不提供 HTML」
// ——文字全部由代码排版，意味着用户/AI 文本会进入我们的 HTML，必须先经这里的转义。
// composer 全部模板（五模板 + 留桩 export）只准经由本文件把动态值放进 HTML，禁止内联拼接裸字符串。
// 照 voice-pipeline 的风格：纯函数、零依赖、可独立单测。

/** 五个 HTML 元字符 → 实体。& 必须最先替换（这里用单次正则遍历，天然无二次转义问题）。 */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * 文本转义：neutralize < > & " '，CJK 与其余字符原样保留。
 * undefined/null → ''（模板里缺字段的兜底，绝不渲染出 "undefined"）。
 */
export function escapeHtml(value) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/[&<>"']/g, ch => ESCAPES[ch]);
}

/**
 * 属性转义：值会落进双引号属性（style/data-*）。转义集与 escapeHtml 相同——
 * 双引号必转（断属性逃逸），单引号也转（防值被嵌进单引号 CSS url('…') 上下文后破壳）。
 */
export function escapeAttr(value) {
  return escapeHtml(value);
}

/** 单个 class token 的合法形状：字母开头，仅字母/数字/-/_。前缀与名都套用同一形状。 */
const CLASS_TOKEN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * class 前缀作用域：scopeClass('dg', 'slide') → 'dg-slide'。
 * 拒绝带空格/引号等注入形状的 token（'slide wm'、'slide"onclick="x'）——
 * class 属性不是文本上下文，任何分裂成多 token 或带引号的输入都是攻击面，直接抛错。
 */
export function scopeClass(prefix, name) {
  if (!CLASS_TOKEN.test(String(prefix ?? ''))) throw new Error(`invalid class prefix: ${prefix}`);
  if (!CLASS_TOKEN.test(String(name ?? ''))) throw new Error(`invalid class name: ${name}`);
  return `${prefix}-${name}`;
}

/**
 * 配图位：image.url 原样引用（缓存键即 URL，绝不改写/重编码原图——「示意」水印由模板
 * 在 .frame 内叠加 DOM，不烤进图里）。URL 经 escapeAttr 落进双引号 style 属性。
 * image 为 null/pending 或没有 url 时返回 ''，模板侧自然降级为纯排版卡。
 */
export function picDiv(image) {
  const url = image && typeof image === 'object' ? image.url : null;
  if (!url) return '';
  return `<div class="pic" style="background-image:url('${escapeAttr(url)}')"></div>`;
}
