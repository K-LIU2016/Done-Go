// tests/story/story-lab.spec.ts — 时光故事书第一期验收 E2E（收敛令 2026-10-25）。
//
// 范围（lab = scripts/story-lab.mjs + web/story/lab.html，只读被测对象，本文件只做验收）：
//   · 月章主路径：示例数据生成 → 封面 → 翻开（断言 AudioContext state=running）
//     → 逐页前进 10 页 → 长按数字弹口径卡 → 写心愿 → 海报导出（PNG 1080×1920）
//     → 书架出现本章；期间 rAF 采帧实测翻页长帧比例（SPEC §8 长帧 < 5% 门）。
//   · 周记 / 年书 / 短章各 1 条最短冒烟（页数契约 + 翻一页能渲染）。
//   · 桌面 + 手机双 project（tests/story/playwright.story.config.ts）。
//
// 环境事实（如实记录，验收证据引用）：
//   1. lab.html 海报页按钮未接 ctx.onSavePoster（renderPosterPage 将其禁用）；
//      海报导出按 poster.js posterBlob（renderPosterCanvas 1080×1920 →
//      canvas.toBlob PNG）在真实浏览器里驱动——按钮接通后走的同一管线。
//   2. lab.html 生成章节不落 tango-donego.story.v1；书架断言用
//      store.js createStoryStore().addChapter 真实落盘，再由 shelf.js
//      mountShelf 从 localStorage 读回渲染（存储→书架全链）。
//   3. soundtrack session 不暴露 AudioContext；用 addInitScript 包一层
//      构造器记录实例，断言「翻开」手势后 state=running。

import { expect, test } from '@playwright/test';

const LAB_PATH = '/story/lab.html';
const PAGE_SETTLE_MS = 350; // 每页动画起步的稳定等待（也保证 rAF 采样窗口）

// ---------------------------------------------------------------------------
// 工具：AudioContext 观测（addInitScript，先于任何页面模块执行）
// ---------------------------------------------------------------------------
const HOOK_AUDIO_CONTEXT = `(() => {
  const seen = [];
  const wrap = (Orig) => {
    if (typeof Orig !== 'function') return undefined;
    const Inner = function (...args) {
      const ctx = Reflect.construct(Orig, args);
      try { seen.push(ctx); } catch (e) {}
      return ctx;
    };
    Reflect.setPrototypeOf(Inner, Orig);
    Object.defineProperty(Inner, 'name', { value: Orig.name, configurable: true });
    return Inner;
  };
  const define = (key, value) => {
    if (value === undefined) return;
    try { Object.defineProperty(window, key, { value, writable: true, configurable: true }); } catch (e) {}
  };
  define('__stAudioContexts', seen);
  define('AudioContext', wrap(window.AudioContext));
  define('webkitAudioContext', wrap(window.webkitAudioContext));
})();`;

// rAF 长帧采样：长帧 = 相邻帧间隔 > 50ms（60fps 下连掉 3+ 帧）。
const INSTALL_FRAME_MONITOR = `(() => {
  const LONG_MS = 50;
  const f = { total: 0, long: 0, max: 0, t0: null, last: null };
  window.__stFrames = f;
  const loop = (t) => {
    if (f.t0 == null) f.t0 = t;
    if (f.last != null) {
      const d = t - f.last;
      f.total += 1;
      if (d > LONG_MS) f.long += 1;
      if (d > f.max) f.max = d;
    }
    f.last = t;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
})();`;

const audioStates = (page) =>
  page.evaluate(() => (window.__stAudioContexts || []).map((c) => c.state));

async function generateChapter(page, type /* 'week' | 'month' | 'year' | 'short' */) {
  await page.goto(LAB_PATH);
  await page.locator(`#typeSeg button[data-type="${type}"]`).click();
  await page.locator('#gen').click();
  await expect(page.locator('#meta')).toContainText(/第 \d+ 章/, { timeout: 20000 });
  await expect(page.locator('#note')).not.toContainText('失败');
  await expect(page.locator('.st-open')).toBeVisible({ timeout: 10000 }); // 封面已可翻开
}

async function readChapterJson(page) {
  const text = await page.locator('#json').textContent();
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// 月章主路径（验收核心：音频 + 口径卡 + 心愿 + 海报 + 书架 + 长帧门）
// ---------------------------------------------------------------------------
test('月章主路径：生成→封面→翻开(音频running)→逐页10页→长按口径卡→写心愿→导出海报1080×1920→书架出现本章', async ({ page }) => {
  test.setTimeout(120000);

  await page.addInitScript(HOOK_AUDIO_CONTEXT);
  await generateChapter(page, 'month');

  // 章型与页数契约：月章 10 页（SPEC §3 页面库）
  const meta = page.locator('#meta');
  await expect(meta).toContainText('月章');
  await expect(page.locator('#bars i')).toHaveCount(10);

  const chapterBefore = await readChapterJson(page);
  expect(chapterBefore.type).toBe('month');
  expect(chapterBefore.pages).toHaveLength(10);
  const eventsTotal = chapterBefore.stats.totals.events;
  expect(eventsTotal).toBeGreaterThanOrEqual(5); // full 月章数据充足（短章 <5 另测）

  // --- 翻开前记录 AudioContext 状态（只记录不硬断言：headless Chromium 默认
  //     放宽自动播放策略，prepare() 建的 ctx 可能已是 running；「需手势才出声」
  //     是 iOS Safari 行为，SPEC §8 明确交 JC 实机验证，本线不冒认） ---
  const preStates = await audioStates(page);

  // --- 翻开（封面手势）→ AudioContext state=running ---
  await page.locator('.st-open').click();
  await page.waitForFunction(
    () => {
      const list = window.__stAudioContexts || [];
      return list.length > 0 && list.every((c) => c.state === 'running');
    },
    null,
    { timeout: 10000 },
  );
  const postStates = await audioStates(page);
  expect(postStates.length, '至少一个 AudioContext').toBeGreaterThan(0);
  expect(new Set(postStates).has('running'), `翻开后 AudioContext 状态（post=${JSON.stringify(postStates)}）`).toBe(true);
  await expect(page.locator('#note')).not.toContainText('配乐未能启动');

  // --- 逐页前进（第 2 → 第 10 页），期间采帧 ---
  await page.evaluate(INSTALL_FRAME_MONITOR);

  for (let target = 1; target <= 9; target += 1) {
    await page.locator('#tapR').click();
    await expect(page.locator('#chromeLabel')).toContainText(`第 ${target + 1} 页`);
    await page.waitForTimeout(PAGE_SETTLE_MS);

    if (target === 1) {
      // --- 第 2 页（开篇数字）：长按大数字 → 口径卡（数据源/计算方式/样本数） ---
      const num = page.locator('.st-num[data-metric="totals.events"]');
      await expect(num).toBeVisible();
      const box = await num.boundingBox();
      expect(box, '.st-num boundingBox').not.toBeNull();
      // 取元素中线上一点；.st-num 是整行块，中心 x 落在中间 32% 免点按区（左右 34% 是翻页热区）
      const cx = box.x + box.width / 2;
      const cy = box.y + Math.min(box.height / 2, 80);
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.waitForTimeout(650); // lab.html METRIC_PRESS_MS = 500
      await page.mouse.up();

      const card = page.locator('.st-metric-card');
      await expect(card).toBeVisible({ timeout: 5000 });
      await expect(card.locator('h4')).toHaveText('totals.events');
      const rows = await card.locator('dl > div').evaluateAll((divs) =>
        divs.map((div) => ({
          k: div.querySelector('dt') ? div.querySelector('dt').textContent : '',
          v: div.querySelector('dd') ? div.querySelector('dd').textContent : '',
        })),
      );
      const keys = rows.map((r) => r.k);
      for (const field of ['指标', '数据源', '计算方式', '样本数']) {
        expect(keys, `口径卡字段完整（rows=${JSON.stringify(rows)}）`).toContain(field);
      }
      const sampleRow = rows.find((r) => r.k === '样本数');
      expect(Number(sampleRow.v), `样本数=本期事项数（row=${JSON.stringify(sampleRow)}）`).toBe(eventsTotal);
      await card.locator('.st-metric-close').click();
      await expect(page.locator('#metricHost')).toBeHidden();
    }

    if (target === 8) {
      // --- 第 9 页（写给下一章）：写心愿 → 存进本章 ---
      const wishText = '下个月早点睡，每周运动两次';
      const input = page.locator('textarea.wish-input');
      await expect(input).toBeEditable();
      await input.fill(wishText);
      await page.locator('button.save').click();
      await expect(page.locator('#note')).toContainText('心愿已写进本章');
      await expect(page.locator('#note')).toContainText(wishText);
      const saved = await readChapterJson(page);
      expect(saved.wish && saved.wish.text, '心愿写进章节 JSON').toContain(wishText);
    }
  }

  // --- 第 10 页：海报页渲染到位 ---
  await expect(page.locator('[data-story-page="poster"]')).toBeVisible();

  // --- 海报导出：poster.js 真实管线（fonts.ready → 1080×1920 canvas → PNG blob） ---
  const poster = await page.evaluate(async () => {
    const chapter = JSON.parse(document.getElementById('json').textContent);
    const posterMod = await import('/story/poster.js');
    const blob = await posterMod.posterBlob(chapter);
    const bitmap = await createImageBitmap(blob);
    const out = {
      mime: blob.type,
      bytes: blob.size,
      width: bitmap.width,
      height: bitmap.height,
      filename: posterMod.posterFilename(chapter),
    };
    bitmap.close();
    return out;
  });
  expect(poster.mime, '导出为 PNG').toBe('image/png');
  expect(poster.width, '海报宽度 1080（SPEC §8）').toBe(1080);
  expect(poster.height, '海报高度 1920（SPEC §8）').toBe(1920);
  expect(poster.bytes, 'PNG 非空').toBeGreaterThan(10000);

  // --- 书架：真实落盘（store）→ 读回渲染（shelf）→ 本章出现 ---
  const shelfInfo = await page.evaluate(async () => {
    const KEY = 'tango-donego.story.v1';
    const chapter = JSON.parse(document.getElementById('json').textContent);
    const storeMod = await import('/story/store.js');
    const shelfMod = await import('/story/shelf.js');
    const store = storeMod.createStoryStore({ storage: window.localStorage });
    const added = store.addChapter(chapter);
    const host = document.createElement('section');
    host.id = 'st-shelf-probe';
    host.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99;background:#fff;padding:10px;border-radius:8px;max-width:420px';
    document.body.appendChild(host);
    const model = shelfMod.mountShelf(host, { loadText: () => window.localStorage.getItem(KEY) });
    const book = host.querySelector('[aria-label^="重看第"]');
    return {
      added: !!added,
      storedRaw: !!window.localStorage.getItem(KEY),
      count: model.count,
      header: host.querySelector('h2') ? host.querySelector('h2').textContent : null,
      bookAria: book ? book.getAttribute('aria-label') : null,
      statsLine: book ? book.textContent : null,
      actionButtons: Array.from(host.querySelectorAll('button'))
        .map((b) => b.textContent.trim())
        .filter((t) => ['重看', '重播', '海报'].includes(t)),
      wishKept: added && added.wish ? added.wish.text : null,
    };
  });
  expect(shelfInfo.added, '章节经 store.addChapter 落盘').toBe(true);
  expect(shelfInfo.storedRaw, 'localStorage 出现 tango-donego.story.v1').toBe(true);
  expect(shelfInfo.count, '书架 1 章').toBe(1);
  expect(shelfInfo.header).toBe('我的故事书');
  expect(shelfInfo.bookAria, `书架封面 aria（=${shelfInfo.bookAria}）`).toContain('第 10 章');
  expect(shelfInfo.bookAria).toContain('月章');
  expect(shelfInfo.actionButtons, '书架三个动作（SPEC §2）').toEqual(['重看', '重播', '海报']);
  expect(shelfInfo.wishKept, '落盘章节保留心愿').toContain('早点睡');

  // --- 长帧门：翻页过程 rAF 实测，长帧比例 < 5%（SPEC §8） ---
  const frames = await page.evaluate(() => {
    const f = window.__stFrames;
    return {
      total: f.total,
      long: f.long,
      maxMs: Math.round(f.max),
      elapsedMs: f.t0 != null && f.last != null ? Math.round(f.last - f.t0) : 0,
    };
  });
  const longFramePct = frames.total > 0 ? (frames.long / frames.total) * 100 : 100;
  console.log(
    `[longFramePct] project=${test.info().project.name} pct=${longFramePct.toFixed(2)}% ` +
    `(long=${frames.long}/total=${frames.total}, max=${frames.maxMs}ms, window=${frames.elapsedMs}ms, ` +
    `audio=${JSON.stringify({ pre: preStates, post: postStates })})`,
  );
  test.info().attachments.push({
    name: `long-frames-${test.info().project.name}`,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ ...frames, longFramePct }, null, 2)),
  });
  expect(frames.total, 'rAF 采样帧数下限（测量有效性）').toBeGreaterThanOrEqual(60);
  expect(longFramePct, `翻页长帧比例 ${longFramePct.toFixed(2)}%（长帧 ${frames.long}/${frames.total}，最长 ${frames.maxMs}ms）`).toBeLessThan(5);
});

// ---------------------------------------------------------------------------
// 周 / 年 / 短：各 1 条最短冒烟（收敛令）
// ---------------------------------------------------------------------------
test('周记冒烟：生成 5 页（周页序契约），翻一页可渲染', async ({ page }) => {
  await page.addInitScript(HOOK_AUDIO_CONTEXT);
  await generateChapter(page, 'week');
  await expect(page.locator('#meta')).toContainText('周记');
  await expect(page.locator('#bars i')).toHaveCount(5);
  await page.locator('#tapR').click();
  await expect(page.locator('#chromeLabel')).toContainText('第 2 页');
  await expect(page.locator('.st-num[data-metric="totals.events"]')).toBeVisible();
});

test('年书冒烟：生成 16 页（月章页型+年度专属），翻一页可渲染', async ({ page }) => {
  await page.addInitScript(HOOK_AUDIO_CONTEXT);
  await generateChapter(page, 'year');
  await expect(page.locator('#meta')).toContainText('年书');
  await expect(page.locator('#bars i')).toHaveCount(16);
  await page.locator('#tapR').click();
  await expect(page.locator('#chromeLabel')).toContainText('第 2 页');
  await expect(page.locator('.st-num[data-metric="totals.events"]')).toBeVisible();
});

test('短章冒烟：数据不足（<5 件事）生成 3 页短章', async ({ page }) => {
  await page.addInitScript(HOOK_AUDIO_CONTEXT);
  await generateChapter(page, 'short');
  await expect(page.locator('#meta')).toContainText('短章');
  await expect(page.locator('#bars i')).toHaveCount(3);
  await page.locator('#tapR').click();
  await expect(page.locator('#chromeLabel')).toContainText('第 2 页');
  await expect(page.locator('.st-num[data-metric="totals.events"]')).toBeVisible();
});
