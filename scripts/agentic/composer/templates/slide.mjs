// W11 composer · 模板①幻灯片（slide-title-bullets-image，PRD §5.2.2 D2「2–3 页幻灯片样张」）。
// 结构与类名对照 prototype.html:369 的 .slide：左 .txt（tag/h4/ul）右 .pic，文字全代码排版，
// 配图只做右栏背景。全部动态值经 html.mjs 转义后进入 HTML。
import { escapeHtml, picDiv } from '../html.mjs';

/** 非空字符串项过滤 + 转义：bullets 里混入 null/undefined/空串时静默跳过，不渲染空 <li>。 */
const li = items => (Array.isArray(items) ? items : [])
  .filter(x => x !== undefined && x !== null && x !== '')
  .map(x => `<li>${escapeHtml(x)}</li>`);

/** 渲染 .frame 内的幻灯片内容。image 为 null（配图 pending）时自然降级为纯排版。 */
export function renderSlide(sample, image) {
  const t = sample.text ?? {};
  const tag = t.tag ? `<span class="tag">${escapeHtml(t.tag)}</span>` : '';
  const items = li(t.bullets);
  const ul = items.length ? `<ul>${items.join('')}</ul>` : '';
  return `<div class="slide"><div class="txt">${tag}<h4>${escapeHtml(t.title)}</h4>${ul}</div>${picDiv(image)}</div>`;
}
