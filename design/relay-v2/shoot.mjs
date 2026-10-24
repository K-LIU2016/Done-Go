import { chromium } from '@playwright/test';
const DIR = new URL('./', import.meta.url).pathname;
const exe = '/Users/chillbit/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const S = ['home', 'match', 'running', 'result', 'passport', 'discover', 'more', 'fail'];
const b = await chromium.launch({ executablePath: exe });
const m = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
for (const s of S) { await m.goto(`file://${DIR}prototype.html?s=${s}&shot=1`); await m.waitForTimeout(250); await m.screenshot({ path: `${DIR}shots/m-${s}.png`, fullPage: true }); }
const d = await b.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1.5 });
for (const s of ['home', 'result']) { await d.goto(`file://${DIR}prototype.html?s=${s}&shot=1`); await d.waitForTimeout(250); await d.screenshot({ path: `${DIR}shots/d-${s}.png`, fullPage: true }); }
// board
const names = { home: '① 开始', match: '② 说清楚', running: '③ AI 先做', result: '④ 结果·接力棒', passport: '⑤ 我的用法', discover: '⑥ 发现', more: '⑦ 更多', fail: '⑧ 失败也能接力' };
const html = `<!doctype html><meta charset=utf-8><style>body{margin:0;background:#EDEAE2;font-family:"PingFang SC"}h1{font-size:30px;margin:28px 36px 4px}p{margin:0 36px 18px;color:#64665D}.g{display:grid;grid-template-columns:repeat(4,390px);gap:28px;padding:0 36px 36px;align-items:start}figure{margin:0}img{width:390px;border-radius:22px;box-shadow:0 10px 30px #0002;display:block}figcaption{font-size:16px;font-weight:600;margin:0 0 10px}</style><h1>探戈 Done&Go · AI 接力 v2 · UI/UX 定稿</h1><p>一个问题开头 · 三步接力 · 省时用户自评 · 接力棒把用户送去自己用 AI · 首页零时间元素</p><div class=g>${S.map(s => `<figure><figcaption>${names[s]}</figcaption><img src="shots/m-${s}.png"></figure>`).join('')}</div>`;
await m.setViewportSize({ width: 1772, height: 900 }); await m.setContent(html.replaceAll('src="shots/', `src="file://${DIR}shots/`)); await m.waitForTimeout(600);
await m.screenshot({ path: `${DIR}relay-v2-board.png`, fullPage: true });
await b.close();
