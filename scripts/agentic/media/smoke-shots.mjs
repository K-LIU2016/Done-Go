// W11 golden-smoke · Playwright 截图器：由 smoke.mjs 的 defaultRunShots 经全局锁
// `flock -w 900 /tmp/donego-s2d-pw.lock` 包裹后以独立进程运行（BUILD-PLAN §2.3：
// 同时 ≤2 个 spec 进程）。打开本地静态服务的预演片宿主页，按 shotPlan 逐张截图存
// design/schedule-to-delivery/shots/w11/：首镜头 / 播放中 / 字幕帧 / 暂停 + 样张画廊。
// chromium 可注入（单测用 fake browser 驱动，绝不真实起浏览器）。
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 截图文件名：plan 里的 name → outDir/<name>.png（名字只允许字母数字-_.，防路径逃逸）。 */
export function shotPath(outDir, name) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(name))) throw new Error(`bad shot name: ${name}`);
  return join(outDir, `${name}.png`);
}

/** CLI 参数：argv = [node, script, url, samplesUrl, outDir, planFile]。缺项/坏名抛错。 */
export function parseShotArgs(argv) {
  const [url, samplesUrl, outDir, planFile] = argv.slice(2);
  if (!url || !samplesUrl || !outDir || !planFile) {
    throw new Error('usage: node smoke-shots.mjs <url> <samplesUrl> <outDir> <planFile>');
  }
  return { url, samplesUrl, outDir, planFile };
}

/**
 * 按计划截图。plan = shotPlan(preview) 的输出（shots[4] + samples）。
 * 浏览器侧时序：
 * - 打开宿主页等 window.__reel 出现且 playing（自动播放被策略拒绝时点一次播放按钮=真实手势）；
 * - wait：等旁白主时钟走到 atSec；seek-play：seek 到字幕句后继续播；wait-pause：走到 atSec 后暂停；
 * - 每步落一张 PNG；最后去 /samples 截样张画廊页。
 */
export async function captureShots({ url, samplesUrl, outDir, plan, chromium }) {
  mkdirSync(outDir, { recursive: true });
  // 显式放开自动播放策略：预演片以旁白 <audio> 为主时钟，必须无手势开播（另有兜底：点播放键）
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
  const captured = [];
  try {
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__reel, null, { timeout: 15000 });
    const playing = () => page.waitForFunction(() => window.__reel.state === 'playing', null, { timeout: 10000 }).then(() => true).catch(() => false);
    if (!(await playing())) {
      // 自动播放被拒：点控制条播放键（真实用户手势）再等
      await page.click('[data-reel-act="toggle"]').catch(() => {});
      if (!(await playing())) throw new Error('reel did not start playing (autoplay rejected twice)');
    }
    for (const shot of plan.shots) {
      if (shot.action === 'seek-play') {
        await page.evaluate(atSec => { const r = window.__reel; r.seek(atSec); if (r.state !== 'playing') r.play(); }, shot.atSec);
        await page.waitForTimeout(700); // 等 fade/字幕收敛
      } else {
        await page.waitForFunction(
          atSec => window.__reel.time() >= atSec,
          shot.atSec,
          { timeout: 60000 },
        );
        if (shot.action === 'wait-pause') {
          await page.evaluate(() => window.__reel.pause());
          await page.waitForTimeout(400);
        }
      }
      const path = shotPath(outDir, shot.name);
      await page.screenshot({ path });
      captured.push(path);
    }
    await page.goto(samplesUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    const samplesPath = shotPath(outDir, plan.samples.name);
    await page.screenshot({ path: samplesPath });
    captured.push(samplesPath);
  } finally {
    await browser.close();
  }
  return { captured };
}

const invokedDirectly = () => { try { return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };

/** CLI 输出/退出/加载助手（命名导出以便单测；cliShots 缺省用它们）。 */
export const shotsOut = s => process.stdout.write(s);
export const shotsErr = s => process.stderr.write(s);
export const shotsExit = code => process.exit(code);
/** 真实加载 @playwright/test 的 chromium（只 import 不 launch，单测可安全调用）。 */
export const loadPlaywrightChromium = () => import('@playwright/test').then(m => m.chromium);

/** CLI 入口（可注入，单测覆盖接线逻辑；默认才真实加载 chromium）。 */
export async function cliShots({
  argv = process.argv,
  loadChromium = loadPlaywrightChromium,
  readFile = readFileSync,
  write = shotsOut,
  writeErr = shotsErr,
  exit = shotsExit,
} = {}) {
  try {
    const args = parseShotArgs(argv);
    const plan = JSON.parse(readFile(args.planFile, 'utf8'));
    const chromium = await loadChromium();
    const r = await captureShots({ ...args, plan, chromium });
    write(JSON.stringify({ ok: true, captured: r.captured }) + '\n');
  } catch (e) {
    writeErr(`SMOKE_SHOTS_FAILED: ${e.message}\n`);
    exit(1);
  }
}

if (invokedDirectly()) await cliShots();
