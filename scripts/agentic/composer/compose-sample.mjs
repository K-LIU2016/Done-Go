// W11 composer · composeSample——五模板代码排版样张（BUILD-PLAN §3 W11.2、PRD §5.2.2/§10.3）。
// sample（PRD §10.3 samples[] 条目）+ image（缓存后的 { url }，可 null=配图 pending）→ 自有
// 模板 HTML 片段。所有文字进 HTML 节点由代码排版，配图只做背景/插图位；「示意」水印在
// .frame 内以 <span class="wm"> 叠加（prototype.html:146,371），绝不改写缓存原图。
// 未知 layout 降级为纯文本卡（同 PRD §10.3 组件目录「未知类型降级为纯文本」），绝不抛错。
import { escapeAttr, escapeHtml } from './html.mjs';
import { renderSlide } from './templates/slide.mjs';
import { renderReportCover } from './templates/report-cover.mjs';
import { renderActivityCard } from './templates/activity-card.mjs';
import { renderProductCard } from './templates/product-card.mjs';
import { renderRouteCard } from './templates/route-card.mjs';

/** layout → 模板渲染器（渲染 .frame 内的内容）。 */
const TEMPLATES = {
  'slide-title-bullets-image': renderSlide,
  'report-cover': renderReportCover,
  'activity-card': renderActivityCard,
  'product-card': renderProductCard,
  'route-card': renderRouteCard,
};

/**
 * 降级纯文本卡：未知 layout / 未来新增形态的安全网。标题加粗 + 把 bullets/steps/lines
 * 任何一种列表字段统一铺成 <ul>——文字仍然全部可见、全部转义，只是不套已知模板的壳
 * （不得伪装成 slide/cover/route，宿主页与测试据此区分形态）。
 */
function renderFallback(sample) {
  const t = sample.text ?? {};
  const items = ['bullets', 'steps', 'lines']
    .flatMap(key => (Array.isArray(t[key]) ? t[key] : []))
    .filter(x => x !== undefined && x !== null && x !== '');
  const b = t.title !== undefined && t.title !== null && t.title !== '' ? `<b>${escapeHtml(t.title)}</b>` : '';
  const ul = items.length ? `<ul>${items.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : '';
  return `<div class="plain">${b}${ul}</div>`;
}

/**
 * composeSample(sample, image) → HTML 片段（<figure class="samp">…</figure>，对照
 * prototype.html:371 的外壳，外加 data-layout 形态标记）。纯函数、零 IO、零网络。
 */
export function composeSample(sample, image) {
  const s = sample ?? {};
  const render = TEMPLATES[s.layout] ?? renderFallback;
  const body = render(s, image ?? null);
  const wm = escapeHtml(s.watermark ?? '示意');
  return `<figure class="samp" data-layout="${escapeAttr(s.layout ?? 'unknown')}"><div class="frame">${body}<span class="wm">${wm}</span></div><figcaption>${escapeHtml(s.page)}</figcaption></figure>`;
}
