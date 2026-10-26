// W11 composer · 模板②报告首页/封面（report-cover，PRD §5.2.2 D1「封面 + 目录页 + 关键数字」）。
// 结构与类名对照 prototype.html:370 的 .cover：上 .pic 下 .meta（b 标题 / small muted 副题 /
// nums 关键数字行）。数字进 <i> 节点由代码排版（数字信息图的最小形态），绝不靠生图写数字。
import { escapeHtml, picDiv } from '../html.mjs';

/** 渲染 .frame 内的报告封面内容。nums 每项 { n, label }：数字代码排版，label 紧随其后。 */
export function renderReportCover(sample, image) {
  const t = sample.text ?? {};
  const sub = t.subtitle ? `<span class="small muted">${escapeHtml(t.subtitle)}</span>` : '';
  const nums = (Array.isArray(t.nums) ? t.nums : [])
    .filter(x => x && (x.n !== undefined && x.n !== null))
    .map(({ n, label }) => `<span><i>${escapeHtml(n)}</i>${escapeHtml(label)}</span>`);
  const numsRow = nums.length ? `<div class="nums">${nums.join('')}</div>` : '';
  return `<div class="cover">${picDiv(image)}<div class="meta"><b>${escapeHtml(t.title)}</b>${sub}${numsRow}</div></div>`;
}
