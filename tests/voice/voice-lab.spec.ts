// tests/voice/voice-lab.spec.ts — VI·验收（收敛令：只保留主路径 + 失败态各 1 例）。
// 覆盖：主链路（合成音频→流式文字→理解→事件卡→全部加入）桌面+手机双 project、
//       停止 1 例（听音中取消）、降级 1 例（FunASR 不可达 → asr-unavailable → 文字降级走通理解）。
//
// 运行方式（验收专用，必须 --workers=1：实例端口固定，多 worker 会抢端口）：
//   VOICE_ACCEPTANCE=1 npx playwright test tests/voice/voice-lab.spec.ts --workers=1
// 前置：donego-funasr 容器监听 127.0.0.1:10195（本 spec 起服时自检，缺席即失败）。
// 环境：VOICE_ACCEPTANCE 未设时整文件 skip——本 spec 要起真 lab 实例 + 真容器 + stub LLM，
//       不属于默认 `playwright test` 的负担（默认套件保持绿，见 evidence/vi-accept.md）。
//
// 实例布局（任务授权端口段 17550–17559）：
//   17552 主实例  = createVoiceLabServer + 真网关(voice-gateway.mjs → ws://127.0.0.1:10195)
//                   + 真 intent(intent.mjs)，LLM 走 17554 stub（deepseek-v4.1-flash 档）
//   17553 降级实例 = 同装配但网关 asrUrl 指向死端口（ws://127.0.0.1:59998）
//   17554 stub LLM = OpenAI 形状的确定性应答器（repo 内进程内 http，零外部依赖、零费用）
// 麦克风：Chromium --use-fake-ui-for-media-stream + --use-file-for-fake-audio-capture
//         指向 fixtures/asr-multi-event.wav（合成 TTS，见 fixtures/README.md；不落盘任何音频）。
// 指标：首字 ms（开口→第一个灰字，SPEC §6 门 ≤600）/ settle ms（说完→该句变黑，门 ≤1000），
//       逐 project 打印 VOICE-ACCEPT 行并落 test-results/voice-accept-<project>.json。
import { createServer as createHttpServer, type Server } from "node:http";
import { connect as tcpConnect } from "node:net";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";
// 下列 .mjs 为仓库既有模块（同 collaboration-server.mjs 的 helper 惯例，运行时 ESM 直载）
import { loadVoiceModules, createVoiceLabServer, demoRelativeDates } from "../../scripts/voice-lab.mjs";
import { createVoiceGateway } from "../../scripts/voice-gateway.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_WAV = resolve(HERE, "fixtures/asr-multi-event.wav"); // 明天下午三点…组会…必须…整理好…周五前交课程报告（8.05s，循环播放）
const MAIN_PORT = 17552;
const DEGRADED_PORT = 17553;
const STUB_PORT = 17554;
const DEAD_ASR = "ws://127.0.0.1:59998"; // 降级实例：永远连不上的 FunASR
const MAIN_URL = `http://127.0.0.1:${MAIN_PORT}/voice/lab.html`;
const DEGRADED_URL = `http://127.0.0.1:${DEGRADED_PORT}/voice/lab.html`;
const STUB_MODEL = "deepseek-v4.1-flash"; // 任务指定的 light 档 stub

test.skip(!process.env.VOICE_ACCEPTANCE, "语音验收专用（需 lab 实例 + FunASR 容器 + stub）：VOICE_ACCEPTANCE=1 时运行");

test.use({
  launchOptions: {
    // --use-fake-device-for-media-stream：headless 里先得有假设备（否则 gUM NotFoundError）；
    // --use-file-for-fake-audio-capture：假设备的音频内容=fixtures wav（循环播放）。
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${FIXTURE_WAV}`,
    ],
  },
});

// —— stub LLM（deepseek-v4.1-flash 档）：OpenAI 形状、确定性、进程内、零外部调用 ——
// 命中多事项句（组会|导师|报告）→ 返回定稿 3 件事（日期按请求 <now>/<tz> 换算）；
// 其他转写 → 原样采纳 <rule_draft>（LLM 无增量 = 合法结果）。hits/lastBody 供断言真走了 LLM 路径。
function extractTag(text: string, tag: string): string | null {
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : null;
}
function stubRefine(bodyText: string): string {
  let content = "";
  try {
    const body = JSON.parse(bodyText);
    // openai 形状 messages=[system,user,...]：用户转写在最后一条（同 tests/helpers/collaboration-server.mjs 的 .at(-1) 惯例）
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
  if (ruleDraftText) return ruleDraftText; // 采纳规则草稿（LLM 无增量）
  return JSON.stringify({ nonEvent: null, items: [] });
}
function startStubLlm(): Promise<{ server: Server; hits: () => number; lastBody: () => string | null }> {
  let hitCount = 0;
  let last: string | null = null;
  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      hitCount += 1;
      last = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "stub-acceptance",
        model: STUB_MODEL,
        choices: [{ index: 0, message: { role: "assistant", content: stubRefine(last) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  return new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(STUB_PORT, "127.0.0.1", () => resolveReady({ server, hits: () => hitCount, lastBody: () => last }));
  });
}

// —— lab 实例（主 + 降级）与 stub 的装配/拆除 ——
interface Harness {
  main: { server: ReturnType<typeof createVoiceLabServer>; close: () => Promise<void> };
  degraded: { server: ReturnType<typeof createVoiceLabServer>; close: () => Promise<void> };
  stub: { server: Server; hits: () => number; lastBody: () => string | null };
  close: () => Promise<void>;
}
let harness: Harness | null = null;

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolveReady());
  });
}
function checkFunasrUp(): Promise<void> {
  // donego-funasr 必须在 10195 监听（缺席=环境不满足，快速如实失败）
  return new Promise((resolveReady, reject) => {
    const socket = tcpConnect(10195, "127.0.0.1");
    const done = (err?: Error) => { socket.destroy(); err ? reject(err) : resolveReady(); };
    socket.setTimeout(1500, () => done(new Error("FunASR 10195 connect timeout")));
    socket.once("connect", () => done());
    socket.once("error", (err) => done(err));
  });
}

async function startHarness(): Promise<Harness> {
  await checkFunasrUp();
  const stub = await startStubLlm();
  // intent.mjs 的 llmConfig 从 process.env 读 light 档——指向进程内 stub（合成凭据，非真实 key）
  process.env.TANGO_AI_PROVIDER = "openai";
  process.env.TANGO_AI_URL = `http://127.0.0.1:${STUB_PORT}/v1/chat/completions`;
  process.env.TANGO_AI_KEY = "synthetic-acceptance-stub-key";
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

  const deadGateway = createVoiceGateway({
    path: "/api/voice/stream",
    asrUrl: DEAD_ASR,
    asrConnectTimeoutMs: 1500,
    authenticate: () => ({ demo: true, id: "voice-acceptance" }),
    requestAllowed: () => true,
  });
  const degraded = createVoiceLabServer({
    gateway: deadGateway,
    intentEngine: modules.intent.engine,
    gatewayMode: "module",
    intentMode: modules.intent.mode,
  });
  await listen(degraded, DEGRADED_PORT);

  return {
    main: { server: main, close: () => main.voiceLab.close() },
    degraded: { server: degraded, close: () => degraded.voiceLab.close() },
    stub,
    close: async () => {
      await Promise.allSettled([
        main.voiceLab.close(),
        degraded.voiceLab.close(),
        new Promise<void>((resolveClosed) => stub.server.close(() => resolveClosed())),
      ]);
      stub.server.closeAllConnections?.();
    },
  };
}

test.beforeAll(async () => {
  if (!harness) harness = await startHarness();
});
test.afterAll(async () => {
  await harness?.close();
  harness = null;
});

// —— 计时探针：在页面里记 firstGray（第一个灰字）/ finalBlack（停后新增定稿）/ understanding ——
async function installMarks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __va: Record<string, number> };
    w.__va = { t0: 0, firstGray: 0, firstBlack: 0, understanding: 0, tSettle: 0, finalBlack: 0, finalSnap: "" };
    const tx = document.getElementById("tx")!;
    const finals = () => Array.from(tx.querySelectorAll(".f")).map((n) => n.textContent).join("");
    w.__va.finalSnap = finals();
    new MutationObserver(() => {
      const m = w.__va;
      if (!m.firstGray && tx.querySelector(".p .ch")) m.firstGray = Date.now();
      if (!m.firstBlack && tx.querySelector(".f")) m.firstBlack = Date.now();
      if (m.tSettle) {
        const now = finals();
        if (now.length > m.finalSnap.length) { m.finalSnap = now; m.finalBlack = Date.now(); }
      }
    }).observe(tx, { childList: true, subtree: true });
    const think = document.getElementById("sheet-think")!;
    new MutationObserver(() => {
      if (!w.__va.understanding && !think.classList.contains("hidden")) w.__va.understanding = Date.now();
    }).observe(think, { attributes: true, attributeFilter: ["class"] });
  });
}
async function readMarks(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => (window as unknown as { __va: Record<string, number> }).__va);
}

// —— ① 主链路（桌面 + 手机双 project 都跑）——
test("主链路：合成音频 → 流式灰字 → 说完了 → 理解 → 事件卡 → 全部加入", async ({ page }) => {
  test.setTimeout(90_000);
  const stubHitsBefore = harness!.stub.hits();

  await page.goto(MAIN_URL);
  // 服务端装配徽章：真网关 + 真 intent（module 模式）
  await expect(page.locator("#mod-gateway")).toHaveText("asr module");
  await expect(page.locator("#mod-intent")).toHaveText("intent module");

  await installMarks(page);
  await page.evaluate(() => { (window as unknown as { __va: Record<string, number> }).__va.t0 = Date.now(); });
  await page.click("#mic");
  await expect(page.locator("#sheet-listen")).toBeVisible();

  // 开口 → 第一个灰字（首字计时，SPEC §6 门 ≤600ms）
  await page.waitForFunction(() => document.querySelector("#tx .p .ch") !== null, null, { timeout: 20_000 });
  const marks1 = await readMarks(page);
  const firstCharMs = marks1.firstGray - marks1.t0;
  expect(firstCharMs).toBeGreaterThan(0);

  // 等灰字推进到关键内容（组会|导师|报告）再手动停止——保证转写完整可断言；
  // 在 final 后 2s 自动收口前点击（finishSpeaking 会清 silence 定时器，手动停止优先）。
  // 25s 窗：FunASR 首会话冷启动时 online partial 推进慢（mobile 实测 ~10s 到关键词）。
  try {
    await page.waitForFunction(() => /组会|导师|报告/.test(document.getElementById("tx")!.textContent || ""), null, { timeout: 25_000 });
  } catch {
    const txNow = (await page.locator("#tx").textContent()) || "";
    throw new Error(`关键词（组会|导师|报告）25s 未出现在转写；#tx 实文：「${txNow.slice(0, 200)}」`);
  }
  await page.evaluate(() => { (window as unknown as { __va: Record<string, number> }).__va.tSettle = Date.now(); });
  await page.click("#doneBtn");

  // 停顿 → 该句变黑（settle 计时，SPEC §6 门 ≤1000ms）；随后转 ② 理解
  await page.waitForFunction(() => !(document.getElementById("sheet-think") as HTMLElement).classList.contains("hidden"), null, { timeout: 25_000 });
  const marks2 = await readMarks(page);
  const settleMs = (marks2.finalBlack || marks2.understanding) - marks2.tSettle;
  expect(settleMs).toBeGreaterThan(0);

  // ② 理解屏：锁定转写非空且是中文
  const locked = (await page.locator("#txLocked").textContent()) || "";
  expect(/[\u4e00-\u9fff]/.test(locked), `锁定转写无中文：${locked}`).toBeTruthy();

  // ③ 事件卡：stub(deepseek-v4.1-flash 档) 定稿 3 件事，第一件 p1「最优先」
  await expect(page.locator("#sheet-review")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#gotCount")).toHaveText("听出了 3 件事");
  await expect(page.locator("#events .ev")).toHaveCount(3);
  await expect(page.locator("#events .ev").first().locator(".chip.pri.p1")).toHaveText("最优先");
  await expect(page.locator("#events .ev").first().locator(".t")).toContainText("整理实验数据");
  // 真走了 LLM 路径：stub 被打、请求带 <transcript> 且含转写内容
  expect(harness!.stub.hits(), "stub LLM 未被调用").toBeGreaterThan(stubHitsBefore);
  const lastBody = harness!.stub.lastBody() || "";
  expect(lastBody).toContain("<transcript>");
  expect(/组会|导师|报告/.test(lastBody), `intent 请求未携带转写内容：${lastBody.slice(0, 300)}`).toBeTruthy();

  // ④ 全部加入：按优先级排序入列 + toast
  await page.click("#addAll");
  await expect(page.locator("#items .item")).toHaveCount(3);
  await expect(page.locator("#items .item b").first()).toHaveText("整理实验数据");
  await expect(page.locator("#toast")).toBeVisible();
  await expect(page.locator("#toastText")).toHaveText("已加入 3 件事");

  const project = test.info().project.name;
  const metrics = { project, firstCharMs, settleMs, finalBlackUsed: marks2.finalBlack > 0, understandingMs: marks2.understanding - marks2.tSettle, lockedTranscript: locked.slice(0, 60), stubModel: STUB_MODEL, gate: { firstCharMs: 600, settleMs: 1000 } };
  console.log(`VOICE-ACCEPT ${JSON.stringify(metrics)}`);
  writeFileSync(resolve(HERE, `../../test-results/voice-accept-${project}.json`), `${JSON.stringify(metrics, null, 2)}\n`);
});

// —— ② 停止（收敛令：1 例，仅桌面）——
test("停止：听音中点 × 取消回首页，无错误残留，可重新开始", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "收敛令：停止/降级各 1 例，仅桌面跑");
  test.setTimeout(45_000);
  await page.goto(MAIN_URL);
  await page.click("#mic");
  await expect(page.locator("#sheet-listen")).toBeVisible();
  await page.waitForTimeout(1500); // 进入流式（有无灰字均可）
  await page.click("#x1");
  await expect(page.locator("#sheet-listen")).toBeHidden();
  await expect(page.locator("#home")).toBeVisible();
  await expect(page.locator("#errline")).toBeHidden(); // 主动取消不报错
  // 状态机干净：能再次开始并再次取消
  await page.click("#mic");
  await expect(page.locator("#sheet-listen")).toBeVisible();
  await page.click("#x1");
  await expect(page.locator("#sheet-listen")).toBeHidden();
});

// —— ③ 降级（收敛令：1 例，仅桌面）：FunASR 不可达 → asr-unavailable → 打字也行 ——
test("降级：FunASR 不可达 → 提示打字也行 → 文字走通理解与事件卡", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "收敛令：停止/降级各 1 例，仅桌面跑");
  test.setTimeout(45_000);
  const stubHitsBefore = harness!.stub.hits();
  await page.goto(DEGRADED_URL);
  await expect(page.locator("#mod-gateway")).toHaveText("asr module"); // 真网关，只是上游指向死端口
  await page.click("#mic");
  await expect(page.locator("#sheet-listen")).toBeVisible();
  // SPEC §2.2：asr-unavailable → 前端文字降级（此浏览器无 webkitSpeechRecognition，落到打字）
  await expect(page.locator("#fallback")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#fallback p")).toHaveText("语音暂时不可用，打字也行");
  await expect(page.locator("#errline")).toBeHidden(); // 降级是提示不是报错
  // 打字走通全链路（含 stub LLM）
  await page.fill("#fallbackText", "明天下午三点要跟导师开组会，必须把实验数据先整理好。还有周五前交课程报告。");
  await page.click("#fallbackGo");
  await expect(page.locator("#sheet-review")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#gotCount")).toHaveText("听出了 3 件事");
  expect(harness!.stub.hits(), "降级路径 stub LLM 未被调用").toBeGreaterThan(stubHitsBefore);
});
