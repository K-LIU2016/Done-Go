// W11 composer · 模板④成品效果图卡（product-card，PRD §5.2.2 R3「成品效果图 + 步骤卡」）。
// 复用 prototype .cover 的上图下字骨架（追加 prod 标记类）：成品图占主体（唯一以图为主的
// 模板），标题/副题仍在 .meta 里代码排版——图只表达「长什么样」，不承载任何文字信息。
import { escapeHtml, picDiv } from '../html.mjs';

/** 渲染 .frame 内的成品效果图卡内容：大配图 + meta（标题/可选副题）。 */
export function renderProductCard(sample, image) {
  const t = sample.text ?? {};
  const sub = t.subtitle ? `<span class="small muted">${escapeHtml(t.subtitle)}</span>` : '';
  return `<div class="cover prod">${picDiv(image)}<div class="meta"><b>${escapeHtml(t.title)}</b>${sub}</div></div>`;
}
