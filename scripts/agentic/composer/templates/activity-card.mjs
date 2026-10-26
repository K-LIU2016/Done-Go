// W11 composer · 模板③活动卡（activity-card，PRD §5.2.2 D2「1 张活动卡」）。
// 复用 prototype .slide 的左字右图骨架（追加 act 标记类便于宿主页加样式）：步骤用有序列表
// <ol class="steps"> 排版——活动卡的核心是「几步、每步做什么」，顺序即语义，必须代码排版。
import { escapeHtml, picDiv } from '../html.mjs';

/** 渲染 .frame 内的活动卡内容：tag 可选、title、steps 有序列表、右栏配图。 */
export function renderActivityCard(sample, image) {
  const t = sample.text ?? {};
  const tag = t.tag ? `<span class="tag">${escapeHtml(t.tag)}</span>` : '';
  const steps = (Array.isArray(t.steps) ? t.steps : [])
    .filter(x => x !== undefined && x !== null && x !== '')
    .map(x => `<li>${escapeHtml(x)}</li>`);
  const ol = steps.length ? `<ol class="steps">${steps.join('')}</ol>` : '';
  return `<div class="slide act"><div class="txt">${tag}<h4>${escapeHtml(t.title)}</h4>${ol}</div>${picDiv(image)}</div>`;
}
