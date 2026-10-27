// W11 composer · composeReel——把 Preview JSON 合成自包含预演片 HTML（BUILD-PLAN §3 W11.2、
// PRD §5.2.1 L2 / §10.3）。边界（PRD §10.3 字段约束原文）：reel.composition 是我们自有模板
// 渲染出的 HTML，agent 只提供数据、不提供 HTML——本文件就是「自有模板」的唯一实现，输入里
// 任何文字都经 html.mjs 转义 / 数据岛 \u003c 转义后落盘，agent 无法借道注入标记。
//
// 与播放器的契约：本文档只产出数据与静态骨架——每个镜头/字幕带 HyperFrames 兼容的
// data-start/data-duration/data-track（+data-kind/data-sample-id）属性，另有
// <script type="application/json"> 数据岛内联同一份时间轴；播放器（web/agentic/reel/player.js，
// Web Animations + 旁白 <audio> 主时钟 + reduced-motion 降级）按这些 data 属性接管 DOM。
// 不内联任何外链脚本/样式（自包含），视觉规格逐条对照 prototype.html:165-185：
// 16:9 stage、.prog 进度条、.shot 交叉过渡 opacity .6s、配图 Ken Burns kb 7s ease-out
// scale 1.09、.cap 字幕条 aria-live=polite、右下角「示意」水印。
import { escapeAttr, escapeHtml } from './html.mjs';
import { buildTimeline, dataAttrs } from './timeline.mjs';
import { composeSample } from './compose-sample.mjs';

/** 秒 → m:ss 字幕时间标签（播放前可见的静态提示，播放中由播放器驱动）。 */
const mmss = sec => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/** 数据岛安全化：JSON 里 < 与行分隔符转 \uXXXX，防 </script> 截断；JSON.parse 原样还原。 */
const islandJson = payload => JSON.stringify(payload)
  .replace(/</g, '\\u003c')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');

/** 样式：与 prototype.html:165-185 同一套取值；末尾 reduced-motion 全局降级为分步静态。 */
const STYLE = `
.reel{position:fixed;inset:0;z-index:40;background:rgba(12,18,15,.86);display:grid;place-items:center;padding:16px;}
.reel>div{width:min(960px,100%);}
.stage{position:relative;width:100%;aspect-ratio: 16 / 9;border-radius:16px;overflow:hidden;background:#000;}
.prog{position:absolute;left:0;top:0;height:3px;background:#4D7699;width:0;z-index:2;}
.shot{position:absolute;inset:0;opacity:0;transition:opacity .6s;}
.shot.on{opacity:1;}
.shot img{width:100%;height:100%;object-fit:cover;}
.shot.on img{animation:kb 7s ease-out forwards;}
@keyframes kb{from{transform:scale(1) translate(0,0);}to{transform:scale(1.09) translate(-2%,-1%);}}
.shot .samp{width:100%;height:100%;margin:0;}
.shot .frame{aspect-ratio:auto;height:100%;}
.plain{position:absolute;inset:0;display:grid;place-content:center;gap:8px;text-align:center;padding:0 8%;color:#fff;background:radial-gradient(circle at 50% 40%,#22302A,#0C120F);}
.plain small{font-size:12px;letter-spacing:.08em;opacity:.75;}
.plain b{font:600 clamp(16px,3vw,24px)/1.4 var(--font-sans,sans-serif);}
.wm{position:absolute;right:8px;bottom:6px;font-size:11px;color:#fff;background:rgba(0,0,0,.38);border-radius:6px;padding:1px 6px;letter-spacing:.1em;}
.cap{position:absolute;left:0;right:0;bottom:0;padding:18px 22px 20px;color:#fff;background:linear-gradient(transparent,rgba(0,0,0,.72));font-size:clamp(14px,2.2vw,19px);}
.cap small{display:block;opacity:.75;font-size:12px;margin-bottom:2px;letter-spacing:.08em;}
@media (prefers-reduced-motion: reduce){*,*::before,*::after{animation:none !important;transition:none !important;}}
`;

/** 无配图分镜：文字全代码排版（PRD §5.2「文字不交给生图」），时间标签用 at/actor 原话。 */
function plainShot(el) {
  const label = [el.at, el.actor].filter(x => x !== undefined && x !== null && x !== '').map(escapeHtml).join(' · ');
  return `<div class="plain">${label ? `<small>${label}</small>` : ''}<b>${escapeHtml(el.text)}</b></div>`;
}

/** 单个画面轨道元素 → .shot 节点。样张翻页复用 composeSample 的模板（镜头复用样张模板）；配图镜头标 Ken Burns。 */
function shotDiv(el, samplesById) {
  if (el.kind === 'sample') {
    const sample = samplesById.get(el.sampleId);
    const body = sample ? composeSample(sample, sample.image ?? null) : plainShot(el);
    return `<div class="shot"${dataAttrs(el)} data-sample-id="${escapeAttr(el.sampleId)}">${body}</div>`;
  }
  if (el.image) {
    return `<div class="shot"${dataAttrs(el)}><img src="${escapeAttr(el.image)}" alt="${escapeAttr(el.text)}"><span class="wm">示意</span></div>`;
  }
  return `<div class="shot"${dataAttrs(el)}>${plainShot(el)}</div>`;
}

/**
 * composeReel(preview) → 自包含 HTML 字符串。
 * preview 取 PRD §10.3 的 missionId/version/samples/storyboard（subtitles+durationSec 为
 * tts 契约注入）/narrationAudio；subtitles/durationSec 缺省时按空旁白处理（时间轴仍完整成形）。
 * 纯函数、零 IO、零网络——音频与图片只引用 URL，由宿主环境解析。
 */
export function composeReel(preview) {
  const p = preview ?? {};
  const samples = Array.isArray(p.samples) ? p.samples : [];
  const samplesById = new Map(samples.filter(s => s && s.id != null).map(s => [s.id, s]));
  const tl = buildTimeline({ storyboard: p.storyboard, subtitles: p.subtitles, durationSec: p.durationSec });

  const shots = tl.tracks.visual.map(el => shotDiv(el, samplesById)).join('\n');
  const caps = tl.tracks.caption
    .map(c => `<div class="cap"${dataAttrs(c)} aria-live="polite"><small>${mmss(c.start)}</small>${escapeHtml(c.text)}</div>`)
    .join('\n');
  const audio = p.narrationAudio
    ? `<audio id="reel-audio" src="${escapeAttr(p.narrationAudio)}" preload="auto"></audio>`
    : '';
  const island = islandJson({
    missionId: p.missionId ?? null,
    version: p.version ?? null,
    durationSec: tl.durationSec,
    narrationAudio: p.narrationAudio ?? null,
    elements: tl.elements,
  });

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>预演片 ${escapeHtml(p.missionId ?? '')} v${escapeHtml(p.version ?? '')}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="reel"><div>
<div class="stage" role="figure" aria-label="预演片 ${escapeHtml(p.missionId ?? '')}，共 ${mmss(tl.durationSec)}">
<div class="prog"></div>
${shots}
${caps}
</div>
${audio}
</div></div>
<script type="application/json" id="reel-data">${island}</script>
</body>
</html>`;
}
