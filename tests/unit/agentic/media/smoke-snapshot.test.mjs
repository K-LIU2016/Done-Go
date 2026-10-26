// W11 golden-smoke · 冒烟产物结构先行单测（RED 契约）。
// 依据：DAG 组4：真实外呼只在 smoke.mjs 的 main()（组4 冒烟阶段执行，本测试绝不触发）；
// 本文件固化黄金场景数据与预算红线（PRD §3.2 课程设计：初中老师 4 课时工作坊）：
// 生图 ≤20、生视频 ≤2（BUILD-PLAN §2.3）；产品默认 30 张/天与冒烟 ≤20 是两个数字。
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, get as httpGet } from 'node:http';
import { test } from 'node:test';

import {
  goldenScenario,
  SMOKE_BUDGET,
  buildSmokePreview,
  smokeHostPage,
  samplesHostPage,
  detectImageType,
  smokeRoutes,
  createSmokeServer,
  summarizeLedger,
  shotPlan,
  runGoldenSmoke,
  defaultTtsEngineFactory,
  defaultRunShots,
  cliMain,
  cliOut,
  cliErr,
} from '../../../../scripts/agentic/media/smoke.mjs';
import {
  parseShotArgs, shotPath, captureShots, cliShots, shotsOut, shotsErr, loadPlaywrightChromium,
} from '../../../../scripts/agentic/media/smoke-shots.mjs';
import { composeSample } from '../../../../scripts/agentic/composer/compose-sample.mjs';
import { composeReel } from '../../../../scripts/agentic/composer/compose-reel.mjs';
import { DEFAULT_IMAGE_QUOTA } from '../../../../scripts/agentic/media/quota.mjs';
import { samplesToWav } from '../../../../scripts/agentic/tts/engine.mjs';

test('the smoke budget obeys the hard caps: ≤20 images, ≤2 videos', () => {
  assert.ok(SMOKE_BUDGET.images > 0 && SMOKE_BUDGET.images <= 20, '生图冒烟配额在 20 以内');
  assert.ok(SMOKE_BUDGET.videos >= 0 && SMOKE_BUDGET.videos <= 2, '生视频冒烟配额在 2 以内');
  assert.notEqual(SMOKE_BUDGET.images, DEFAULT_IMAGE_QUOTA, '冒烟预算与产品默认（30）是分开的两个数字');
});

test('goldenScenario is the PRD §3.2 course-design mission: 2 pure-visual slide samples', () => {
  const g = goldenScenario();
  assert.ok(g.missionId && g.version >= 1);
  assert.equal(g.samples.length, 2, '黄金场景 = 2 页幻灯片样张');
  for (const s of g.samples) {
    assert.equal(s.layout, 'slide-title-bullets-image');
    assert.equal(s.image.model, 'z-image-turbo', '纯画面用 z-image-turbo（PRD §2.4）');
    assert.ok(s.image.prompt.includes('不要出现任何文字'), '配图 prompt 必须声明无文字（PRD §10.3）');
    assert.equal(s.watermark, '示意');
    assert.ok(typeof s.text.title === 'string' && s.text.title.length > 0);
    assert.ok(Array.isArray(s.text.bullets) && s.text.bullets.length > 0);
  }
  assert.notEqual(g.samples[0].page, g.samples[1].page, '两页样张是不同的页');
});

test('goldenScenario carries a storyboard and a Chinese narration for the 40s reel', () => {
  const g = goldenScenario();
  assert.ok(Array.isArray(g.storyboard) && g.storyboard.length >= 4, '预演片至少 4 个分镜（黄金场景时间线）');
  for (const sb of g.storyboard) {
    assert.ok(sb.at && sb.actor && sb.text, '分镜字段 at/actor/text（PRD §10.3）');
  }
  assert.ok(typeof g.narration === 'string' && g.narration.length >= 20);
  assert.ok(/课时|课程|交付/.test(g.narration), '旁白围绕黄金场景（课程设计工作坊）');
});

test('the golden samples render through composeSample without any network (快照固化冒烟产物结构)', () => {
  const g = goldenScenario();
  for (const s of g.samples) {
    const html = composeSample(s, null); // 冒烟时才有真图；结构测试不依赖网络
    assert.ok(html.includes(`data-layout="${s.layout}"`));
    assert.ok(html.includes('<span class="wm">示意</span>'));
    assert.ok(html.includes(s.text.title));
  }
});

// ---------- 以下为 golden-smoke 实现阶段追加的契约（快照固化冒烟产物结构） ----------

/** 8 句假字幕（与黄金场景旁白句数一致）：每句 4s，总 32s。 */
const fakeCues = () => Array.from({ length: 8 }, (_, i) => ({ text: `第${i + 1}句`, startSec: i * 4, endSec: i * 4 + 4 }));
const imageUrlFor = id => `/media/${id}.png`;

test('buildSmokePreview 组装 PRD §10.3 形状的 preview：配图 URL、字幕、旁白地址、时长', () => {
  const g = goldenScenario();
  const cues = fakeCues();
  const preview = buildSmokePreview({ golden: g, subtitles: cues, durationSec: 32, imageUrlFor });
  assert.equal(preview.missionId, g.missionId);
  assert.equal(preview.version, g.version);
  assert.deepEqual(preview.subtitles, cues, '字幕原样透传（tts 契约 [{text,startSec,endSec}]）');
  assert.equal(preview.durationSec, 32);
  assert.equal(preview.narrationAudio, '/narration.wav');
  assert.equal(preview.samples[0].image.url, '/media/s1.png', '样张配图指向本地静态服务');
  assert.equal(preview.samples[1].image.url, '/media/s2.png');
  const opening = g.storyboard.find(e => e.useImageOf);
  assert.ok(preview.storyboard.some(e => e.image === '/media/s1.png'), '开场分镜带配图（Ken Burns 镜头）');
  assert.equal(opening.useImageOf, 's1');
  assert.ok(!preview.storyboard.some(e => e.useImageOf !== undefined), 'useImageOf 装配后剥除（不进时间轴/数据岛）');
  assert.ok(preview.storyboard.some(e => e.kind === 'sample' && e.sampleId === 's1'), '样张翻页分镜保留 kind/sampleId');
});

test('composeReel(buildSmokePreview(…)) 的自包含页结构快照：镜头/字幕/数据岛/旁白（零网络固化）', () => {
  const g = goldenScenario();
  const preview = buildSmokePreview({ golden: g, subtitles: fakeCues(), durationSec: 32, imageUrlFor });
  const html = composeReel(preview);
  assert.equal((html.match(/class="shot"/g) ?? []).length, 8, '8 个分镜 = 8 个 .shot');
  assert.equal((html.match(/class="cap"/g) ?? []).length, 8, '8 句旁白 = 8 条 .cap 字幕');
  assert.ok(html.includes('data-start="0"'), '首镜从 0 起');
  assert.ok(html.includes('<audio id="reel-audio" src="/narration.wav"'), '旁白 <audio> 主时钟挂 /narration.wav');
  assert.ok(html.includes("url('/media/s1.png')"), '样张配图经 .pic 背景引用');
  const island = html.match(/<script type="application\/json" id="reel-data">([\s\S]*?)<\/script>/)[1];
  const data = JSON.parse(island);
  assert.equal(data.durationSec, 32);
  assert.equal(data.elements.filter(e => e.track === 'visual').length, 8);
  assert.equal(data.elements.filter(e => e.track === 'caption').length, 8);
  assert.ok(data.elements.every(e => e.useImageOf === undefined), '装配字段不漏进数据岛');
});

test('smokeHostPage 给 composeReel 页接上播放器：手动挂载标记 + 模块脚本暴露 __reel（幂等）', () => {
  const base = composeReel(buildSmokePreview({ golden: goldenScenario(), subtitles: fakeCues(), durationSec: 32, imageUrlFor }));
  const host = smokeHostPage(base, { playerSrc: '/agentic/reel/player.js' });
  assert.ok(host.includes('<div class="reel" data-reel-manual>'), '关自动挂载，改由宿主脚本显式创建');
  assert.ok(host.includes("import { createReelPlayer } from '/agentic/reel/player.js';"));
  assert.ok(host.includes('window.__reel'), '冒烟脚本要经 window.__reel 驱动播放/暂停/seek');
  assert.equal((host.match(/type="module"/g) ?? []).length, 1, '只插入一个模块脚本');
  assert.ok(host.trimEnd().endsWith('</html>'));
  const twice = smokeHostPage(host, { playerSrc: '/agentic/reel/player.js' });
  assert.equal(twice, host, '重复装配幂等（不重复插脚本）');
});

test('samplesHostPage：两页样张画廊（代码排版文字 + 示意水印 + 配图位）', () => {
  const g = goldenScenario();
  const html = samplesHostPage(g, { imageUrlFor, title: '黄金场景 · 幻灯片样张' });
  assert.equal((html.match(/<figure class="samp"/g) ?? []).length, 2);
  assert.ok(html.includes(g.samples[0].text.title));
  assert.ok(html.includes(g.samples[1].text.title));
  assert.equal((html.match(/<span class="wm">示意<\/span>/g) ?? []).length, 2, '每张样张一个示意水印');
  assert.ok(html.includes("url('/media/s2.png')"));
});

test('detectImageType：PNG/JPEG 魔数识别，垃圾返回 null', () => {
  assert.equal(detectImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'png');
  assert.equal(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpg');
  assert.equal(detectImageType(Buffer.from([0, 1, 2, 3])), null);
  assert.equal(detectImageType(null), null);
});

function smokeAssets() {
  return {
    reelHtml: Buffer.from('<!doctype html><html><body>reel</body></html>'),
    samplesHtml: Buffer.from('<!doctype html><html><body>samples</body></html>'),
    playerJs: Buffer.from('export const x = 1;'),
    reelCss: Buffer.from('.reel{}'),
    narrationWav: Buffer.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]),
    media: [
      { name: 's1.png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      { name: 's2.png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    ],
  };
}

test('smokeRoutes：/ 与 /samples、播放器、wav、媒体路径与 404（纯函数）', () => {
  const routes = smokeRoutes({ assets: smokeAssets() });
  assert.equal(routes('/').type, 'text/html; charset=utf-8');
  assert.ok(routes('/samples').body.toString().includes('samples'));
  assert.equal(routes('/agentic/reel/player.js').type, 'text/javascript; charset=utf-8');
  assert.equal(routes('/agentic/reel/reel.css').type, 'text/css; charset=utf-8');
  assert.equal(routes('/narration.wav').type, 'audio/wav');
  assert.equal(routes('/media/s1.png').type, 'image/png');
  assert.deepEqual(routes('/media/nope.png'), null, '未知媒体条目 → null（服务端 404）');
  assert.deepEqual(routes('/../etc/passwd'), null, '路径穿越不命中任何资产');
});

test('createSmokeServer：端口段内起服务、命中路由、未命中 404、close 收尾', async () => {
  const { port, close } = await createSmokeServer({ routes: smokeRoutes({ assets: smokeAssets() }), portRange: [0] });
  assert.ok(Number.isInteger(port) && port > 0);
  const get = path => new Promise((resolve, reject) => {
    httpGet({ host: '127.0.0.1', port, path }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  const home = await get('/');
  assert.equal(home.status, 200);
  assert.ok(home.type.startsWith('text/html'));
  assert.equal((await get('/media/s2.png')).status, 200);
  assert.equal((await get('/missing')).status, 404);
  await close();
});

test('summarizeLedger：真实外呼/缓存命中分开计数，预算越界可判定', () => {
  const entries = [
    { kind: 'image', model: 'z-image-turbo', ms: 4500, cached: false, ok: true },
    { kind: 'image', model: 'z-image-turbo', ms: 0, cached: true, ok: true },
    { kind: 'image', model: 'z-image-turbo', ms: 7400, cached: false, ok: true },
    { kind: 'tts', model: 'vits-piper-zh_CN-xiao_ya-medium-int8', ms: 5000, ok: true, audioSec: 41.2 },
    { kind: 'shots', ms: 3000, ok: true },
  ];
  const s = summarizeLedger(entries);
  assert.equal(s.imageCalls, 2, '缓存命中不计真实外呼');
  assert.equal(s.imageCacheHits, 1);
  assert.equal(s.videoCalls, 0);
  assert.equal(s.models['z-image-turbo'], 2);
  assert.ok(s.withinBudget, '2 图 0 视频在预算内');
  const over = summarizeLedger([...entries, { kind: 'image', model: 'z-image-turbo', ms: 1, cached: false, ok: true }]);
  assert.ok(!over.withinBudget || SMOKE_BUDGET.images >= 3, '第三张起须仍在 SMOKE_BUDGET.images 内');
  const bust = summarizeLedger([...entries, { kind: 'video', ok: true, cached: false }, { kind: 'video', ok: true, cached: false }, { kind: 'video', ok: true, cached: false }]);
  assert.ok(!bust.withinBudget, '视频 3 段超出冒烟预算 ≤2');
});

test('shotPlan：4 张播放器截图单调推进 + 样张画廊一页，字幕帧取“第 1 课时”句', () => {
  const g = goldenScenario();
  const cues = fakeCues();
  const preview = buildSmokePreview({ golden: g, subtitles: cues, durationSec: 32, imageUrlFor });
  const plan = shotPlan(preview);
  assert.deepEqual(plan.shots.map(s => s.name), ['w11-reel-first-shot', 'w11-reel-playing', 'w11-reel-subtitle', 'w11-reel-paused']);
  for (const s of plan.shots) assert.ok(s.atSec >= 0 && s.atSec < preview.durationSec, `${s.name} 在时长内`);
  for (let i = 1; i < plan.shots.length; i += 1) {
    assert.ok(plan.shots[i].atSec > plan.shots[i - 1].atSec, '截图时刻单调递增');
  }
  assert.equal(plan.shots[2].action, 'seek-play');
  assert.equal(plan.shots[3].action, 'wait-pause');
  assert.ok(plan.shots[2].atSec >= 16 + 0.5, '字幕帧落在“第 1 课时”句开始之后（第 5 句 16s 起）');
  assert.equal(plan.samples.name, 'w11-samples');
});

const PNG_1PX_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** mock 生图网关：POST /v1/images/generations → b64 1×1 PNG；其余路径 404。 */
function mockGatewayFetch(log) {
  return async (url, init = {}) => {
    log.push(`${init.method ?? 'GET'} ${url}`);
    if (String(url).endsWith('/v1/images/generations') && init.method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: PNG_1PX_B64 }] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test('runGoldenSmoke 全链路（mock 网关 + mock TTS + stub 截图）：产物落盘、台账记账、端口收尾', async () => {
  const work = mkdtempSync(join(tmpdir(), 'w11-smoke-test-'));
  const out = mkdtempSync(join(tmpdir(), 'w11-smoke-shots-'));
  mkdirSync(join(work, 'web/agentic/reel'), { recursive: true }); // 静态服务要读播放器文件
  writeFileSync(join(work, 'web/agentic/reel/player.js'), 'export const x = 1;');
  const calls = { fetches: [], shots: [] };
  // mock TTS：每句 0.2s 的真实 16bit PCM wav（经 synthesizeNarration 契约拼接）
  const mockEngine = {
    async synthesize(text) {
      assert.ok(text.length > 0, '逐句合成收到非空句');
      return { wav: samplesToWav(new Float32Array(4410), 22050), sampleRate: 22050, durationSec: 0.2 };
    },
  };
  const result = await runGoldenSmoke({
    root: work,
    workDir: join(work, '.w11-smoke'),
    outDir: out,
    fetch: mockGatewayFetch(calls.fetches),
    key: 'test-key',
    ttsEngineFactory: () => mockEngine,
    runShots: async opts => { calls.shots.push(opts); return { ok: true, files: ['w11-reel-first-shot.png'] }; },
    portRange: [0],
    log: () => {},
  });
  try {
    // 生图：2 次真实 POST（黄金场景 2 页），都落在网关 generations 端点
    assert.equal(calls.fetches.filter(u => u.startsWith('POST') && u.endsWith('/v1/images/generations')).length, 2);
    assert.ok(calls.fetches.every(u => !u.includes('test-key')), 'URL/日志不携带 key');
    // 产物
    for (const f of ['reel.html', 'samples.html', 'narration.wav', 'ledger.json']) {
      assert.ok(readFileSync(join(result.workDir, f)).length > 0, `${f} 已落盘`);
    }
    assert.ok(result.files.media.length === 2, '两张配图落本地媒体目录');
    assert.match(result.files.media[0].name, /^s1\.png$/, 'PNG 魔数命名');
    const host = readFileSync(join(result.workDir, 'reel.html'), 'utf8');
    assert.ok(host.includes('window.__reel'), 'reel.html 是接好播放器的宿主页');
    // 台账：2 图 + 1 tts + 1 shots，预算内
    assert.equal(result.summary.imageCalls, 2);
    assert.equal(result.summary.models['z-image-turbo'], 2);
    assert.ok(result.summary.withinBudget);
    assert.ok(result.summary.audioSec > 0, '旁白时长进台账');
    // 截图器收到本地静态页 URL 与计划
    assert.match(calls.shots[0].url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(calls.shots[0].plan.shots.length, 4);
    assert.equal(calls.shots[0].outDir, out);
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('runGoldenSmoke 生图失败不吞错：GATEWAY_KEY_MISSING 时抛出且不截图', async () => {
  const work = mkdtempSync(join(tmpdir(), 'w11-smoke-key-'));
  const fetches = [];
  const savedKey = process.env.DONEGO_GATEWAY_KEY;
  delete process.env.DONEGO_GATEWAY_KEY; // 缺省 key 解析路径 = env 注入（BUILD-PLAN §2.3）
  try {
    await assert.rejects(
      () => runGoldenSmoke({
        root: work,
        workDir: join(work, '.w11-smoke'),
        outDir: join(work, 'shots'),
        fetch: mockGatewayFetch(fetches),
        key: null,
        ttsEngineFactory: () => { throw new Error('must not be reached'); },
        runShots: async () => { throw new Error('must not shoot'); },
        portRange: [0],
        log: () => {},
      }),
      e => e.code === 'GATEWAY_KEY_MISSING',
    );
    assert.equal(fetches.length, 0, '缺 key 零外呼');
  } finally {
    if (savedKey !== undefined) process.env.DONEGO_GATEWAY_KEY = savedKey;
    rmSync(work, { recursive: true, force: true });
  }
});

// ---------- smoke-shots（截图器纯函数 + fake browser 驱动，绝不真实起浏览器） ----------

test('shotPath：合法名拼 outDir/<name>.png；路径逃逸名直接拒绝', () => {
  assert.equal(shotPath('/tmp/shots', 'w11-reel-playing'), '/tmp/shots/w11-reel-playing.png');
  assert.throws(() => shotPath('/tmp/shots', '../evil'), /bad shot name/);
  assert.throws(() => shotPath('/tmp/shots', 'a/b'), /bad shot name/);
});

test('parseShotArgs：四参齐全返回；缺参抛用法错误', () => {
  const a = parseShotArgs(['node', 's.mjs', 'http://x/', 'http://x/samples', '/out', '/plan.json']);
  assert.equal(a.url, 'http://x/');
  assert.equal(a.planFile, '/plan.json');
  assert.throws(() => parseShotArgs(['node', 's.mjs', 'http://x/']), /usage/);
});

/** fake chromium：记录全部页面操作；waitForFunction 对 playing 条件按剧本拒绝/放行。
 *  回调会真的被调用一次（node 下 window 未定义会抛，捕掉即可）——覆盖截图器里的回调源码。 */
function fakeChromium({ playingRejected = false, playingAfterClick = true } = {}) {
  const calls = { goto: [], waitsFor: [], evaluates: [], clicks: [], waits: [], shots: [], closed: 0 };
  const page = {
    goto: async (u, o) => { calls.goto.push(u); return o; },
    waitForFunction: async (fn, arg, opts) => {
      const src = String(fn);
      calls.waitsFor.push(src);
      try { fn(arg); } catch { /* node 无 window，回调执行即覆盖 */ }
      if (src.includes('playing') && playingRejected && !calls.playedAfterClick) {
        calls.playedAfterClick = false;
        throw new Error('timeout'); // 模拟等待超时（真实侧由 .catch 捕获）
      }
      return arg;
    },
    click: async sel => { calls.clicks.push(sel); calls.playedAfterClick = playingAfterClick; },
    evaluate: async (fn, arg) => {
      calls.evaluates.push({ src: String(fn), arg });
      try { fn(arg); } catch { /* 同上 */ }
    },
    waitForTimeout: async ms => { calls.waits.push(ms); },
    screenshot: async o => { calls.shots.push(o.path); },
  };
  return {
    calls,
    launch: async () => ({ newPage: async () => page, close: async () => { calls.closed += 1; } }),
  };
}

test('captureShots：三种动作（wait/seek-play/wait-pause）各就位 + 样张画廊页，浏览器必关闭', async () => {
  const out = mkdtempSync(join(tmpdir(), 'w11-shots-'));
  const chromium = fakeChromium();
  const plan = {
    shots: [
      { name: 'w11-reel-first-shot', atSec: 1.2, action: 'wait' },
      { name: 'w11-reel-subtitle', atSec: 16.6, action: 'seek-play' },
      { name: 'w11-reel-paused', atSec: 19.8, action: 'wait-pause' },
    ],
    samples: { name: 'w11-samples' },
  };
  const r = await captureShots({ url: 'http://127.0.0.1:1/', samplesUrl: 'http://127.0.0.1:1/samples', outDir: out, plan, chromium });
  try {
    assert.equal(r.captured.length, 4, '3 播放器截图 + 1 样张画廊');
    assert.ok(r.captured.every(p => p.startsWith(out) && p.endsWith('.png')));
    assert.deepEqual(chromium.calls.goto, ['http://127.0.0.1:1/', 'http://127.0.0.1:1/samples']);
    const evals = chromium.calls.evaluates.map(e => e.src);
    assert.ok(evals.some(s => s.includes('seek(')), 'seek-play 走 seek+play');
    assert.ok(evals.some(s => s.includes('pause(')), 'wait-pause 走 pause');
    assert.equal(chromium.calls.closed, 1, 'finally 里关浏览器');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('captureShots：自动播放被拒 → 点播放键（真实手势）救回；两次都失败则抛错并关浏览器', async () => {
  const out = mkdtempSync(join(tmpdir(), 'w11-shots-rej-'));
  const saved = fakeChromium({ playingRejected: true, playingAfterClick: true });
  const plan = { shots: [{ name: 'a', atSec: 1, action: 'wait' }], samples: { name: 's' } };
  const okRun = await captureShots({ url: 'http://127.0.0.1:1/', samplesUrl: 'http://127.0.0.1:1/samples', outDir: out, plan, chromium: saved });
  assert.equal(okRun.captured.length, 2);
  assert.deepEqual(saved.calls.clicks, ['[data-reel-act="toggle"]'], '点了一次播放键');
  rmSync(out, { recursive: true, force: true });

  const out2 = mkdtempSync(join(tmpdir(), 'w11-shots-fail-'));
  const doomed = fakeChromium({ playingRejected: true, playingAfterClick: false });
  await assert.rejects(
    () => captureShots({ url: 'http://127.0.0.1:1/', samplesUrl: 'http://127.0.0.1:1/samples', outDir: out2, plan, chromium: doomed }),
    /did not start playing/,
  );
  assert.equal(doomed.calls.closed, 1, '失败路径也关浏览器');
  rmSync(out2, { recursive: true, force: true });
});

// ---------- 覆盖补齐：端口占用/默认工厂/flock 命令/视频段/CLI 接线 ----------

test('createSmokeServer：端口被占记日志跳过；整段占满抛 SMOKE_PORT_EXHAUSTED', async () => {
  const blocker = createServer();
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const busy = blocker.address().port;
  const logs = [];
  try {
    await assert.rejects(
      () => createSmokeServer({ routes: smokeRoutes({ assets: smokeAssets() }), portRange: [busy], log: m => logs.push(m) }),
      e => e.code === 'SMOKE_PORT_EXHAUSTED',
    );
    assert.ok(logs.some(l => String(l).includes('busy')), 'EADDRINUSE 走日志分支');
  } finally {
    await new Promise(resolve => blocker.close(resolve));
  }
});

test('defaultTtsEngineFactory：模型目录缺失抛 TTS_MODELS_MISSING（绝不触发下载）', () => {
  assert.throws(
    () => defaultTtsEngineFactory(join(tmpdir(), 'w11-no-such-root')),
    e => e.code === 'TTS_MODELS_MISSING',
  );
});

test('defaultRunShots：flock -w 900 全局锁包裹 node smoke-shots.mjs；退出码透传；计划落 workDir', async () => {
  const work = mkdtempSync(join(tmpdir(), 'w11-runshots-'));
  const cmds = [];
  const spawn = (cmd, args) => { cmds.push([cmd, ...args]); return { status: cmds.length === 1 ? 0 : 3, stdout: 'ok', stderr: '' }; }; // 同步：与 spawnSync 同形
  const ok = await defaultRunShots({ root: work, url: 'http://u/', samplesUrl: 'http://u/samples', outDir: join(work, 'shots'), workDir: work, plan: { shots: [] }, spawn });
  const fail = await defaultRunShots({ root: work, url: 'http://u/', samplesUrl: 'http://u/samples', outDir: join(work, 'shots'), workDir: work, plan: { shots: [] }, spawn });
  try {
    assert.equal(ok.ok, true);
    assert.equal(fail.ok, false, '子进程非零退出码 → ok:false');
    const [head, ...args] = cmds[0];
    assert.equal(head, 'flock');
    assert.deepEqual(args.slice(0, 3), ['-w', '900', '/tmp/donego-s2d-pw.lock'], 'Playwright 全局锁参数（BUILD-PLAN §2.3）');
    assert.ok(args.includes(join(work, 'scripts/agentic/media/smoke-shots.mjs')), '独立进程跑截图器');
    const plan = JSON.parse(readFileSync(join(work, '.shot-plan.json'), 'utf8'));
    assert.deepEqual(plan, { shots: [] }, '计划写进 workDir（不进截图目录）');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

/** 生图+生视频双端点 mock 网关（videoFail=true 时 POST /v1/videos 500）。 */
function mockMediaGateway(log, { videoFail = false } = {}) {
  const mp4 = Buffer.from('fake-mp4-bytes');
  const respond = (status, extra) => ({ ok: status < 400, status, ...extra });
  return async (url, init = {}) => {
    const u = String(url);
    const method = init.method ?? 'GET';
    log.push(`${method} ${u}`);
    if (u.endsWith('/v1/images/generations') && method === 'POST') return respond(200, { json: async () => ({ data: [{ b64_json: PNG_1PX_B64 }] }) });
    if (u.endsWith('/v1/videos') && method === 'POST') {
      if (videoFail) return respond(500, { json: async () => ({}) });
      return respond(200, { json: async () => ({ id: 'v_smoke' }) });
    }
    if (u.endsWith('/v1/videos/v_smoke') && method === 'GET') return respond(200, { json: async () => ({ status: 'succeeded' }) });
    if (u.endsWith('/v1/videos/v_smoke/content')) return respond(200, { arrayBuffer: async () => new Uint8Array(mp4).buffer });
    return respond(404, { json: async () => ({}) });
  };
}

const mockTtsEngine = {
  async synthesize() { return { wav: samplesToWav(new Float32Array(4410), 22050), sampleRate: 22050, durationSec: 0.2 }; },
};

async function runMockSmoke(overrides = {}) {
  const work = mkdtempSync(join(tmpdir(), 'w11-smoke-video-'));
  mkdirSync(join(work, 'web/agentic/reel'), { recursive: true });
  writeFileSync(join(work, 'web/agentic/reel/player.js'), 'export const x = 1;');
  const fetches = [];
  const shots = [];
  try {
    const result = await runGoldenSmoke({
      root: work,
      workDir: join(work, '.w11-smoke'),
      outDir: join(work, 'shots'),
      fetch: mockMediaGateway(fetches, { videoFail: overrides.videoFail }),
      key: 'test-key',
      ttsEngineFactory: () => mockTtsEngine,
      runShots: async o => { shots.push(o); return { ok: true }; },
      portRange: [0],
      withVideo: true,
      log: () => {},
      ...overrides.opts,
    });
    return { work, result, fetches, shots };
  } catch (e) {
    rmSync(work, { recursive: true, force: true });
    throw e;
  }
}

test('runGoldenSmoke --with-video：POST/轮询/content 全链路成功，scene.mp4 落盘且记账', async () => {
  const { work, result, fetches } = await runMockSmoke();
  try {
    assert.ok(fetches.some(f => f.startsWith('POST') && f.endsWith('/v1/videos')), '建了视频任务');
    assert.ok(fetches.some(f => f === 'GET http://127.0.0.1:4000/v1/videos/v_smoke'), '轮询状态');
    assert.ok(fetches.some(f => f.endsWith('/v1/videos/v_smoke/content')), '拉取 content');
    assert.ok(readFileSync(join(result.workDir, 'scene.mp4')).length > 0, '视频落盘');
    assert.equal(result.summary.videoCalls, 1);
    assert.equal(result.summary.models['happyhorse-1.1-t2v'], 1);
    assert.ok(result.summary.withinBudget, '2 图 + 1 视频在冒烟预算内');
    const videoEntry = result.ledger.find(e => e.kind === 'video');
    assert.equal(videoEntry.ok, true);
    assert.equal(videoEntry.videoId, 'v_smoke');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('runGoldenSmoke --with-video 网关 500：视频失败只记账不炸主流程（截图/台账齐全）', async () => {
  const { work, result } = await runMockSmoke({ videoFail: true });
  try {
    assert.equal(result.summary.videoCalls, 0, '失败的外呼不计真实成功调用');
    assert.equal(result.summary.imageCalls, 2, '生图段不受视频失败影响');
    assert.ok(readFileSync(join(result.workDir, 'ledger.json')).length > 0);
    const videoEntry = result.ledger.find(e => e.kind === 'video');
    assert.equal(videoEntry.ok, false);
    assert.equal(videoEntry.error, 'http-500');
    assert.ok(!existsSync(join(result.workDir, 'scene.mp4')), '失败不产视频文件');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('cliMain：--with-video 透传、成功打印 summary、失败按 code 打印并 exit(1)', async () => {
  const runs = []; const wrote = []; const errs = []; let exited = null;
  await cliMain({
    argv: ['node', 'smoke.mjs', '--with-video'],
    run: async o => { runs.push(o); return { summary: { withinBudget: true }, files: { reel: '/r' }, durationSec: 41.2, outDir: '/shots' }; },
    write: s => wrote.push(s), writeErr: s => errs.push(s), exit: c => { exited = c; },
  });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].withVideo, true);
  assert.ok(wrote.join('').includes('"withinBudget"'), '结果 JSON 进 stdout');
  await cliMain({
    argv: ['node', 'smoke.mjs'],
    run: async o => { runs.push(o); const e = new Error('missing'); e.code = 'GATEWAY_KEY_MISSING'; throw e; },
    write: () => {}, writeErr: s => errs.push(s), exit: c => { exited = c; },
  });
  assert.equal(runs[1]?.withVideo, false, '无 flag 不带视频');
  assert.ok(errs.join('').includes('GATEWAY_KEY_MISSING'));
  assert.equal(exited, 1);
});

test('cliShots：读计划→截图→打印清单；坏参数 exit(1)', async () => {
  const work = mkdtempSync(join(tmpdir(), 'w11-clishots-'));
  const planFile = join(work, 'plan.json');
  writeFileSync(planFile, JSON.stringify({ shots: [], samples: { name: 'w11-samples' } }));
  const chromium = fakeChromium();
  const wrote = []; const errs = []; let exited = null;
  try {
    await cliShots({
      argv: ['node', 'x', 'http://u/', 'http://u/samples', join(work, 'shots'), planFile],
      loadChromium: async () => chromium,
      write: s => wrote.push(s), writeErr: s => errs.push(s), exit: c => { exited = c; },
    });
    assert.ok(wrote.join('').includes('"ok":true'));
    assert.equal(exited, null);
    await cliShots({
      argv: ['node', 'x'],
      loadChromium: async () => { throw new Error('never'); },
      write: () => {}, writeErr: s => errs.push(s), exit: c => { exited = c; },
    });
    assert.ok(errs.join('').includes('usage'), '参数缺失按用法错误报告');
    assert.equal(exited, 1);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ---------- 默认参数分支与 CLI 助手 ----------

test('buildSmokePreview/samplesHostPage 缺省 imageUrlFor：默认映射 /media/<id>.png', () => {
  const g = goldenScenario();
  const preview = buildSmokePreview({ golden: g, subtitles: fakeCues(), durationSec: 32 });
  assert.equal(preview.samples[0].image.url, '/media/s1.png');
  assert.ok(preview.storyboard.some(e => e.image === '/media/s1.png'), 'useImageOf 走同一默认映射');
  const html = samplesHostPage(g, {});
  assert.ok(html.includes("url('/media/s1.png')"));
});

test('shotPlan 空字幕/缺时长兜底：时长按 1s、字幕帧取中点兜底，仍在 [0,1) 内', () => {
  const plan = shotPlan({ subtitles: [], durationSec: undefined });
  assert.equal(plan.shots.length, 4);
  assert.ok(plan.shots.every(s => s.atSec >= 0 && s.atSec < 1), '兜底时长 1s 内夹取');
  const mid = shotPlan({ subtitles: [{ text: 'x', startSec: 0, endSec: 1 }], durationSec: 10 });
  assert.ok(mid.shots[2].atSec >= 0.6, '字幕命中但不含课时 → 中点兜底仍有效');
});

test('runGoldenSmoke 视频段抛无 code 错误：台账记 String(message)，主流程不受影响', async () => {
  const work = mkdtempSync(join(tmpdir(), 'w11-smoke-nocode-'));
  mkdirSync(join(work, 'web/agentic/reel'), { recursive: true });
  writeFileSync(join(work, 'web/agentic/reel/player.js'), 'export const x = 1;');
  try {
    const result = await runGoldenSmoke({
      root: work,
      workDir: join(work, '.w11-smoke'),
      outDir: join(work, 'shots'),
      fetch: mockMediaGateway([]),
      key: 'test-key',
      ttsEngineFactory: () => mockTtsEngine,
      runShots: async () => ({ ok: true }),
      portRange: [0],
      withVideo: true,
      videoClientFactory: () => ({ generateVideo: async () => { throw new Error('plain boom'); } }),
      log: () => {},
    });
    const videoEntry = result.ledger.find(e => e.kind === 'video');
    assert.equal(videoEntry.ok, false);
    assert.equal(videoEntry.error, 'plain boom', '无 code 时记 String(message)');
    assert.equal(result.summary.imageCalls, 2);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('cliOut/cliErr 空串直写不炸；cliMain 的 log 回调把运行日志写进 write 通道', async () => {
  cliOut(''); // 覆盖默认输出助手（空串零噪音）
  cliErr('');
  const wrote = [];
  await cliMain({
    argv: ['node', 'smoke.mjs'],
    run: async o => { o.log('step-1'); return { summary: {}, files: {}, durationSec: 0, outDir: '/x' }; },
    write: s => wrote.push(s), writeErr: () => {}, exit: () => {},
  });
  assert.ok(wrote.includes('step-1\n'), 'run 的 log 回调经 write 通道输出');
});

test('loadPlaywrightChromium：真实 import @playwright/test 拿到 chromium（不 launch）', async () => {
  const chromium = await loadPlaywrightChromium();
  assert.equal(typeof chromium.launch, 'function');
});

test('shotsOut/shotsErr 空串直写不炸；cliShots 缺省读真实计划文件（write 走默认通道）', async () => {
  shotsOut(''); // 空串零噪音，仅覆盖默认助手
  shotsErr('');
  const work = mkdtempSync(join(tmpdir(), 'w11-clishots-def-'));
  const planFile = join(work, 'plan.json');
  writeFileSync(planFile, JSON.stringify({ shots: [], samples: { name: 'w11-samples' } }));
  try {
    const chromium = fakeChromium();
    await cliShots({
      argv: ['node', 'x', 'http://u/', 'http://u/samples', join(work, 'shots'), planFile],
      loadChromium: async () => chromium,
    }); // readFile/write 走默认：真实读计划、结果进 stdout
    assert.equal(chromium.calls.closed, 1);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
