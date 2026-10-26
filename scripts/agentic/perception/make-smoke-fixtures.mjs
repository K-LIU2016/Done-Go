// W12 冒烟自造件生成器（BUILD-PLAN L146：自己生成 2 张——延误屏、冰箱）：
// 纯本地渲染——写两个 HTML（CSS 画到站屏/冰箱内部），Playwright Chromium 截图成 PNG。
// 零外部网络调用、零视觉配额消耗；复现方式：flock -w 900 /tmp/donego-s2d-pw.lock \
//   node scripts/agentic/perception/make-smoke-fixtures.mjs（Playwright 全局锁，§2.3 L63）。
// 产物：fixtures/delay-board.png（黑底大字到站屏：K234 延误 25 分钟）、
//       fixtures/fridge.png（冰箱内部：番茄×2、鸡蛋×3、半颗洋葱，无牛肉）。
// HTML 一并入库（造法即源码），smoke.mjs 的 defaultSmokeInputs().how 指向这里。
'use strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const VIEWPORT = '1024,768';

// 场景 1：车站到站/出发信息屏（PRD §6.8.3「18:00 去吃饭｜车站延误屏｜线路延误 25 分钟」）
const DELAY_BOARD_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>delay-board</title>
<style>
  html,body{margin:0;width:1024px;height:768px;background:#0a0a0a;
    font-family:"PingFang SC","Hiragino Sans GB","Heiti SC",sans-serif;color:#ffd21e}
  .board{padding:48px 56px;box-sizing:border-box}
  h1{font-size:44px;letter-spacing:8px;color:#fff;border-bottom:4px solid #ffd21e;padding-bottom:18px;margin:0 0 8px}
  .sub{font-size:26px;color:#8be04e;margin:14px 0 26px;letter-spacing:2px}
  table{width:100%;border-collapse:collapse;font-size:38px}
  th{font-size:24px;color:#9aa0a6;text-align:left;font-weight:400;padding:0 12px 12px}
  td{padding:20px 12px;border-top:1px solid #26282b}
  .delay{color:#ff5252;font-weight:700}
  .ontime{color:#8be04e}
  .clock{position:absolute;top:52px;right:64px;font-size:34px;color:#fff;letter-spacing:2px}
</style></head>
<body><div class="board">
  <h1>虹桥站 · 出发信息</h1>
  <div class="clock">18:07</div>
  <div class="sub">DEPARTURES ③号检票口</div>
  <table>
    <tr><th>车次</th><th>图定</th><th>状态</th><th>预计出发</th><th>检票口</th></tr>
    <tr><td>K234</td><td>18:07</td><td class="delay">延误 25 分钟</td><td>18:32</td><td>3A</td></tr>
    <tr><td>G7570</td><td>18:15</td><td class="ontime">正在候车</td><td>18:15</td><td>7B</td></tr>
    <tr><td>D3062</td><td>18:22</td><td class="delay">延误 10 分钟</td><td>18:32</td><td>2A</td></tr>
  </table>
</div></body></html>`;

// 场景 2：冰箱内部（PRD §6.8.3「18:30 做晚饭｜冰箱｜有番茄、鸡蛋、半颗洋葱，没有牛肉」）
const FRIDGE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>fridge</title>
<style>
  html,body{margin:0;width:1024px;height:768px;background:#e8eaed}
  .fridge{position:relative;width:780px;height:700px;margin:34px auto;background:#f6f8fa;
    border:14px solid #d3d7db;border-radius:18px;box-shadow:inset 0 0 60px #cfd4d9;overflow:hidden}
  .lamp{position:absolute;top:18px;left:50%;transform:translateX(-50%);width:120px;height:18px;
    border-radius:9px;background:#fffbe6;box-shadow:0 0 34px 12px #fff7cf}
  .shelf{position:absolute;left:24px;right:24px;height:14px;background:#dde1e5;border-radius:4px;
    box-shadow:0 3px 6px #b9bec4}
  .s1{top:210px}.s2{top:420px}.s3{top:630px}
  .tomato{position:absolute;width:96px;height:92px;border-radius:50% 50% 48% 48%;
    background:radial-gradient(circle at 34% 30%,#ff7a59,#e2321e 62%,#a91403)}
  .tomato::before{content:"";position:absolute;top:-13px;left:50%;transform:translateX(-50%);
    width:26px;height:16px;background:#2e7d32;border-radius:50% 50% 0 0}
  .egg{position:absolute;width:66px;height:86px;border-radius:50% 50% 50% 50%/58% 58% 44% 44%;
    background:radial-gradient(circle at 36% 26%,#fffdf5,#f2e3c8 70%,#dcc49a)}
  .onion{position:absolute;width:190px;height:96px;border-radius:190px 190px 0 0;
    background:radial-gradient(circle at 50% 100%,#f7e8f2 18%,#c98bd4 34%,#8e4a9e 62%,#5d2a68);
    border-bottom:8px solid #6d3577}
  .onion::after{content:"";position:absolute;left:50%;top:16px;transform:translateX(-50%);
    width:10px;height:70px;background:#f7e8f2;border-radius:6px;opacity:.8}
  .t1{left:70px;top:104px}.t2{left:190px;top:116px}
  .e1{left:440px;top:112px}.e2{left:524px;top:108px}.e3{left:608px;top:116px}
  .o1{left:70px;top:316px}
</style></head>
<body><div class="fridge">
  <div class="lamp"></div>
  <div class="tomato t1"></div><div class="tomato t2"></div>
  <div class="egg e1"></div><div class="egg e2"></div><div class="egg e3"></div>
  <div class="onion o1"></div>
  <div class="shelf s1"></div><div class="shelf s2"></div><div class="shelf s3"></div>
</div></body></html>`;

const TARGETS = [
  { html: 'delay-board.html', png: 'delay-board.png', body: DELAY_BOARD_HTML },
  { html: 'fridge.html', png: 'fridge.png', body: FRIDGE_HTML },
];

async function main() {
  await mkdir(FIXTURES_DIR, { recursive: true });
  for (const t of TARGETS) await writeFile(join(FIXTURES_DIR, t.html), t.body, 'utf8');
  for (const t of TARGETS) {
    const url = pathToFileURL(join(FIXTURES_DIR, t.html)).href;
    const out = join(FIXTURES_DIR, t.png);
    // npx playwright screenshot（本地 Chromium，file:// 渲染，无网络）
    const res = spawnSync('npx', ['playwright', 'screenshot', `--viewport-size=${VIEWPORT}`, '--wait-for-timeout=250', url, out], { stdio: 'inherit' });
    if (res.status !== 0) throw new Error(`screenshot failed for ${t.png} (exit ${res.status})`);
    console.log(`[fixtures] ${t.png} ← ${t.html}（Playwright Chromium 本地渲染）`);
  }
  console.log(`[fixtures] 完成：${FIXTURES_DIR}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch(err => { console.error('[fixtures] fatal:', err.message); process.exit(1); });
