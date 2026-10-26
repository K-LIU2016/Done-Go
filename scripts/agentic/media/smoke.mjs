// W11 golden-smoke · 黄金场景真实冒烟（BUILD-PLAN §3 W11.5、PRD §3.2/§5.2/§10.3）。
// 黄金场景 = PRD §3.2「课程是给初中老师的 4 课时工作坊」：为课程设计生成 2 页幻灯片样张
// （z-image-turbo 纯画面，prompt 声明不要出现任何文字）→ composeSample；旁白文本 → tts
// 离线合成 wav+字幕 → composeReel 自包含预演片 → 本流端口段静态服务 → Playwright（flock
// 全局锁）截图存 design/schedule-to-delivery/shots/w11/；可选 1 段 happyhorse-1.1-t2v
// 真实生视频（超时受控）。真实外呼只发生在 runGoldenSmoke()（默认工厂）——全部依赖可注入，
// 单测 mock 网关/TTS/截图，绝不真实外呼（红线 §2.3）。
//
// 配额（BUILD-PLAN §2.3 红线）：生图 ≤20、生视频 ≤2。SMOKE_BUDGET 是冒烟自己的约束，
// 与产品每日预算（quota.mjs 默认 30/3）是两组数字；真实调用次数/耗时/模型全部记入
// 台账 ledger.json（summarizeLedger 汇总），key 只经注入或 env DONEGO_GATEWAY_KEY
// 运行时读取，绝不打印/落盘。
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createImageClient, PURE_IMAGE_MODEL } from './image-client.mjs';
import { createVideoClient } from './video-client.mjs';
import { createMediaCache, createDailyQuota } from './index.mjs';
import { composeSample } from '../composer/compose-sample.mjs';
import { composeReel } from '../composer/compose-reel.mjs';
import { modelsAvailable, createTtsEngine, synthesizeNarration } from '../tts/engine.mjs';

/** 冒烟预算（BUILD-PLAN §2.3：生图 ≤20、生视频 ≤2）。images=2 页样张 + 1 张可选
 *  qwen-image-2.0 图中文字对比；videos=1 段可选场景片。缓存命中不计真实外呼。 */
export const SMOKE_BUDGET = { images: 3, videos: 1 };
/** 本流端口段（BUILD-PLAN §1：W11 = 17641–17649）；单测注入 [0] 用临时端口。 */
export const SMOKE_PORTS = [17641, 17642, 17643, 17644, 17645, 17646, 17647, 17648, 17649];
/** 场景片受控超时：happyhorse-1.1-t2v 实测 5 秒片段 ≈116s（PRD §2.4），给 3× 裕量。 */
export const SMOKE_VIDEO_TIMEOUT_MS = 6 * 60 * 1000;
/** Playwright 全局锁（BUILD-PLAN §2.3：同时 ≤2 个 spec 进程）。 */
export const PW_LOCK = '/tmp/donego-s2d-pw.lock';
const WORKTREE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TTS_MODEL = 'vits-piper-zh_CN-xiao_ya-medium-int8';
const SCENE_MODEL = 'happyhorse-1.1-t2v';

/**
 * 黄金场景数据（PRD §3.2 + §10.3）：初中老师 4 课时工作坊的课程设计 Mission。
 * 纯数据、零 IO——8 句旁白与 8 个分镜一一对应（timeline 据此逐句切镜），
 * 配图 prompt 全部声明「不要出现任何文字」（z-image-turbo 中文会出错字，PRD §2.4）。
 */
export function goldenScenario() {
  return {
    missionId: 'm_smoke_course',
    version: 1,
    confidence: 0.72,
    samples: [
      {
        id: 's1',
        layout: 'slide-title-bullets-image',
        page: '第 1 课时 · 首页',
        text: {
          tag: 'AI 进课堂 · 初中 4 课时工作坊',
          title: 'AI 进课堂 · 第 1 课时：认识 AI 助教',
          bullets: ['什么是 AI 助教：能做什么、不能做什么', '分组体验：用 AI 完成一个小任务', '记录边界：AI 帮了哪、错在哪'],
        },
        image: {
          prompt: '初中教室里老师和学生围在大屏前讨论，清新鼠尾草绿与暖纸色，扁平插画，不要出现任何文字',
          model: PURE_IMAGE_MODEL,
          status: 'pending',
        },
        watermark: '示意',
      },
      {
        id: 's2',
        layout: 'slide-title-bullets-image',
        page: '第 2 课时 · 首页',
        text: {
          tag: 'AI 进课堂 · 初中 4 课时工作坊',
          title: 'AI 进课堂 · 第 2 课时：用 AI 备课',
          bullets: ['用 AI 生成导入问题', '对照课标逐条核对', '说出 AI 帮了哪、错在哪'],
        },
        image: {
          prompt: '老师在教室用平板备课，清新鼠尾草绿，扁平插画，不要出现任何文字',
          model: PURE_IMAGE_MODEL,
          status: 'pending',
        },
        watermark: '示意',
      },
    ],
    storyboard: [
      { at: '13:30', actor: 'researcher', text: '检索与筛选国内 K12 来源', useImageOf: 's1' },
      { at: '14:00', actor: 'you', text: '确认学员画像（30 秒）', need: 'n_1' },
      { at: '14:50', actor: 'writer', text: '合成研究报告' },
      { at: '15:00', actor: 'deliver', text: '课程设计接力' },
      { at: '15:10', actor: 'course', text: '第 1 课时样张', kind: 'sample', sampleId: 's1' },
      { at: '15:20', actor: 'course', text: '第 2 课时样张', kind: 'sample', sampleId: 's2' },
      { at: '17:00', actor: 'deliver', text: '课程方案交付' },
      { at: '全程', actor: 'boundary', text: '边界与承诺' },
    ],
    narration: [
      '下午一点半，研究先行，我先去检索国内 K12 的 AI 教育资料。',
      '两点整，需要你花三十秒确认课程的目标学员画像。',
      '两点五十，研究报告合成完毕，存入 Done&Go 交付库。',
      '三点整，课程设计接力，聚焦初中老师的四课时工作坊。',
      '先看第 1 课时样张：认识 AI 助教，分组体验并记录边界。',
      '再看第 2 课时样张：用 AI 备课，生成导入问题并对照课标核对。',
      '五点整，你会拿到完整课程方案，含课时表与活动卡。',
      '我不会把成果发给任何人，也不会替你付费或访问邮箱。',
    ].join(''),
    scene: { status: 'off', model: SCENE_MODEL, prompt: '初中课堂现场氛围：老师用平板与学生互动，自然窗光，温暖电影感，镜头缓慢推近，画面内不出现任何文字' },
  };
}

/**
 * 组装 composeReel 的 preview（PRD §10.3 形状）：样张/分镜的配图指向本地静态服务
 * （imageUrlFor(sampleId)），旁白挂 /narration.wav，字幕与时长取 tts 实测。
 * 分镜上的 useImageOf 装配标记在此剥除（不进时间轴与数据岛）。
 */
export function buildSmokePreview({ golden, subtitles, durationSec, imageUrlFor }) {
  const g = golden ?? goldenScenario();
  const urlFor = imageUrlFor ?? (id => `/media/${id}.png`);
  return {
    missionId: g.missionId,
    version: g.version,
    samples: g.samples.map(s => ({ ...s, image: { ...s.image, url: urlFor(s.id), status: 'ready' } })),
    storyboard: (g.storyboard ?? []).map(e => {
      const entry = { ...e };
      if (entry.useImageOf !== undefined) {
        entry.image = urlFor(entry.useImageOf);
        delete entry.useImageOf;
      }
      return entry;
    }),
    subtitles: subtitles ?? [],
    durationSec: durationSec ?? 0,
    narrationAudio: '/narration.wav',
  };
}

/**
 * composeReel 自包含页 → 冒烟宿主页：给 .reel 加 data-reel-manual（关掉播放器自动挂载），
 * 尾部插一个模块脚本显式 createReelPlayer 并暴露 window.__reel，供 Playwright 驱动
 * 播放/暂停/seek 后截图。幂等：已装配的页原样返回（不重复插脚本）。
 */
export function smokeHostPage(reelHtml, { playerSrc = '/agentic/reel/player.js' } = {}) {
  if (reelHtml.includes('window.__reel')) return reelHtml;
  let html = reelHtml.replace('<div class="reel">', '<div class="reel" data-reel-manual>');
  const glue = `<script type="module">
import { createReelPlayer } from '${playerSrc}';
window.__reel = createReelPlayer(document.querySelector('.reel'), { autoplay: true });
</script>`;
  return html.replace('</body>', `${glue}\n</body>`);
}

const SAMPLES_STYLE = `
body{margin:0;background:#F4F6F0;font-family:var(--font-sans,system-ui,sans-serif);color:#22302A;}
.wrap{max-width:1080px;margin:0 auto;padding:24px 16px;}
h1{font:600 18px/1.4 var(--font-serif,serif);margin:0 0 16px;}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
.samp{margin:0;border:1px solid #D8E2D4;border-radius:12px;overflow:hidden;background:#FCFBF6;}
.frame{position:relative;aspect-ratio:4/3;}
.wm{position:absolute;right:8px;bottom:6px;font-size:11px;color:#fff;background:rgba(0,0,0,.38);border-radius:6px;padding:1px 6px;letter-spacing:.1em;}
figcaption{padding:8px 12px;font-size:12px;color:#5C6B61;}
.slide{position:absolute;inset:0;display:grid;grid-template-columns:1.1fr 1fr;}
.slide .txt{padding:7%;display:grid;gap:6px;align-content:center;}
.slide .tag{font-size:11px;color:#4F8570;letter-spacing:.08em;}
.slide h4{margin:0;font:600 clamp(16px,2.4vw,22px)/1.3 var(--font-serif,serif);}
.slide ul{margin:6px 0 0;padding-left:1.1em;display:grid;gap:5px;font-size:clamp(11px,1.5vw,13px);line-height:1.45;}
.slide .pic{background-size:cover;background-position:62% center;}
@media (prefers-reduced-motion: reduce){*,*::before,*::after{animation:none !important;transition:none !important;}}
`;

/** 两页样张画廊宿主页（composeSample × 2 并排）：文字全代码排版 + 示意水印 + 配图位。 */
export function samplesHostPage(golden, { imageUrlFor, title = '黄金场景 · 幻灯片样张' } = {}) {
  const g = golden ?? goldenScenario();
  const urlFor = imageUrlFor ?? (id => `/media/${id}.png`);
  const figures = g.samples.map(s => composeSample(s, { url: urlFor(s.id) })).join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${SAMPLES_STYLE}</style>
</head>
<body>
<div class="wrap">
<h1>${title}（PRD §3.2 · 初中老师 4 课时工作坊）</h1>
<div class="grid">
${figures}
</div>
</div>
</body>
</html>`;
}

/** 图片魔数 → 扩展名（缓存字节落媒体目录时命名用）；不是 PNG/JPEG 返回 null。 */
export function detectImageType(bytes) {
  if (!bytes || bytes.length < 4) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  return null;
}

const TYPES = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  wav: 'audio/wav',
  png: 'image/png',
  jpg: 'image/jpeg',
};

/**
 * 冒烟静态服务的路由表（纯函数）：`/` 预演片宿主页、`/samples` 样张画廊、
 * `/agentic/reel/player.js|reel.css` 播放器、`/narration.wav` 旁白、`/media/<name>` 配图。
 * 未命中返回 null（服务端 404）。路径不做文件系统拼接，只按名字查表——天然无穿越。
 */
export function smokeRoutes({ assets }) {
  const table = new Map([
    ['/', { body: assets.reelHtml, type: TYPES.html }],
    ['/samples', { body: assets.samplesHtml, type: TYPES.html }],
    ['/agentic/reel/player.js', { body: assets.playerJs, type: TYPES.js }],
    ['/agentic/reel/reel.css', { body: assets.reelCss, type: TYPES.css }],
    ['/narration.wav', { body: assets.narrationWav, type: TYPES.wav }],
  ]);
  const media = new Map((assets.media ?? []).map(m => [`/media/${m.name}`, { body: m.bytes, type: TYPES[m.name.split('.').pop()] ?? 'application/octet-stream' }]));
  return pathname => {
    let path = pathname;
    const q = path.indexOf('?');
    if (q >= 0) path = path.slice(0, q);
    return table.get(path) ?? media.get(path) ?? null;
  };
}

/**
 * 在端口段里起第一个空闲端口上的静态服务（用完 close 收尾，不留进程）。
 * 全部端口被占抛 SMOKE_PORT_EXHAUSTED。portRange 传 [0] = 系统临时端口（单测用）。
 */
export async function createSmokeServer({ routes, host = '127.0.0.1', portRange = SMOKE_PORTS, log = () => {} }) {
  const ports = portRange.length ? portRange : SMOKE_PORTS;
  for (const port of ports) {
    const server = createServer((req, res) => {
      const hit = routes(req.url ?? '/');
      if (!hit) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': hit.type, 'content-length': hit.body.length });
      res.end(hit.body);
    });
    const ok = await new Promise(resolve => {
      server.once('error', err => {
        if (err?.code === 'EADDRINUSE' && port !== 0) log(`port ${port} busy, trying next`);
        resolve(false); // 端口被占/监听失败：试下一个；listen(0) 由系统分配不会冲突
      });
      server.listen(port, host, () => resolve(true));
    });
    if (ok) {
      const bound = server.address().port || port; // listen(0) 时回报系统分配的端口
      log(`smoke static server on http://${host}:${bound}/`);
      return {
        port: bound,
        url: `http://${host}:${bound}/`,
        close: () => new Promise(resolve => server.close(() => resolve())),
      };
    }
  }
  const err = new Error(`SMOKE_PORT_EXHAUSTED: 端口段 ${ports[0]}–${ports[ports.length - 1]} 全被占用（用完请按 PID 清理）`);
  err.code = 'SMOKE_PORT_EXHAUSTED';
  throw err;
}

/** 台账条目 → 汇总：真实外呼（image/video，cached=false 且 ok）与缓存命中分开计数。 */
export function summarizeLedger(entries) {
  const list = entries ?? [];
  const real = e => e.kind === 'image' || e.kind === 'video';
  const imageCalls = list.filter(e => real(e) && e.kind === 'image' && !e.cached && e.ok !== false).length;
  const videoCalls = list.filter(e => real(e) && e.kind === 'video' && !e.cached && e.ok !== false).length;
  const models = {};
  for (const e of list) {
    if (e.model && !e.cached && e.ok !== false) models[e.model] = (models[e.model] ?? 0) + 1;
  }
  const audioSec = list.filter(e => e.kind === 'tts').reduce((s, e) => s + (e.audioSec ?? 0), 0);
  return {
    imageCalls,
    imageCacheHits: list.filter(e => e.kind === 'image' && e.cached).length,
    videoCalls,
    models,
    audioSec,
    totalMs: list.reduce((s, e) => s + (e.ms ?? 0), 0),
    withinBudget: imageCalls <= SMOKE_BUDGET.images && videoCalls <= SMOKE_BUDGET.videos,
  };
}

/**
 * 截图计划（纯函数）：播放器 4 张——首镜头/播放中/字幕帧/暂停，时刻单调递增且夹在
 * [0, durationSec) 内；字幕帧落在含「第 1 课时」的旁白句开始之后（样张翻页 + 字幕同帧）；
 * 另加一页样张画廊（w11-samples）。
 */
export function shotPlan(preview) {
  const dur = Math.max(1, Number(preview?.durationSec) || 1);
  const cues = Array.isArray(preview?.subtitles) ? preview.subtitles : [];
  const capIdx = cues.findIndex(c => /第 1 课时/.test(String(c?.text ?? '')));
  const capCue = capIdx >= 0 ? cues[capIdx] : cues[Math.floor(cues.length / 2)] ?? { startSec: dur / 2 };
  const raw = [
    { name: 'w11-reel-first-shot', atSec: Math.min(1.2, dur * 0.05), action: 'wait' },
    { name: 'w11-reel-playing', atSec: dur * 0.45, action: 'wait' },
    { name: 'w11-reel-subtitle', atSec: capCue.startSec + 0.6, action: 'seek-play' },
    { name: 'w11-reel-paused', atSec: dur * 0.62, action: 'wait-pause' },
  ];
  const shots = [];
  for (const s of raw) {
    const atSec = Math.min(Math.max(s.atSec, shots.length ? shots[shots.length - 1].atSec + 0.5 : 0), dur - 0.4);
    shots.push({ ...s, atSec: Math.round(atSec * 100) / 100 });
  }
  return { shots, samples: { name: 'w11-samples' } };
}

// ---------- 真实冒烟编排（全部依赖可注入；单测 mock，默认工厂才碰真实世界） ----------

/** 默认 TTS 工厂：模型就位才建引擎（缺失抛 TTS_MODELS_MISSING，绝不真实下载）。 */
export function defaultTtsEngineFactory(root) {
  const modelsDir = join(root, 'asr-lab', 'models', 'tts', TTS_MODEL);
  return createTtsEngine({ modelsDir });
}

/** 默认截图器：Playwright 全局锁（flock -w 900）包裹的独立进程跑 smoke-shots.mjs。
 *  spawn 可注入（单测记录命令行参数，绝不真实起浏览器进程）。 */
export function defaultRunShots({ root = WORKTREE_ROOT, url, samplesUrl, outDir, workDir = root, plan, spawn = spawnSync }) {
  const planFile = join(workDir, '.shot-plan.json');
  writeFileSync(planFile, JSON.stringify(plan));
  const r = spawn('flock', ['-w', '900', PW_LOCK, process.execPath, join(root, 'scripts/agentic/media/smoke-shots.mjs'), url, samplesUrl, outDir, planFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return { ok: r.status === 0, status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/**
 * 黄金场景冒烟主线：生图（2 页样张，z-image-turbo）→ TTS 旁白 → composeSample/composeReel
 * → 本地静态服务 → 截图 → （可选）1 段 happyhorse-1.1-t2v 场景片。返回 { summary, files, … }；
 * 每步耗时/模型/成败记 ledger（真实调用次数/耗时/模型）。任何生图缺 key 等致命错直接抛出
 * （不吞错、不截图）；视频段失败/超时只记账不炸主流程（超时受控也是被验证的路径）。
 */
export async function runGoldenSmoke(opts = {}) {
  const {
    root = WORKTREE_ROOT,
    outDir = join(root, 'design/schedule-to-delivery/shots/w11'),
    workDir = join(root, '.w11-smoke'),
    gatewayBaseUrl = process.env.DONEGO_GATEWAY_BASE_URL ?? 'http://127.0.0.1:4000',
    key = null, // 缺省走 env DONEGO_GATEWAY_KEY（W0 合入后换 gateway-key.mjs）
    fetch: fetchImpl = globalThis.fetch,
    imageClientFactory = ({ cache, quota }) => createImageClient({ baseUrl: gatewayBaseUrl, key, fetch: fetchImpl, cache, quota }),
    videoClientFactory = ({ cache, quota }) => createVideoClient({ baseUrl: gatewayBaseUrl, key, fetch: fetchImpl, cache, quota, timeoutMs: opts.videoTimeoutMs ?? SMOKE_VIDEO_TIMEOUT_MS }),
    ttsEngineFactory = defaultTtsEngineFactory,
    runShots = defaultRunShots,
    withVideo = false,
    portRange = SMOKE_PORTS,
    videoTimeoutMs = SMOKE_VIDEO_TIMEOUT_MS,
    log = () => {},
  } = opts;

  mkdirSync(workDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  const mediaDir = join(workDir, 'media');
  mkdirSync(mediaDir, { recursive: true });
  const cache = createMediaCache({ dir: join(workDir, 'media-cache') });
  const ledger = [];
  const record = entry => ledger.push({ at: new Date().toISOString(), ...entry });
  const golden = goldenScenario();

  // 1) 生图：黄金场景 2 页幻灯片样张（纯画面 z-image-turbo；预算由 quota 强制）
  const imageQuota = createDailyQuota({ file: join(workDir, 'image-quota.json'), limit: SMOKE_BUDGET.images });
  const images = imageClientFactory({ cache, quota: imageQuota });
  const mediaFiles = [];
  for (const sample of golden.samples) {
    const t0 = Date.now();
    const r = await images.generateImage({ missionId: golden.missionId, version: golden.version, prompt: sample.image.prompt, textInImage: false });
    const ms = Date.now() - t0;
    const bytes = readFileSync(r.file);
    const ext = detectImageType(bytes) ?? 'png';
    const name = `${sample.id}.${ext}`;
    writeFileSync(join(mediaDir, name), bytes);
    mediaFiles.push({ name, bytes });
    sample.image.status = 'ready';
    record({ kind: 'image', model: r.model, ms, cached: r.cached, ok: true, bytes: bytes.length, file: name, source: r.source });
    log(`image ${sample.id}: ${r.model} ${ms}ms cached=${r.cached} ${bytes.length}B`);
  }

  // 2) TTS 旁白：逐句合成 → wav + 字幕时间戳（模型已装则全离线，零外呼）
  const t0tts = Date.now();
  const engine = ttsEngineFactory(root);
  const narration = await synthesizeNarration(golden.narration, { engine });
  const ttsMs = Date.now() - t0tts;
  writeFileSync(join(workDir, 'narration.wav'), narration.wav);
  record({ kind: 'tts', model: TTS_MODEL, ms: ttsMs, ok: true, audioSec: Math.round(narration.durationSec * 100) / 100, cues: narration.cues.length });
  log(`tts: ${narration.durationSec.toFixed(1)}s / ${narration.cues.length} cues / ${ttsMs}ms`);

  // 3) 合成：样张画廊 + 预演片宿主页（配图指向本地静态服务）
  const imageUrlFor = id => `/media/${mediaFiles.find(m => m.name.startsWith(id + '.'))?.name ?? `${id}.png`}`;
  const preview = buildSmokePreview({ golden, subtitles: narration.cues, durationSec: narration.durationSec, imageUrlFor });
  writeFileSync(join(workDir, 'reel.html'), smokeHostPage(composeReel(preview)));
  writeFileSync(join(workDir, 'samples.html'), samplesHostPage(golden, { imageUrlFor }));

  // 4) 本地静态服务（本流端口段）→ Playwright（flock）截图存 shots/w11/
  const playerJs = readFileSync(join(root, 'web/agentic/reel/player.js'));
  let reelCss = Buffer.from('');
  try { reelCss = readFileSync(join(root, 'web/agentic/reel/reel.css')); } catch { /* 可选样式，缺了不影响 */ }
  const routes = smokeRoutes({
    assets: {
      reelHtml: readFileSync(join(workDir, 'reel.html')),
      samplesHtml: readFileSync(join(workDir, 'samples.html')),
      playerJs,
      reelCss,
      narrationWav: narration.wav,
      media: mediaFiles,
    },
  });
  const server = await createSmokeServer({ routes, portRange, log });
  try {
    const plan = shotPlan(preview);
    const t0shots = Date.now();
    const shots = await runShots({ root, url: server.url, samplesUrl: `${server.url}samples`, outDir, workDir, plan });
    record({ kind: 'shots', ms: Date.now() - t0shots, ok: Boolean(shots?.ok), detail: shots?.ok ? 'captured' : `status=${shots?.status ?? 'n/a'}` });
    log(`shots: ok=${shots?.ok} (${Date.now() - t0shots}ms)`);

    // 5) 可选：1 段 happyhorse-1.1-t2v 场景片（超时受控；失败/超时只记账）
    if (withVideo) {
      const videoQuota = createDailyQuota({ file: join(workDir, 'video-quota.json'), limit: SMOKE_BUDGET.videos });
      const videos = videoClientFactory({ cache, quota: videoQuota });
      const t0v = Date.now();
      try {
        const v = await videos.generateVideo({ model: golden.scene.model, prompt: golden.scene.prompt, missionId: golden.missionId, version: golden.version });
        writeFileSync(join(workDir, 'scene.mp4'), v.bytes);
        record({ kind: 'video', model: golden.scene.model, ms: Date.now() - t0v, ok: true, bytes: v.bytes.length, videoId: v.videoId });
        log(`video: ok ${v.bytes.length}B (${Date.now() - t0v}ms)`);
      } catch (e) {
        record({ kind: 'video', model: golden.scene.model, ms: Date.now() - t0v, ok: false, error: e.code ?? String(e?.message ?? e) });
        log(`video: ${e.code ?? 'ERROR'} after ${Date.now() - t0v}ms（超时/失败受控，已记账不炸主流程）`);
      }
    }
  } finally {
    await server.close();
  }

  const summary = summarizeLedger(ledger);
  const result = { summary, ledger, workDir, outDir, files: { reel: join(workDir, 'reel.html'), samples: join(workDir, 'samples.html'), narration: join(workDir, 'narration.wav'), media: mediaFiles.map(m => ({ name: m.name, file: join(mediaDir, m.name) })) }, port: server.port, url: server.url, durationSec: Math.round(narration.durationSec * 100) / 100, cues: narration.cues };
  writeFileSync(join(workDir, 'ledger.json'), JSON.stringify({ summary, ledger }, null, 2));
  return result;
}

const invokedDirectly = () => { try { return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };

/** CLI 输出/退出助手（命名导出以便单测；cliMain 缺省用它们）。 */
export const cliOut = s => process.stdout.write(s);
export const cliErr = s => process.stderr.write(s);
export const cliExit = code => process.exit(code);

/** CLI 入口（可注入，单测覆盖接线逻辑；默认才碰真实世界）。
 *  用法：DONEGO_GATEWAY_KEY=… node scripts/agentic/media/smoke.mjs [--with-video] */
export async function cliMain({ run = runGoldenSmoke, argv = process.argv, write = cliOut, writeErr = cliErr, exit = cliExit } = {}) {
  try {
    const r = await run({ withVideo: argv.includes('--with-video'), log: m => write(m + '\n') });
    write(JSON.stringify({ summary: r.summary, files: r.files, durationSec: r.durationSec, shots: r.outDir }, null, 2) + '\n');
  } catch (e) {
    writeErr(`${e.code ?? 'ERROR'}: ${e.message}\n`);
    exit(1);
  }
}

if (invokedDirectly()) await cliMain();
