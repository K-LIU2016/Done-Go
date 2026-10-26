// W11 composer · 时间轴合成——由 storyboard（PRD §10.3：at/actor/text，可带 image/kind/sampleId）
// 与旁白字幕时间戳（tts 契约 subtitles.mjs 输出 [{text,startSec,endSec}]）合成镜头序列。
// 依据 BUILD-PLAN §3 W11.2：HyperFrames 兼容的 data-start/data-duration/data-track 时间轴
// （分镜、样张翻页、配图 Ken Burns、字幕）；durationSec 来自旁白音频总时长（调用方传入）。
// 不变量（单测逐条锁死）：画面轨道铺满 [0, durationSec) 不重叠不漏秒——旁白句数与分镜数
// 一致时镜头边界跟随字幕 start（尾部静音归末镜），否则按 durationSec 均分；字幕自成 caption
// 轨道，与画面 visual 轨道永不混轨。纯函数、零依赖、零 IO。

/** data-* 数值输出：四舍五入到毫秒精度再转字符串，去掉浮点尾噪（10/3 → "3.333"）。 */
const cleanNum = v => String(Math.round(Number(v) * 1000) / 1000);

/**
 * 把时间轴元素序列化成 HyperFrames 兼容属性串：
 * dataAttrs({start,duration,track,kind?}) → ' data-start="…" data-duration="…" data-track="…" data-kind="…"'
 * 顺序固定 start/duration/track（+可选 kind），播放器端（web/agentic/reel/player.js 的
 * parseTimeline）按同名 data 属性逆向解析。
 */
export function dataAttrs(el) {
  const e = el ?? {};
  const attrs = [
    `data-start="${cleanNum(e.start)}"`,
    `data-duration="${cleanNum(e.duration)}"`,
    `data-track="${String(e.track)}"`,
  ];
  if (e.kind !== undefined && e.kind !== null) attrs.push(`data-kind="${String(e.kind)}"`);
  return attrs.join(' ');
}

/** 数值守卫：有限且 ≥0 才可用（字幕契约损坏时按无旁白处理，不让 NaN 进时间轴）。 */
const okSec = v => Number.isFinite(v) && v >= 0;

/**
 * 画面镜头切分。n 个分镜 → n 个 [start,duration]：
 * - 旁白句数 === 分镜数且 startSec 单调不降、末句 start < durationSec：边界 = [0, 各句 startSec…, durationSec]
 *   （首镜强制从 0 起，末镜收到旁白音频总时长）；
 * - 其余（数目不匹配 / 空旁白 / 边界非法）：durationSec 均分，start 逐镜累加保证首尾相接。
 * 两条路径都保证铺满 [0, durationSec)：不重叠、不漏秒。
 */
function splitShots(n, subtitles, durationSec) {
  if (n <= 0 || !(durationSec > 0)) {
    return Array.from({ length: Math.max(n, 0) }, () => ({ start: 0, duration: 0 }));
  }
  const usable = subtitles.length === n
    && subtitles.every(s => okSec(s?.startSec))
    && subtitles.every((s, i) => i === 0 || s.startSec >= subtitles[i - 1].startSec)
    && subtitles[n - 1].startSec < durationSec;
  if (usable) {
    const bounds = [0];
    for (let i = 1; i < n; i += 1) bounds.push(Math.max(subtitles[i].startSec, bounds[i - 1]));
    return bounds.map((start, i) => ({ start, duration: (i === n - 1 ? durationSec : bounds[i + 1]) - start }));
  }
  const out = [];
  let at = 0;
  const per = durationSec / n;
  for (let i = 0; i < n; i += 1) {
    out.push({ start: at, duration: per });
    at += per;
  }
  return out;
}

/**
 * buildTimeline({storyboard, subtitles, durationSec}) → {durationSec, tracks:{visual,caption}, elements}。
 * - visual 轨道：分镜配图（kind:'shot'，有 image 时标 kb:true → Ken Burns）与样张翻页
 *   （kind:'sample'，携带 sampleId，样张文字由代码排版、无图不做 Ken Burns）；
 * - caption 轨道：字幕逐句 {kind:'caption'}，start/duration 直取 startSec/endSec；
 * - elements：两轨按 start 归并排序（播放器与数据岛共用一份）。
 * durationSec 缺省时用字幕最晚 endSec 兜底（调用方应为旁白音频实测总时长）。
 */
export function buildTimeline({ storyboard, subtitles, durationSec } = {}) {
  const board = Array.isArray(storyboard) ? storyboard : [];
  const subs = Array.isArray(subtitles) ? subtitles : [];
  const audioEnd = subs.reduce((m, s) => Math.max(m, Number(s?.endSec) || 0), 0);
  const total = Number.isFinite(Number(durationSec)) && durationSec >= 0 ? durationSec : audioEnd;

  const spans = splitShots(board.length, subs, total);
  const visual = board.map((entry, i) => {
    const isSample = entry?.kind === 'sample';
    const shot = {
      ...entry,
      start: spans[i].start,
      duration: spans[i].duration,
      track: 'visual',
      kind: isSample ? 'sample' : 'shot',
      kb: Boolean(entry?.image),
    };
    if (!isSample) delete shot.sampleId;
    return shot;
  });

  const caption = subs
    .filter(s => okSec(s?.startSec) && okSec(s?.endSec) && s.endSec >= s.startSec)
    .map(s => ({
      kind: 'caption',
      track: 'caption',
      start: s.startSec,
      duration: s.endSec - s.startSec,
      text: s.text,
    }));

  const elements = [...visual, ...caption].sort((a, b) => a.start - b.start);
  return { durationSec: total, tracks: { visual, caption }, elements };
}
