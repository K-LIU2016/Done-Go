// W11 composer · 模板⑤路线卡（route-card，PRD §5.2.2 R1/R2「路线、出发时刻/时间轴」）。
// 结构与类名对照 prototype.html:370 的 .route：出发时刻做 <b> 标题，行程/提醒逐条 .line
// （圆点伪元素由宿主页 CSS 画）。纯排版模板：不引配图，信息密度优先（对照 prototype，行前
// 简报卡没有图位）。
import { escapeHtml } from '../html.mjs';

/** 渲染 .frame 内的路线卡内容。image 参数存在但被有意忽略：route 形态无图位（见文件头）。 */
export function renderRouteCard(sample, _image) {
  const t = sample.text ?? {};
  const lines = (Array.isArray(t.lines) ? t.lines : [])
    .filter(x => x !== undefined && x !== null && x !== '')
    .map(x => `<div class="line">${escapeHtml(x)}</div>`);
  return `<div class="route"><b>${escapeHtml(t.title)}</b>${lines.join('')}</div>`;
}
