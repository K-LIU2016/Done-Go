// tests/voice/impl-shots.spec.ts — VI·收官：4 屏实现截图（真实全链路）。
// 4 屏 = ① 首页待机(#home) ② 正在听·流式转写(#sheet-listen) ③ 正在理解(#sheet-think)
//        ④ 听出了几件事·事件卡(#sheet-review)，与 prototype.html 四屏一一对应。
// 链路为真实路径（同 voice-lab.spec.ts 验收装配，非 mock）：
//   合成音频 fixtures/asr-multi-event.wav（假麦克风循环播）→ 真 voice-gateway.mjs
//   → ws://127.0.0.1:10195（donego-funasr 容器）流式 partial/final → 真渲染；
//   intent 走真 intent.mjs，LLM 指向进程内 stub（deepseek-v4.1-flash 档，评测选型）。
// stub 响应前人为延迟 1500ms：③ 屏（理解中·骨架卡 shimmer）是过渡屏，stub 即答时
// 毫秒级被 ④ 屏顶掉无法成像——延迟仅为拍摄过渡屏，不改变任何被测代码路径。
//
// 运行方式（收官专用，必须 --workers=1：实例端口固定，多 worker 会抢端口）：
//   VOICE_SHOTS=1 npx playwright test --config tests/voice/playwright.impl-shots.config.ts --workers=1
// 前置：donego-funasr 容器监听 127.0.0.1:10195（起服时自检，缺席即失败）；
//       本机需有 CJK 字体（thinkpad 已装用户态 Noto Sans CJK SC，见 evidence/vi-finale.md）。
// 产物：design/voice-intent/impl-shots/{01-home,02-listen,03-think,04-review}.{390x844,1280x860}.png
// 环境：VOICE_SHOTS 未设时整文件 skip——默认 `playwright test` 套件保持绿（同验收 spec 惯例）。
import { createServer as createHttpServer, type Server } from "node:http";
import { connect as tcpConnect } from "node:net";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";
import { loadVoiceModules, createVoiceLabServer, demoRelativeDates } from "../../scripts/voice-lab.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_WAV = resolve(HERE, "fixtures/asr-multi-event.wav");
const MAIN_PORT = 17553; // 收官任务指定的临时实例端口（授权段 17550–17559）
const STUB_PORT = 17555;
const MAIN_URL = `http://127.0.0.1:${MAIN_PORT}/voice/lab.html`;
const STUB_MODEL = "deepseek-v4.1-flash"; // 评测选型（SPEC §6 阈值内最快）
const STUB_DELAY_MS = 1500; // 见头注：仅为让 ③ 过渡屏可拍摄
const SHOTS_DIR = resolve(HERE, "../../design/voice-intent/impl-shots");

test.skip(!process.env.VOICE_SHOTS, "收官截图专用（需 lab 实例 + FunASR 容器 + stub）：VOICE_SHOTS=1 时运行");

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${FIXTURE_WAV}`,
    ],
  },
});

// —— stub LLM（同验收 spec 的确定性应答器 + 拍摄用延迟）——
function extractTag(text: string, tag: string): string | null {
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : null;
}
function stubRefine(bodyText: string): string {
  let content = "";
  try {
    const body = JSON.parse(bodyText);
    content = String(body?.messages?.at?.(-1)?.content ?? "");
  } catch {
    content = "";
  }
  const transcript = extractTag(content, "transcript") ?? "";
  const now = extractTag(content, "now") ?? new Date().toISOString();
  const tz = extractTag(content, "tz") ?? "Asia/Shanghai";
  const ruleDraftText = extractTag(content, "rule_draft");
  if (/组会|导师|报告/.test(transcript)) {
    const d = demoRelativeDates(now, tz);
    const out = {
      nonEvent: null,
      items: [
        { title: "整理实验数据", kind: "necessary", date: null, start: null, end: null, durationMin: null, deadline: d.tomorrow, timeText: "明天下午三点", vague: false, recurrence: null, priority: 1, priorityReason: "你说「必须」，且要赶在组会前", confidence: 0.91, source: "必须把实验数据先整理好" },
        { title: "和导师开组会", kind: "necessary", date: d.tomorrow, start: "15:00", end: "16:00", durationMin: null, deadline: null, timeText: "明天下午三点", vague: false, recurrence: null, priority: 2, priorityReason: "和导师有约，时间已定", confidence: 0.92, source: "要跟导师开组会" },
        { title: "交课程报告", kind: "create", date: null, start: null, end: null, durationMin: null, deadline: d.thisFriday, timeText: "周五前", vague: false, recurrence: null, priority: 2, priorityReason: "有明确截止日", confidence: 0.88, source: "周五前交课程报告" },
      ],
    };
    return JSON.stringify(out);
  }
  if (ruleDraftText) return ruleDraftText;
  return JSON.stringify({ nonEvent: null, items: [] });
}
function startStubLlm(): Promise<{ server: Server; close: () => Promise<void> }> {
  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "stub-impl-shots",
          model: STUB_MODEL,
          choices: [{ index: 0, message: { role: "assistant", content: stubRefine(body) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      }, STUB_DELAY_MS);
    });
  });
  return new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(STUB_PORT, "127.0.0.1", () =>
      resolveReady({
        server,
        close: () => new Promise<void>((resolveClosed) => {
          server.close(() => resolveClosed());
          server.closeAllConnections?.();
        }),
      }),
    );
  });
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolveReady());
  });
}
function checkFunasrUp(): Promise<void> {
  return new Promise((resolveReady, reject) => {
    const socket = tcpConnect(10195, "127.0.0.1");
    const done = (err?: Error) => { socket.destroy(); err ? reject(err) : resolveReady(); };
    socket.setTimeout(1500, () => done(new Error("FunASR 10195 connect timeout")));
    socket.once("connect", () => done());
    socket.once("error", (err) => done(err));
  });
}

interface Harness { main: ReturnType<typeof createVoiceLabServer>; stub: { close: () => Promise<void> }; close: () => Promise<void>; }
let harness: Harness | null = null;

test.beforeAll(async () => {
  if (harness) return;
  await checkFunasrUp();
  const stub = await startStubLlm();
  process.env.TANGO_AI_PROVIDER = "openai";
  process.env.TANGO_AI_URL = `http://127.0.0.1:${STUB_PORT}/v1/chat/completions`;
  process.env.TANGO_AI_KEY = "synthetic-shots-stub-key";
  process.env.TANGO_AI_MODEL_LIGHT = STUB_MODEL;

  const modules = await loadVoiceModules(); // 真网关(→10195) + 真 intent
  const main = createVoiceLabServer({
    gateway: modules.gateway.gateway,
    intentEngine: modules.intent.engine,
    gatewayMode: modules.gateway.mode,
    intentMode: modules.intent.mode,
  });
  await listen(main, MAIN_PORT);
  const status = await (await fetch(`http://127.0.0.1:${MAIN_PORT}/api/voice/lab-status`)).json();
  if (status?.modules?.gateway?.mode !== "module" || status?.modules?.intent?.mode !== "module") {
    throw new Error(`lab-status 模块装配不是 module/module：${JSON.stringify(status?.modules)}`);
  }
  mkdirSync(SHOTS_DIR, { recursive: true });
  harness = {
    main,
    stub,
    close: async () => { await Promise.allSettled([main.voiceLab.close(), stub.close()]); },
  };
});
test.afterAll(async () => { await harness?.close(); harness = null; });

async function shot(page: Page, name: string): Promise<string> {
  const vw = test.info().project.name === "mobile-390" ? "390x844" : "1280x860";
  const path = resolve(SHOTS_DIR, `${name}.${vw}.png`);
  await page.screenshot({ path });
  return path;
}

test("4 屏实现截图：待机 → 流式转写 → 理解中 → 事件卡（真实链路）", async ({ page }) => {
  test.setTimeout(120_000);

  // ① 首页待机
  await page.goto(MAIN_URL);
  await expect(page.locator("#mod-gateway")).toHaveText("asr module");
  await expect(page.locator("#mod-intent")).toHaveText("intent module");
  await expect(page.locator("#home")).toBeVisible();
  await page.waitForTimeout(400); // 字体/布局安定
  const p1 = await shot(page, "01-home");

  // ② 正在听：流式灰字（首灰字 ≤25s——FunASR 首会话冷启动慢是已知实测）
  await page.click("#mic");
  await expect(page.locator("#sheet-listen")).toBeVisible();
  await page.waitForFunction(() => document.querySelector("#tx .p .ch") !== null, null, { timeout: 25_000 });
  // 尽量等到「黑定稿句 + 灰尾字」同框（构图同原型：两句黑 + 灰尾 + 橙光标）；等不到也如实拍
  await page.waitForFunction(
    () => document.querySelector("#tx .f") !== null && document.querySelector("#tx .p .ch") !== null,
    null,
    { timeout: 12_000 },
  ).catch(() => {});
  await page.waitForTimeout(600); // rise/breathe 动画帧安定
  const p2 = await shot(page, "02-listen");

  // 关键词就位再停机（保证 offline 定稿完整、事件卡 3 件事可复现）
  try {
    await page.waitForFunction(() => /组会|导师|报告/.test(document.getElementById("tx")!.textContent || ""), null, { timeout: 25_000 });
  } catch {
    const txNow = (await page.locator("#tx").textContent()) || "";
    throw new Error(`关键词（组会|导师|报告）25s 未出现在转写；#tx 实文：「${txNow.slice(0, 200)}」`);
  }
  await page.click("#doneBtn");

  // ③ 正在理解（过渡屏；stub 延迟 1500ms 保证可拍摄）
  await page.waitForFunction(() => !(document.getElementById("sheet-think") as HTMLElement).classList.contains("hidden"), null, { timeout: 25_000 });
  await expect(page.locator("#txLocked")).toContainText(/[\u4e00-\u9fff]/);
  await page.waitForTimeout(700); // shimmer 进行中取帧
  const p3 = await shot(page, "03-think");

  // ④ 事件卡：3 件事、首卡 p1「最优先」（stub 定稿，deepseek-v4.1-flash 档）
  await expect(page.locator("#sheet-review")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#gotCount")).toHaveText("听出了 3 件事");
  await expect(page.locator("#events .ev")).toHaveCount(3);
  await expect(page.locator("#events .ev").first().locator(".chip.pri.p1")).toHaveText("最优先");
  await page.waitForTimeout(400);
  const p4 = await shot(page, "04-review");

  console.log(`VOICE-SHOTS ${JSON.stringify({ project: test.info().project.name, files: [p1, p2, p3, p4] })}`);
});
