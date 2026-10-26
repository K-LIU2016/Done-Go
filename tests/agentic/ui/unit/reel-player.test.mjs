// M17 预演片全屏播放器 单测（RED 先行 · 实现前必红）
// 依据：plan.md M17、PRD §5.2.4（预演片：全屏播放器、字幕 aria-live、3px 进度、
//   暂停/继续/重播/关闭、Esc 关、旁白 speechSynthesis 逐句 + 无 TTS 降级 + 9s 兜底、
//   「示意」水印、reduced-motion 全降级）、§5.8（动画尊重 reduced motion）、
//   prototype.html（唯一视觉/交互标准）：
//   L165-177  .reel 全屏遮罩 / .stage 16:9 / .shot opacity 过渡 + .on img kb 7s / .cap / .prog 3px / .ctl
//   L184-185  @keyframes kb（scale 1→1.09 translate）+ prefers-reduced-motion 全降级
//   L539-560  reelShots/openReel 结构原文（role=dialog aria-label=今日预演片、.wm 示意、cap aria-live=polite）
//   L562-576  nextShot：.on 切换、字幕 at+text、prog=(i+1)/n、TTS onend→250ms 推进、onerror→3500ms、9s 兜底、无 TTS 4500ms
//   L577      closeReel：清定时器 + speechSynthesis.cancel + 移除遮罩
//   L623      暂停钮：暂停↔继续、播完变重播（重开）、暂停 cancel / 继续 reelIdx-=1 重播当前镜
//   L648      Esc 关闭
// 契约：web/agentic/ui/reel-player.js 具名导出
//   WATERMARK / DIALOG_LABEL / BTN_PAUSE / BTN_RESUME / BTN_REPLAY / BTN_CLOSE /
//   LANG / RATE / ADVANCE_MS / NO_TTS_MS / TTS_ERROR_MS / HARD_FIN_MS /
//   esc / setHTML / normShot / shotHTML / capHTML / ctlHTML / reelHTML /
//   progressPct / ctlLabel / REEL_CSS / ensureStyles /
//   defaultSchedule / defaultSpeech / createSequencer / mount
// W11 薄接缝（plan §1.5）：shots[].body 为外部合成 HTML 原样入镜（受信宿主合成，不二次转义；
//   data-start/duration 时间轴驱动留 TODO，见实现注释）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WATERMARK, DIALOG_LABEL, BTN_PAUSE, BTN_RESUME, BTN_REPLAY, BTN_CLOSE,
  LANG, RATE, ADVANCE_MS, NO_TTS_MS, TTS_ERROR_MS, HARD_FIN_MS,
  esc, setHTML, normShot, shotHTML, capHTML, ctlHTML, reelHTML,
  progressPct, ctlLabel, REEL_CSS, ensureStyles,
  defaultSchedule, defaultSpeech, createSequencer, mount,
} from '../../../../web/agentic/ui/reel-player.js';

// spec 同源黄金三镜（tests/agentic/ui/reel-player.spec.ts SHOTS）
const SHOTS = [
  { at: '13:30 · 研究员 ×3', body: '<img src="assets/illus-lesson.jpg" alt="">', text: '下午一点半，我先派三个研究员分头找资料。' },
  { at: '13:55 · 需要你 30 秒', body: '<div class="cover"></div>', text: '两点前需要你确认一下受众，三十秒就好。' },
  { at: '15:00 · 课程设计接力', body: '<div class="slide"></div>', text: '三点开始做课程设计，直接用研究结论。' },
];

// ---------- 可注入定时器 / 语音桩（storyboard.test 同款思路） ----------

function fakeClock() {
  const jobs = [];
  return {
    jobs,
    schedule(fn, ms) {
      const j = { fn, ms, run: false, cancelled: false };
      jobs.push(j);
      return () => { j.cancelled = true; };
    },
    fire(i) { const j = jobs[i]; assert.ok(j && !j.cancelled && !j.run, `任务 ${i} 可触发`); j.run = true; j.fn(); },
    firePending() { // 依序触发全部未跑未取消任务（含触发中新排入的），直到静默
      for (let i = 0; i < jobs.length; i += 1) {
        const j = jobs[i];
        if (!j.cancelled && !j.run) { j.run = true; j.fn(); }
      }
    },
    live: () => jobs.filter((j) => !j.cancelled && !j.run).length,
  };
}

function fakeSpeech(available = true) {
  const s = {
    available, spoken: [], cancels: 0, handlers: null,
    speak(text, h) { s.spoken.push(text); s.handlers = h; },
    cancel() { s.cancels += 1; }, // 不清 handlers：模拟 cancel 迟发 onend 的竞态（epoch 守卫必须挡住）
    end() { s.handlers?.onend?.(); },
    err() { s.handlers?.onerror?.(); },
  };
  return s;
}

// ---------- 纯核：HTML 构建（prototype L553-561 openReel 结构原文） ----------

test('M17 reelHTML：.reel[role=dialog][aria-label=今日预演片] > div > .stage + .ctl 全结构（L553-560）', () => {
  const html = reelHTML(SHOTS);
  assert.ok(html.startsWith('<div class="reel" role="dialog" aria-label="今日预演片">'), '遮罩根 + role + aria-label');
  assert.ok(html.includes('<div class="stage">'), '16:9 舞台（比例本体在 REEL_CSS）');
  assert.ok(html.includes('<div class="prog"></div>'), '顶部进度条先于镜头（L558）');
  assert.equal((html.match(/<div class="shot" data-i=/g) || []).length, 3, '三镜 data-i 0..2');
  assert.ok(html.includes('data-i="0"') && html.includes('data-i="2"'));
  const cap = html.match(/<div class="cap" aria-live="polite">.*?<\/div>/)[0];
  assert.ok(cap.includes('<small>'), '字幕小标 at（L558 small）');
  assert.ok(cap.includes('<span>'), '字幕正文（L558 span）');
  assert.ok(cap.includes(SHOTS[0].at) && cap.includes(SHOTS[0].text), '首镜字幕已入（mount 即第一镜）');
  assert.ok(html.includes(`<span class="wm">${WATERMARK}</span>`), '示意水印在 stage 内（L558）');
  assert.ok(html.endsWith('<div class="ctl"><button type="button" data-reel-ctl="toggle">暂停</button><button type="button" data-reel-ctl="close">关闭</button></div></div></div>'), '控制排：暂停 + 关闭（L559）');
});

test('M17 reelHTML 容错：空 shots 不炸、cap 空壳仍渲染、零镜', () => {
  const html = reelHTML([]);
  assert.ok(html.startsWith('<div class="reel"'));
  assert.equal((html.match(/<div class="shot"/g) || []).length, 0);
  assert.ok(html.includes('<div class="cap" aria-live="polite"><small></small><span></span></div>'), '空字幕壳保留（aria-live 常驻）');
  assert.equal(reelHTML(undefined), reelHTML([]), '非数组容忍为空');
  const holes = reelHTML([null, SHOTS[0], undefined]);
  assert.equal((holes.match(/<div class="shot"/g) || []).length, 1, 'null/undefined 镜过滤');
});

test('M17 shotHTML：data-i + body 外部合成 HTML 原样入镜（W11 薄接缝，plan §1.5）', () => {
  assert.equal(shotHTML(SHOTS[0], 0), `<div class="shot" data-i="0">${SHOTS[0].body}</div>`);
  assert.equal(shotHTML({ body: '<div class="slide"><h4>代码排版</h4></div>' }, 7), '<div class="shot" data-i="7"><div class="slide"><h4>代码排版</h4></div></div>');
  assert.equal(shotHTML(null, 0), '', '非对象镜不渲染');
});

test('M17 capHTML：at/text 五实体转义 + small+span 结构（L558；at/text 是外部字符串必经 esc）', () => {
  assert.equal(capHTML(SHOTS[0]), `<small>${esc(SHOTS[0].at)}</small><span>${esc(SHOTS[0].text)}</span>`);
  const evil = capHTML({ at: '<script>x</script>', text: 'a&b<c>"d"' });
  assert.ok(evil.includes('<small>&lt;script&gt;x&lt;/script&gt;</small>'), 'at 全转义');
  assert.ok(evil.includes('<span>a&amp;b&lt;c&gt;&quot;d&quot;</span>'), 'text 五实体转义');
  assert.equal(capHTML({}), '<small></small><span></span>', '缺字段空串不炸');
});

test('M17 normShot：对象形归一补缺省，非对象归 null（null 镜过滤的归一来源）', () => {
  assert.deepEqual(normShot({ at: 'a', body: 'b', text: 't' }), { at: 'a', body: 'b', text: 't' });
  assert.deepEqual(normShot({ at: 1, body: 2 }), { at: '1', body: '2', text: '' }, '缺 text 补空串、值归字符串');
  assert.equal(normShot(null), null);
  assert.equal(normShot('x'), null);
  assert.equal(normShot(undefined), null);
});

test('M17 ctlHTML / ctlLabel：暂停/继续/重播三态，播完优先重播（L623 nextShot 播完置「重播」）', () => {
  assert.equal(ctlHTML(), `<button type="button" data-reel-ctl="toggle">${BTN_PAUSE}</button><button type="button" data-reel-ctl="close">${BTN_CLOSE}</button>`);
  assert.equal([BTN_PAUSE, BTN_RESUME, BTN_REPLAY, BTN_CLOSE].join(','), '暂停,继续,重播,关闭');
  assert.equal(ctlLabel({ idx: 0, len: 3, paused: false }), BTN_PAUSE);
  assert.equal(ctlLabel({ idx: 1, len: 3, paused: true }), BTN_RESUME);
  assert.equal(ctlLabel({ idx: 3, len: 3, paused: false }), BTN_REPLAY, '播完（idx≥len）变重播');
  assert.equal(ctlLabel({ idx: 5, len: 3, paused: true }), BTN_REPLAY, '播完优先于暂停态');
  assert.equal(ctlLabel({ idx: 0, len: 0, paused: false }), BTN_REPLAY, '零镜即播完');
});

test('M17 progressPct：(i+1)/len，播完钳 100，len≤0 归 0（L566 原式）', () => {
  assert.ok(Math.abs(progressPct(0, 3) - 100 / 3) < 1e-9);
  assert.equal(progressPct(2, 3), 100);
  assert.equal(progressPct(3, 3), 100, '越界钳 100');
  assert.equal(progressPct(9, 3), 100);
  assert.equal(progressPct(0, 0), 0);
  assert.equal(progressPct(0, -2), 0);
});

// ---------- 纯核：REEL_CSS（prototype L165-177/L184-185 视觉标准组件级兜底） ----------

test('M17 REEL_CSS：16:9 舞台 / kb 7s 仅 .on img / 3px 进度 / rm 全降级（L167-172/L175/L185）', () => {
  assert.ok(/\.reel\s+\.stage[^}]*aspect-ratio:\s*16\s*\/\s*9/.test(REEL_CSS), 'stage 16:9');
  assert.ok(/\.reel\s+\.shot\.on\s+img\s*\{[^}]*animation:\s*kb\s+7s/.test(REEL_CSS), 'Ken Burns 仅 .on img 7s');
  assert.ok(!/\.shot(:not\(\.on\)|\s)[^{]*\{[^}]*animation:\s*kb/.test(REEL_CSS.replace(/\.reel \.shot\.on img \{[^}]*\}/, '')), '非 .on 不挂 kb');
  assert.ok(REEL_CSS.includes('@keyframes kb'), 'kb 关键帧本体');
  assert.ok(/from\s*\{\s*transform:\s*scale\(1\)/.test(REEL_CSS) && /to\s*\{\s*transform:\s*scale\(1\.09\)\s+translate\(-2%,\s*-1%\)/.test(REEL_CSS), 'kb 推近幅度照原型（L172）');
  assert.ok(/\.reel\s+\.prog\s*\{[^}]*height:\s*3px/.test(REEL_CSS), '3px 进度条');
  assert.ok(/\.reel\s+\.shot\s*\{[^}]*transition:\s*opacity\s+\.6s/.test(REEL_CSS), 'opacity .6s 切换');
  const rm = REEL_CSS.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\}/)?.[0] ?? '';
  assert.ok(rm.includes('animation: none !important') && rm.includes('transition: none !important'), 'rm 无动画无过渡（L185 全降级）');
  assert.ok(/\.reel\s*\{[^}]*position:\s*fixed[^}]*inset:\s*0/.test(REEL_CSS.replace(/\n/g, ' ')), '全屏遮罩 fixed inset 0');
});

test('M17 ensureStyles：幂等注入、无 document 安全跳过（boundaries ensureStyles 同款）', () => {
  assert.equal(ensureStyles(null), false, '无 doc 不炸');
  let appended = 0;
  const styleStub = { setAttribute() {}, textContent: '' };
  const doc = {
    _tag: null,
    querySelector: (sel) => doc._tag && sel === 'style[data-agentic-reel]' ? doc._tag : null,
    createElement: () => ({ ...styleStub, setAttribute(k, v) { if (k === 'data-agentic-reel') doc._tag = this; } }),
    head: { appendChild: () => { appended += 1; return null; } },
  };
  assert.equal(ensureStyles(doc), true);
  assert.equal(appended, 1);
  assert.equal(ensureStyles(doc), false, '第二次注入跳过（幂等）');
});

// ---------- Sequencer：旁白驱动（prototype L562-576 nextShot 的可注入重写） ----------

test('M17 无 TTS 降级：每镜 NO_TTS_MS(4500ms)，逐镜推进，播完 onFinish 恰一次（L575 else 分支）', () => {
  const clock = fakeClock();
  const shown = []; let fins = 0;
  const seq = createSequencer({
    shots: SHOTS, speech: { available: false }, schedule: clock.schedule,
    onShot: (i) => shown.push(i), onFinish: () => { fins += 1; },
  });
  assert.equal(NO_TTS_MS, 4500, 'plan/prototype L575：无 TTS 4.5s/句');
  seq.start();
  assert.deepEqual(shown, [0], 'start 同步出第一镜');
  assert.equal(clock.jobs[0].ms, NO_TTS_MS, '首镜定时 = 4500ms');
  clock.fire(0); // 第 1 镜读完
  assert.equal(clock.jobs[1].ms, ADVANCE_MS, '句间 250ms（L565 go）');
  assert.equal(ADVANCE_MS, 250);
  clock.fire(1); // gap 到点 → 第 2 镜
  assert.deepEqual(shown, [0, 1]);
  clock.fire(2); clock.fire(3); clock.fire(4); clock.fire(5); // 镜2 读完 + gap → 镜3 读完 + gap → 播完
  assert.deepEqual(shown, [0, 1, 2]);
  assert.equal(fins, 1, 'onFinish 恰一次');
  assert.equal(seq.finished, true);
  clock.firePending(); // 迟到的多余定时器（若有）不得再推进
  assert.equal(fins, 1);
  assert.deepEqual(shown, [0, 1, 2]);
});

test('M17 TTS 逐句：speak(text) 按镜推进、zh-CN、onend→250ms 接下一镜（L564-569）', () => {
  assert.equal(LANG, 'zh-CN'); assert.equal(RATE, 1.1);
  const clock = fakeClock();
  const sp = fakeSpeech(true);
  const shown = [];
  const seq = createSequencer({ shots: SHOTS, speech: sp, schedule: clock.schedule, onShot: (i) => shown.push(i), onFinish: () => {} });
  seq.start();
  assert.deepEqual(sp.spoken, [SHOTS[0].text], '先出镜再念（onShot 同步 + speak 首句）');
  assert.ok(clock.jobs.some((j) => j.ms === HARD_FIN_MS), '每镜挂 9s 兜底（L570）');
  assert.equal(HARD_FIN_MS, 9000);
  sp.end(); // 首句念完
  assert.ok(clock.jobs.some((j) => j.ms === ADVANCE_MS && !j.run), 'onend → 250ms 后下一镜');
  clock.jobs.filter((j) => j.ms === ADVANCE_MS).forEach((j) => { if (!j.run) clock.fire(clock.jobs.indexOf(j)); });
  assert.deepEqual(shown, [0, 1]);
  assert.deepEqual(sp.spoken, [SHOTS[0].text, SHOTS[1].text], '第二句接续');
});

test('M17 TTS onerror → 3500ms 兜底推进（L568 u.onerror=setTimeout(fin,3500)）', () => {
  assert.equal(TTS_ERROR_MS, 3500);
  const clock = fakeClock();
  const sp = fakeSpeech(true);
  const shown = [];
  const seq = createSequencer({ shots: SHOTS, speech: sp, schedule: clock.schedule, onShot: (i) => shown.push(i), onFinish: () => {} });
  seq.start();
  sp.err(); // 首句出错
  const errJob = clock.jobs.find((j) => j.ms === TTS_ERROR_MS);
  assert.ok(errJob, 'onerror 排 3500ms 兜底');
  clock.fire(clock.jobs.indexOf(errJob)); // 兜底到点 → fin → 250ms gap
  const gap = clock.jobs.find((j) => j.ms === ADVANCE_MS && !j.run);
  assert.ok(gap, 'fin 后照常 250ms 接续');
  clock.fire(clock.jobs.indexOf(gap));
  assert.deepEqual(shown, [0, 1]);
});

test('M17 9s 硬兜底 + fin 单次守卫：onend 先到，9s 定时器再 fire 不双推（L567 done 标志）', () => {
  const clock = fakeClock();
  const sp = fakeSpeech(true);
  const shown = [];
  const seq = createSequencer({ shots: SHOTS, speech: sp, schedule: clock.schedule, onShot: (i) => shown.push(i), onFinish: () => {} });
  seq.start();
  const hard = clock.jobs.find((j) => j.ms === HARD_FIN_MS && !j.run);
  sp.end(); // onend 先 fire
  const before = shown.length;
  clock.fire(clock.jobs.indexOf(hard)); // 迟到的 9s 兜底不得二次推进
  assert.equal(shown.length, before, 'fin 已消费：9s 再 fire 零效果');
  assert.equal(clock.live(), 1, '只剩 gap 定时器');
});

test('M17 pause：取消挂起定时器 + speech.cancel；迟到的 onend 不得推进（L623 暂停分支）', () => {
  const clock = fakeClock();
  const sp = fakeSpeech(true);
  const shown = [];
  const seq = createSequencer({ shots: SHOTS, speech: sp, schedule: clock.schedule, onShot: (i) => shown.push(i), onFinish: () => {} });
  seq.start();
  assert.equal(seq.pause(), true);
  assert.equal(seq.paused, true);
  assert.equal(sp.cancels, 2, '开场念首句前 cancel（prototype L568 nextShot 先 cancel）+ 暂停 cancel');
  assert.equal(clock.live(), 0, '挂起定时器全取消');
  sp.end(); // cancel 后浏览器补发 onend 的竞态：epoch 守卫必须挡住
  clock.firePending(); // 任何残留 fire 也不推进
  assert.deepEqual(shown, [0]);
  assert.equal(seq.pause(), false, '重复暂停 false');
});

test('M17 resume：重放当前镜（reelIdx-=1 + nextShot 语义，L623 继续分支）', () => {
  const clock = fakeClock();
  const shown = [];
  const seq = createSequencer({ shots: SHOTS, speech: { available: false }, schedule: clock.schedule, onShot: (i) => shown.push(i), onFinish: () => {} });
  seq.start();
  clock.fire(0); clock.fire(1); // → 镜 1
  assert.deepEqual(shown, [0, 1]);
  seq.pause();
  assert.equal(seq.resume(), true, '继续成功');
  assert.deepEqual(shown, [0, 1, 1], '重放当前镜 1（从头念这句）');
  assert.equal(seq.paused, false);
  assert.equal(seq.resume(), false, '未暂停时 resume false');
  clock.firePending(); // 重放镜 1 读完 + gap → 镜 2（此后顺跑到完不反弹）
  assert.deepEqual(shown, [0, 1, 1, 2]);
});

test('M17 next/stop：手动切镜 epoch 换代杀挂起；stop 后一切死（L577 closeReel 清理）', () => {
  const clock = fakeClock();
  const sp = fakeSpeech(true);
  const shown = [];
  const seq = createSequencer({ shots: SHOTS, speech: sp, schedule: clock.schedule, onShot: (i) => shown.push(i), onFinish: () => {} });
  seq.start();
  seq.next(); seq.next(); // 手动连切（spec：handle.next()×N）
  assert.deepEqual(shown, [0, 1, 2]);
  seq.next(); // 越过末镜 → 播完
  assert.equal(seq.finished, true);
  sp.end(); // 旧句迟到的 onend：不得复活
  clock.firePending();
  assert.deepEqual(shown, [0, 1, 2], '播完零额外推进');
  const sp2 = fakeSpeech(true);
  const seq2 = createSequencer({ shots: SHOTS, speech: sp2, schedule: clock.schedule, onShot: (i) => shown.push(i), onFinish: () => {} });
  seq2.start(); seq2.stop(); // 开场第一镜后立即停
  assert.equal(sp2.cancels, 2, 'start 首句前 cancel + stop cancel');
  clock.firePending();
  assert.deepEqual(shown, [0, 1, 2, 0], 'stop 后定时器全死（seq2 仅开场第一镜，零后续）');
});

test('M17 defaultSchedule/defaultSpeech：node 无 window 的安全退化', () => {
  const cancel = defaultSchedule(() => {}, 10);
  assert.equal(typeof cancel, 'function', '返回取消函数');
  cancel();
  const none = defaultSpeech(undefined);
  assert.equal(none.available, false);
  assert.equal(typeof none.speak, 'function' && typeof none.cancel, 'function');
});

test('M17 defaultSpeech 浏览器分支：逐句装配 zh-CN/rate1.1、onend/onerror 透传、cancel 直达（L564-569）', () => {
  const spoken = [];
  const win = {
    speechSynthesis: { speak: (u) => spoken.push(u), cancel() { spoken.push('cancel'); } },
    SpeechSynthesisUtterance: class { constructor(t) { this.text = t; } },
  };
  const s = defaultSpeech(win);
  assert.equal(s.available, true);
  let ended = false; let erred = false;
  s.speak('第一句', { onend: () => { ended = true; }, onerror: () => { erred = true; } });
  assert.equal(spoken[0].text, '第一句');
  assert.equal(spoken[0].lang, LANG, 'zh-CN');
  assert.equal(spoken[0].rate, RATE, 'rate 1.1');
  spoken[0].onend(); spoken[0].onerror();
  assert.equal(ended && erred, true, 'onend/onerror 原样透传');
  s.cancel();
  assert.equal(spoken[1], 'cancel');
  assert.equal(defaultSpeech({ speechSynthesis: { speak() {}, cancel() {} } }).available, false, '缺 SpeechSynthesisUtterance → 不可用');
  assert.equal(defaultSpeech({ SpeechSynthesisUtterance: class {} }).available, false, '缺 speechSynthesis → 不可用');
});

// ---------- DOM 壳（mount）· 桩同 gallery/storyboard 模式 ----------

// 壳测试统一注入假定时器（不挂真实 setTimeout，进程即测即退）
const STUB_SCHED = fakeClock().schedule;

function stubNode(tag, cls) {
  const classes = new Set(cls ? cls.split(/\s+/).filter(Boolean) : []);
  return {
    tag, classes, style: {}, attrs: {}, dataset: {}, textContent: '',
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    get classList() {
      const s = this.classes;
      return {
        add: (...c) => c.forEach((x) => s.add(x)),
        remove: (...c) => c.forEach((x) => s.delete(x)),
        toggle(c, f) { const on = f === undefined ? !s.has(c) : !!f; if (on) s.add(c); else s.delete(c); return on; },
        contains: (c) => s.has(c),
      };
    },
    closest(sel) { return sel.includes('data-reel-ctl') && this.dataset.reelCtl ? this : null; },
  };
}

function stubHost() {
  return {
    _v: '', writes: 0, listeners: {}, map: {}, lists: {},
    get innerHTML() { return this._v; },
    set innerHTML(v) { this.writes += 1; this._v = v; },
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    removeEventListener() {},
    querySelector(sel) { return this.map[sel] ?? null; },
    querySelectorAll(sel) { return this.lists[sel] ?? []; },
  };
}

/** 装配与 reelHTML 同构的节点桩（mount 首写后由测试布防，壳懒查询） */
function rigHost(host, n = SHOTS.length) {
  const shots = Array.from({ length: n }, (_, i) => stubNode('div', 'shot'));
  shots.forEach((s, i) => { s.dataset.i = String(i); });
  host.map = {
    '.reel .cap small': stubNode('small', ''),
    '.reel .cap span': stubNode('span', ''),
    '.reel .prog': stubNode('div', 'prog'),
    '.reel .ctl button[data-reel-ctl="toggle"]': stubNode('button', 'btn'),
  };
  host.map['.reel .ctl button[data-reel-ctl="toggle"]'].dataset.reelCtl = 'toggle';
  host.lists = { '.reel .shot': shots };
  return host;
}
const shotsOf = (host) => host.lists['.reel .shot'];
const capAt = (host) => host.map['.reel .cap small'];
const capTxt = (host) => host.map['.reel .cap span'];
const progOf = (host) => host.map['.reel .prog'];
const toggleOf = (host) => host.map['.reel .ctl button[data-reel-ctl="toggle"]'];

test('M17 mount：首写 .reel 结构一次 + handle 契约（next/pause/resume/close 可调）', () => {
  const host = stubHost();
  const handle = mount(host, { shots: SHOTS, onClose: () => {}, schedule: STUB_SCHED });
  assert.equal(host.writes, 1);
  assert.ok(host.innerHTML.startsWith('<div class="reel" role="dialog"'));
  assert.equal(handle.el, host);
  assert.equal([typeof handle.next, typeof handle.pause, typeof handle.resume, typeof handle.close].every((t) => t === 'function'), true);
  assert.equal(handle.idx, 0, 'mount 即第一镜（自动 start）');
});

test('M17 mount 自动开场：暂停→继续后重放第一镜——.on 唯一、字幕、进度条已走（L566-569 开场态）', () => {
  const host = stubHost();
  const handle = mount(host, { shots: SHOTS, onClose: () => {}, schedule: STUB_SCHED });
  rigHost(host); // 首写后布防（真浏览器由 innerHTML 解析而来）
  handle.pause();
  handle.resume(); // 继续重放当前镜 → applyShot(0) 在桩上生效
  assert.equal(shotsOf(host)[0].classes.has('on'), true, '第一镜 .on');
  assert.equal(shotsOf(host).filter((s) => s.classes.has('on')).length, 1, '.on 唯一');
  assert.equal(shotsOf(host)[1].classes.has('on'), false);
  assert.equal(capAt(host).textContent, SHOTS[0].at);
  assert.equal(capTxt(host).textContent, SHOTS[0].text);
  assert.ok(progOf(host).style.width.startsWith(String(progressPct(0, 3).toFixed(4)).slice(0, 4)) || parseFloat(progOf(host).style.width) > 0, '进度条已走');
  assert.ok(progOf(host).style.width.endsWith('%'));
  assert.equal(toggleOf(host).textContent, BTN_PAUSE);
});

test('M17 handle.next()：切镜换字幕、旧镜失 .on、进度推进（L562-569）', () => {
  const host = stubHost();
  const handle = mount(host, { shots: SHOTS, onClose: () => {}, schedule: STUB_SCHED });
  rigHost(host);
  handle.next();
  assert.equal(handle.idx, 1);
  assert.equal(shotsOf(host)[1].classes.has('on'), true);
  assert.equal(shotsOf(host)[0].classes.has('on'), false);
  assert.equal(capAt(host).textContent, SHOTS[1].at);
  assert.equal(capTxt(host).textContent, SHOTS[1].text);
  assert.ok(Math.abs(parseFloat(progOf(host).style.width) - progressPct(1, 3)) < 1e-6);
  handle.next();
  assert.equal(handle.idx, 2);
  handle.next(); // 播完
  assert.equal(handle.finished, true);
  assert.equal(toggleOf(host).textContent, BTN_REPLAY, '播完变重播（L565）');
  assert.ok(Math.abs(parseFloat(progOf(host).style.width) - 100) < 1e-6, '进度钳 100');
  handle.next(); // 播完后再 next：不复活
  assert.equal(handle.finished, true);
});

test('M17 close()：onClose 恰一次、清空宿主、幂等（L577 closeReel）', () => {
  const host = stubHost();
  let closes = 0;
  const handle = mount(host, { shots: SHOTS, onClose: () => { closes += 1; }, schedule: STUB_SCHED });
  rigHost(host);
  handle.close();
  assert.equal(closes, 1);
  assert.equal(host.innerHTML, '', '遮罩移除（spec：.reel count 0）');
  handle.close();
  assert.equal(closes, 1, '重复 close 不再回调');
});

test('M17 点击委托：暂停↔继续文案、播完点击=重播、关闭钮 onClose（L623/L621）', () => {
  const host = stubHost();
  let closes = 0;
  const handle = mount(host, { shots: SHOTS, onClose: () => { closes += 1; }, schedule: STUB_SCHED });
  rigHost(host);
  const click = (node) => host.listeners.click[0]({ target: node });
  click(toggleOf(host));
  assert.equal(handle.paused, true);
  assert.equal(toggleOf(host).textContent, BTN_RESUME, '暂停 → 继续');
  click(toggleOf(host));
  assert.equal(handle.paused, false);
  assert.equal(toggleOf(host).textContent, BTN_PAUSE, '继续 → 暂停');
  handle.next(); handle.next(); handle.next(); // 播完
  assert.equal(toggleOf(host).textContent, BTN_REPLAY);
  click(toggleOf(host)); // 播完点击 = 重播（prototype openReel 重开语义）
  assert.equal(handle.idx, 0);
  assert.equal(handle.finished, false);
  assert.equal(capTxt(host).textContent, SHOTS[0].text, '重播回到第一镜字幕');
  assert.equal(toggleOf(host).textContent, BTN_PAUSE);
  const closeBtn = stubNode('button', 'btn');
  closeBtn.dataset.reelCtl = 'close';
  click(closeBtn);
  assert.equal(closes, 1);
});

test('M17 Esc：document keydown → close 一次；close 后监听移除不重复回调（L648）', () => {
  const doc = { listeners: {}, addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }, removeEventListener(t, fn) { const a = this.listeners[t] ||= []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } };
  let closes = 0;
  const host = stubHost();
  mount(host, { shots: SHOTS, onClose: () => { closes += 1; }, doc, schedule: STUB_SCHED });
  assert.equal(doc.listeners.keydown.length, 1, '挂 Esc 监听');
  doc.listeners.keydown[0]({ key: 'Escape' });
  assert.equal(closes, 1);
  assert.equal(host.innerHTML, '');
  assert.equal(doc.listeners.keydown.length, 0, 'close 后移除监听（spec 两实例恰好两次回调的关键）');
  doc.listeners.keydown[0]?.({ key: 'Escape' });
  assert.equal(closes, 1);
  doc.listeners.keydown.push(() => {});
  mount(host, { shots: SHOTS, onClose: () => { closes += 1; }, doc, schedule: STUB_SCHED });
  doc.listeners.keydown.forEach((fn) => fn({ key: 'Enter' })); // 非 Esc 不关
  assert.equal(closes, 1);
  doc.listeners.keydown.forEach((fn) => fn({ key: 'Escape' })); // 只命中本实例监听（哑桩无操作）
  assert.equal(closes, 2);
});

test('M17 update：换 shots 重开新片、onClose 可换、空 props 不动（demo 装配契约）', () => {
  const host = stubHost();
  let closes = 0;
  const handle = mount(host, { shots: SHOTS, onClose: () => { closes += 1; }, schedule: STUB_SCHED });
  rigHost(host);
  handle.next();
  const ret = handle.update({});
  assert.equal(typeof ret.update, 'function', '链式返回 handle');
  assert.equal(handle.idx, 1, '空 props 不动状态');
  const NEXT = [{ at: '18:00 · 交付', body: '<div class="cover"></div>', text: '六点交付全部成果。' }];
  handle.update({ shots: NEXT, onClose: () => { closes += 10; } });
  assert.equal(host.writes, 2, '换片重写');
  rigHost(host, 1);
  handle.pause(); handle.resume(); // 重放当前（新片第 1 镜）
  assert.equal(capTxt(host).textContent, NEXT[0].text, '新片第一镜字幕');
  assert.equal(handle.idx, 0);
  handle.close();
  assert.equal(closes, 10, '新 onClose 生效（换片前未关过，恰 +10）');
});

test('M17 mount 容错：缺 props / 非 shots / 裸宿主不抛', () => {
  const host = stubHost();
  const handle = mount(host);
  assert.ok(host.innerHTML.length > 0, '零镜仍出遮罩壳');
  assert.equal(handle.idx, 0); // 无镜：start 后即播完态由 finished 承载
  const bare = { _v: '', writes: 0, get innerHTML() { return this._v; }, set innerHTML(v) { this.writes += 1; this._v = v; } };
  const h2 = mount(bare, { shots: 'not-array', onClose: () => {} });
  assert.equal(h2.finished, true, '非数组归空 → 即播完（label 重播）');
  assert.equal(typeof h2.close(), 'undefined');
});
