// M09 分镜轴 + 旁白控件 单测（RED 先行 · 实现前必红）
// 依据：plan.md M09、PRD §5.2.3（时间线分镜：横向时间轴、播放头扫过、agent 小头像、
//   用户触点标出、prefers-reduced-motion 静态分步；旁白 30–60 秒中文口播、字幕同步）、
//   §5.8（旁白有字幕；动画尊重 reduced motion）、§5.2 末（增量更新：整块重绘会冲掉旁白字幕）、
//   §10.3 storyboard[{at,actor,text,need}] 字段名；
//   prototype.html（唯一视觉/交互标准）L86-95（.story/.rail/.ev 两行交错/.you/.lit/.head/.ticks/
//   .narr/.subtitle 结构与样式钩子）、L407-408（结构与默认文案/刻度）、L415-425（storyEvents +
//   drawRail：x=窗口百分比 toFixed(1)、clampX 8–92、top=i%2?66:8、.head 随 lit 走、you 类）、
//   L426-450（narration 六句 + playNarration：speechSynthesis 逐句 zh-CN rate 1.1、
//     onend 推进、句间 150ms、无 TTS 2400ms 降级、onerror 2200ms、map[i] 点亮、播完 drawRail() 清点亮）。
// 契约：web/agentic/ui/storyboard.js 具名导出
//   CLAMP_MIN/CLAMP_MAX/ROW_TOPS/LANG/RATE/GAP_MS/NO_TTS_MS/TTS_ERROR_MS/PLAY_LABEL/
//   DEFAULT_SUBTITLE/DEFAULT_LABEL/DEFAULT_TICKS/ACTOR_ICONS、esc/setHTML、
//   parseHM/windowOf/xPct/clampPct/clampX/headLeft/normEvent/eventHTML/railHTML/
//   narrHTML/labelHTML/ticksHTML/storyHTML、createNarrator/defaultSpeech/defaultSchedule/
//   prefersReducedMotion、mount(el, props) → { el, update(props), setLine(i), play(), stop(), speaking }
// 增量约束（PRD §5.2 末教训 + DAG M09「update(litIdx) 只动 class 不重绘」）：
//   setLine/update(litIdx) 只切 class 与 head 内联 left，绝不重写 rail；events 变更才重建 rail。
// W11 接缝：handle.setLine(i) 供外部时间轴驱动字幕行与点亮（DAG M09）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAMP_MIN, CLAMP_MAX, ROW_TOPS, LANG, RATE, GAP_MS, NO_TTS_MS, TTS_ERROR_MS,
  PLAY_LABEL, DEFAULT_SUBTITLE, DEFAULT_LABEL, DEFAULT_TICKS, ACTOR_ICONS,
  esc, parseHM, windowOf, xPct, clampPct, clampX, headLeft, normEvent,
  eventHTML, railHTML, narrHTML, labelHTML, ticksHTML, storyHTML,
  createNarrator, defaultSpeech, defaultSchedule, prefersReducedMotion, mount,
} from '../../../../web/agentic/ui/storyboard.js';

// 黄金场景（prototype L415-418 storyEvents 同源取前 6；L426-433 narration 六句）
const EVENTS = [
  ['13:30', '🔎', '研究员先找资料'],
  ['13:55', '✋', '你确认受众', true],
  ['14:30', '🧪', '核验引用'],
  ['14:52', '📦', '研究交付'],
  ['15:00', '🧭', '课程接力'],
  ['15:28', '✋', '你选大纲方向', true],
];
const LINES = [
  '下午一点半，我先派三个研究员分头找资料。',
  '两点前需要你确认一下受众，三十秒就好。',
  '两点半我会让另一个模型逐条核对引用。',
  '三点开始做课程设计，直接用研究结论。',
  '三点半我会请你在两个大纲方向里选一个。',
  '五点前交付课程方案。',
];
const MAP = [0, 1, 2, 4, 5, 5]; // 字幕行 i → 点亮事件索引（prototype L437 语义）
// 派生窗 [810,928]（13:30–15:28，span 118）下的期望横向位（toFixed(1) 再 clamp，prototype L421-423）
const EXPECT_LEFT = [8, 21.2, 50.8, 69.5, 76.3, 92];

// ---------- 常量（prototype 原文） ----------

test('M09 常量：clampX 8–92 / 两行 top 8·66 / rate 1.1 zh-CN / 逐句节奏 150·2400·2200', () => {
  assert.equal(CLAMP_MIN, 8);
  assert.equal(CLAMP_MAX, 92);
  assert.deepEqual(ROW_TOPS, [8, 66]);
  assert.equal(LANG, 'zh-CN'); // prototype L439
  assert.equal(RATE, 1.1); // prototype L439
  assert.equal(GAP_MS, 150); // prototype L443 句间
  assert.equal(NO_TTS_MS, 2400); // prototype L447 无 TTS 降级
  assert.equal(TTS_ERROR_MS, 2200); // prototype L446 onerror 兜底
  assert.equal(PLAY_LABEL, '▶ 听旁白'); // prototype L408
  assert.equal(DEFAULT_LABEL, '下午会这样进行'); // prototype L407
  assert.deepEqual(DEFAULT_TICKS, ['13:30', '14:00', '15:00', '16:00', '17:00']); // prototype L407
  assert.ok(DEFAULT_SUBTITLE.includes('听旁白') && DEFAULT_SUBTITLE.includes('30 秒'), 'prototype L408 默认字幕');
});

test('M09 ACTOR_ICONS：PRD §10.3 storyboard.actor → 头像映射，you 触点用 ✋', () => {
  assert.equal(ACTOR_ICONS.you, '✋');
  assert.ok(ACTOR_ICONS.researcher && ACTOR_ICONS.writer && ACTOR_ICONS.deliver);
});

// ---------- 纯核：时间与定位 ----------

test('M09 parseHM：HH:MM → 当日分钟；非法输入 NaN', () => {
  assert.equal(parseHM('13:30'), 810);
  assert.equal(parseHM('09:05'), 545);
  assert.equal(parseHM('0:00'), 0);
  assert.equal(parseHM('23:59'), 1439);
  for (const bad of ['24:00', '13:60', '13:5', '1330', 'ab:cd', '', null, undefined, 810]) {
    assert.ok(Number.isNaN(parseHM(bad)), `必须 NaN：${String(bad)}`);
  }
  assert.equal(parseHM(' 13:30 '), 810, '首尾空白容忍');
});

test('M09 windowOf：显式 from/to 优先；缺省取事件 min/max；不足 2 个合法时刻回退原型窗 13:20–17:10', () => {
  assert.deepEqual(windowOf(EVENTS, '13:20', '17:10'), [800, 1030], '显式窗口');
  assert.deepEqual(windowOf(EVENTS), [810, 928], '派生窗口 = 事件 min/max');
  assert.deepEqual(windowOf([]), [800, 1030], '无事件回退 prototype L421 窗口');
  assert.deepEqual(windowOf([['13:30', '🔎', '只此一条']]), [800, 1030], '1 个合法时刻回退');
  assert.deepEqual(windowOf([['xx:yy', '🔎', '非法'], [null, '🔎', '非法']], '18:00', '17:00'), [800, 1030], '显式倒挂且无合法时刻也回退');
  assert.deepEqual(windowOf(EVENTS, '17:00', '13:00'), [810, 928], '显式倒挂改用派生');
});

test('M09 xPct/clampPct/clampX：窗口百分比 toFixed(1) 语义 + 8–92 夹紧（prototype L421-423）', () => {
  const win = [810, 928];
  assert.equal(xPct('13:30', win), 0);
  assert.ok(Math.abs(xPct('13:55', win) - 21.186) < 0.01);
  assert.equal(xPct('15:28', win), 100);
  assert.equal(clampPct(-5), 8);
  assert.equal(clampPct(50), 50);
  assert.equal(clampPct(120), 92);
  assert.deepEqual(EVENTS.map(([t]) => clampX(t, win)), EXPECT_LEFT, '六事件期望横向位');
  assert.equal(clampX('垃圾', win), 8, '非法时刻按窗口起点夹到 8');
  assert.equal(clampX('13:30', [810, 810]), 8, '退化窗口不除零');
});

test('M09 headLeft：null/越界 lit → 0；有效 lit → 夹紧后的横向位数值（prototype L424 head）', () => {
  const win = [810, 928];
  assert.equal(headLeft(null, EVENTS, win), 0);
  assert.equal(headLeft(1, EVENTS, win), 21.2);
  assert.equal(headLeft(5, EVENTS, win), 92);
  assert.equal(headLeft(0, EVENTS, win), 8);
  assert.equal(headLeft(99, EVENTS, win), 0, '越界 lit 归 0');
  assert.equal(headLeft(-1, EVENTS, win), 0);
});

// ---------- 纯核：事件归一与 HTML ----------

test('M09 normEvent：数组形 [at,icon,text,you] 原样；对象形吃 PRD §10.3 {at,actor,text}，actor=you 即触点', () => {
  assert.deepEqual(normEvent(['14:00', '✋', '确认', true]), { at: '14:00', icon: '✋', text: '确认', you: true });
  assert.deepEqual(normEvent(['14:00', '✍️', '写作']), { at: '14:00', icon: '✍️', text: '写作', you: false });
  const obj = normEvent({ at: '13:30', actor: 'researcher', text: '检索' });
  assert.equal(obj.icon, ACTOR_ICONS.researcher, '对象形缺 icon 用 actor 映射');
  assert.equal(obj.you, false);
  const you = normEvent({ at: '13:55', actor: 'you', text: '确认受众' });
  assert.equal(you.icon, '✋');
  assert.equal(you.you, true, 'actor=you 即用户触点（PRD storyboard 语义）');
  assert.equal(normEvent({ at: '15:00', actor: '神秘人', text: 'x' }).icon, '·', '未知 actor 兜底圆点');
  assert.equal(normEvent(null), null);
  assert.equal(normEvent('x'), null);
});

test('M09 eventHTML：.ev 类序 ev[ you][ lit]、left/top 定位、.av 头像与 `<at> <text>` 均转义（prototype L424）', () => {
  const win = [810, 928];
  assert.equal(
    eventHTML(EVENTS[1], 1, win, null),
    '<div class="ev you" style="left:21.2%;top:66px"><span class="av">✋</span><span>13:55 你确认受众</span></div>',
  );
  assert.equal(
    eventHTML(EVENTS[0], 0, win, 0),
    '<div class="ev lit" style="left:8%;top:8px"><span class="av">🔎</span><span>13:30 研究员先找资料</span></div>',
  );
  assert.equal(eventHTML(EVENTS[5], 5, win, 3), '<div class="ev you" style="left:92%;top:66px"><span class="av">✋</span><span>15:28 你选大纲方向</span></div>', '非点亮不带 lit');
  const evil = eventHTML(['13:30', '<img src=x>', '<b>注入</b>'], 0, win, null);
  assert.ok(!evil.includes('<img') && !evil.includes('<b>'), 'icon/text 全转义');
  assert.ok(evil.includes('&lt;img src=x&gt;') && evil.includes('&lt;b&gt;注入&lt;/b&gt;'));
  assert.equal(eventHTML(null, 0, win, null), '', 'null 事件不输出');
  assert.equal(eventHTML(['13:30'], 0, win, null).includes('<span class="av"></span>'), true, '缺 icon 输出空头像不炸');
});

test('M09 railHTML：事件序列 + 末尾播放头 .head（aria-hidden）；无 lit 时 head left:0（prototype L424）', () => {
  const win = [810, 928];
  const html = railHTML(EVENTS, { lit: null, win });
  assert.equal((html.match(/<div class="ev/g) || []).length, 6);
  assert.ok(html.endsWith('<div class="head" aria-hidden="true" style="left:0"></div>'));
  const lit = railHTML(EVENTS, { lit: 1, win });
  assert.ok(lit.includes('<div class="head" aria-hidden="true" style="left:21.2%"></div>'), 'head 跟点亮事件走');
  assert.ok(lit.includes('class="ev you lit"'));
  assert.equal(railHTML(EVENTS, { lit: 1 }).includes('style="left:'), true, '缺省 win 自动派生');
  assert.equal(railHTML([], {}), '<div class="head" aria-hidden="true" style="left:0"></div>', '空事件只剩播放头');
});

test('M09 narrHTML：▶ 听旁白按钮（type=button + aria-pressed）+ .subtitle aria-live（prototype L408 + a11y 硬性要求）', () => {
  assert.equal(
    narrHTML(),
    `<button class="btn" type="button" aria-pressed="false">${PLAY_LABEL}</button><div class="subtitle" aria-live="polite">点&quot;听旁白&quot;，30 秒听懂下午怎么进行</div>`,
  );
  const evil = narrHTML('<script>x</script>');
  assert.ok(evil.includes('&lt;script&gt;'), '自定义字幕转义');
  assert.ok(evil.includes('aria-live="polite"'));
});

test('M09 labelHTML/ticksHTML/storyHTML：结构顺序 label > .rail > .ticks > .narr，刻度转义（prototype L407-408）', () => {
  assert.equal(labelHTML(), '<p class="small muted">下午会这样进行</p>');
  assert.equal(ticksHTML(['13:30<i>', '17:00']), '<div class="ticks"><span>13:30&lt;i&gt;</span><span>17:00</span></div>');
  const html = storyHTML({ events: EVENTS, lines: LINES, litIdx: 2 });
  const iRail = html.indexOf('<div class="rail">');
  const iTicks = html.indexOf('<div class="ticks">');
  const iNarr = html.indexOf('<div class="narr">');
  assert.ok(iRail > 0 && iTicks > iRail && iNarr > iTicks, '四段顺序照原型');
  assert.ok(html.includes('class="ev lit"'), 'litIdx 传入即点亮');
  assert.ok(html.startsWith('<p class="small muted">下午会这样进行</p>'));
  assert.equal((html.match(/<span>1[4-7]:00<\/span>/g) || []).length, 4, '默认五刻度（含 13:30）');
});

// ---------- 纯核：旁白 Sequencer（可注入 speech/schedule） ----------

function manualSchedule(log = []) {
  return (fn, ms) => {
    const rec = { fn, ms, canceled: false };
    log.push(rec);
    return () => { rec.canceled = true; };
  };
}
function fakeSpeech() {
  const calls = [];
  return {
    available: true, calls, cancels: 0,
    speak(text, h) { calls.push({ text, h }); },
    cancel() { this.cancels += 1; },
  };
}

test('M09 createNarrator：start 同步出第一句；逐句 onLine → onend 后 150ms 推进 → 播完 onEnd 且 speaking=false', () => {
  const seen = [];
  const log = [];
  const sp = fakeSpeech();
  let ended = 0;
  const n = createNarrator({
    lines: LINES, map: MAP, speech: sp, schedule: manualSchedule(log),
    onLine: (i) => seen.push(i), onEnd: () => { ended += 1; },
  });
  assert.equal(n.speaking, false);
  assert.equal(n.start(), true);
  assert.equal(n.speaking, true);
  assert.deepEqual(seen, [0], '第一句同步可见（prototype L441 先出字幕再播）');
  assert.equal(sp.calls.length, 1);
  assert.equal(sp.calls[0].text, LINES[0]);
  for (let i = 0; i < LINES.length; i += 1) {
    assert.equal(sp.calls[i].text, LINES[i], `第 ${i + 1} 句文本`);
    sp.calls[i].h.onend(); // 模拟朗读完成
    const gap = log[log.length - 1];
    assert.equal(gap.ms, GAP_MS, '句间 150ms（prototype L443）');
    assert.equal(gap.canceled, false);
    gap.fn(); // 到点进入下一句
  }
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5]);
  assert.equal(ended, 1, '播完恰一次 onEnd');
  assert.equal(n.speaking, false);
  assert.equal(sp.cancels, 0, '自然播完不调 cancel');
});

test('M09 createNarrator：无 TTS 用 2400ms 定时降级、绝不调 speak（prototype L447）', () => {
  const seen = [];
  const log = [];
  const n = createNarrator({
    lines: ['一', '二'], speech: { available: false }, schedule: manualSchedule(log), onLine: (i) => seen.push(i),
  });
  n.start();
  assert.deepEqual(seen, [0]);
  for (let i = 0; i < 2; i += 1) {
    assert.equal(log[log.length - 1].ms, NO_TTS_MS, `第 ${i + 1} 句 2400ms`);
    log[log.length - 1].fn(); // 句长到点 → advance（排 150ms 句间，prototype L443）
    assert.equal(log[log.length - 1].ms, GAP_MS);
    log[log.length - 1].fn(); // 句间到点 → 下一句（或收尾）
  }
  assert.deepEqual(seen, [0, 1]);
  assert.equal(n.speaking, false, '两句走完自然结束');
});

test('M09 createNarrator：onerror 走 2200ms 兜底继续推进（prototype L446）', () => {
  const seen = [];
  const log = [];
  const sp = fakeSpeech();
  const n = createNarrator({ lines: ['一', '二'], speech: sp, schedule: manualSchedule(log), onLine: (i) => seen.push(i) });
  n.start();
  sp.calls[0].h.onerror();
  assert.equal(log[0].ms, TTS_ERROR_MS);
  log[0].fn(); // 兜底到点 → advance → 排 150ms 句间
  log[log.length - 1].fn(); // 句间到点 → 出第 2 句
  assert.deepEqual(seen, [0, 1], '错误后仍推进到下一句');
});

test('M09 createNarrator：stop 取消待发定时器与语音、迟到的 onend 不再推进（确定性语义）', () => {
  const seen = [];
  const log = [];
  const sp = fakeSpeech();
  const n = createNarrator({ lines: LINES, speech: sp, schedule: manualSchedule(log), onLine: (i) => seen.push(i) });
  n.start();
  sp.calls[0].h.onend(); // 第 1 句完成 → 150ms 间隙挂起
  assert.equal(n.stop(), true);
  assert.equal(n.speaking, false);
  assert.equal(log[log.length - 1].canceled, true, '句间定时器被取消');
  assert.equal(sp.cancels, 1, '语音被 cancel');
  log[log.length - 1].fn(); // 迟到的定时器
  assert.deepEqual(seen, [0], '停播后不再出句');
  sp.calls[0].h.onend = null;
  assert.equal(n.stop(), false, '未在播时 stop 返回 false');
  n.start(); // 可再次重播
  assert.deepEqual(seen, [0, 0], '重播从第一句再来');
  assert.equal(n.start(), false, '播放中重复 start 幂等');
  assert.equal(n.stop(), true);
});

test('M09 createNarrator：空字幕行 start 立即 onEnd 不播；缺 onLine/onEnd 不炸', () => {
  let ended = 0;
  const sp = fakeSpeech();
  const n = createNarrator({ lines: [], speech: sp, schedule: manualSchedule([]), onEnd: () => { ended += 1; } });
  assert.equal(n.start(), true);
  assert.equal(ended, 1);
  assert.equal(sp.calls.length, 0);
  const bare = createNarrator({ lines: ['x'] });
  bare.start();
  bare.stop();
});

// ---------- 纯核：适配器 ----------

test('M09 defaultSpeech：node 无 speechSynthesis → available=false；浏览器形 win → zh-CN rate 1.1 接线（prototype L439-446）', () => {
  const none = defaultSpeech();
  assert.equal(none.available, false);
  assert.equal(defaultSpeech({}).available, false, '有对象无 API 也不可用');
  const made = [];
  function Utterance(text) { this.text = text; made.push(this); }
  const queued = [];
  let cancelled = 0;
  const win = {
    speechSynthesis: { speak: (u) => queued.push(u), cancel: () => { cancelled += 1; } },
    SpeechSynthesisUtterance: Utterance,
  };
  const sp = defaultSpeech(win);
  assert.equal(sp.available, true);
  const h = { onend() {}, onerror() {} };
  sp.speak('你好', h);
  assert.equal(made.length, 1);
  assert.equal(made[0].text, '你好');
  assert.equal(made[0].lang, LANG);
  assert.equal(made[0].rate, RATE);
  assert.equal(made[0].onend, h.onend, 'onend 原样接线');
  assert.equal(made[0].onerror, h.onerror);
  assert.deepEqual(queued, [made[0]]);
  sp.cancel();
  assert.equal(cancelled, 1);
});

test('M09 prefersReducedMotion：无 matchMedia false / matches true / 抛异常 false', () => {
  assert.equal(prefersReducedMotion(), false);
  assert.equal(prefersReducedMotion({}), false);
  assert.equal(prefersReducedMotion({ matchMedia: () => ({ matches: true }) }), true);
  assert.equal(prefersReducedMotion({ matchMedia: () => ({ matches: false }) }), false);
  assert.equal(prefersReducedMotion({ matchMedia: () => { throw new Error('x'); } }), false);
});

test('M09 defaultSchedule：真定时器到点触发、cancel 后不触发', async () => {
  let ran = 0;
  const cancel = defaultSchedule(() => { ran += 1; }, 5);
  cancel();
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(ran, 0);
  defaultSchedule(() => { ran += 2; }, 5);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(ran, 2);
});

test('M09 esc 五实体兜底（M01 utils 未落地路径）', () => {
  assert.equal(esc('<b class="x">A&B\'</b>'), '&lt;b class=&quot;x&quot;&gt;A&amp;B&#39;&lt;/b&gt;');
});

// ---------- DOM 壳（mount/update/setLine/播放）· stub 桩同 M05/M08 模式 ----------

function stubNode(tag) {
  const classes = new Set();
  const node = {
    tag, _h: undefined, _v: '', _text: '', writes: 0, style: {}, attrs: {}, listeners: {},
    children: {}, lists: {},
    set innerHTML(v) { this.writes += 1; this._v = v; },
    get innerHTML() { return this._v; },
    set textContent(v) { this._text = String(v); },
    get textContent() { return this._text; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); },
    querySelector(sel) { return this.children[sel] ?? null; },
    querySelectorAll(sel) { return this.lists[sel] ?? []; },
  };
  Object.defineProperty(node, 'classList', {
    get: () => ({
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : !!force;
        if (on) classes.add(c); else classes.delete(c);
        return on;
      },
    }),
  });
  return node;
}

/** 模拟浏览器解析 mount 产出的结构：宿主下挂 .rail/.subtitle/.narr button/.ticks，rail 下挂 .ev 列表与 .head */
function wire(host, evCount = EVENTS.length) {
  const rail = stubNode('div');
  const head = stubNode('div');
  const sub = stubNode('div');
  const btn = stubNode('button');
  const label = stubNode('p');
  const ticks = stubNode('div');
  host.children['.rail'] = rail;
  host.children['.subtitle'] = sub;
  host.children['.narr button'] = btn;
  host.children['p.small.muted'] = label;
  host.children['.ticks'] = ticks;
  rail.children['.head'] = head;
  const evs = Array.from({ length: evCount }, () => stubNode('div'));
  rail.lists['.ev'] = evs;
  return { rail, head, sub, btn, label, ticks, evs };
}
const clickStoryButton = (host) => host.listeners.click[0]({ target: host.children['.narr button'] });

function mountWired(extraProps = {}, evCount = EVENTS.length) {
  const host = stubNode('div');
  const handle = mount(host, { events: EVENTS, lines: LINES, map: MAP, ...extraProps });
  const w = wire(host, evCount);
  return { host, handle, ...w };
}

test('M09 mount：宿主加 .story 类、一次整写四段结构、handle 契约齐', () => {
  const host = stubNode('div');
  const handle = mount(host, { events: EVENTS, lines: LINES, map: MAP });
  assert.equal(host.writes, 1, '首渲染整写一次');
  assert.ok(host.classList.contains('story'), '宿主补 .story（prototype L407 容器语义）');
  assert.ok(host.innerHTML.includes('<div class="rail">') && host.innerHTML.includes('▶ 听旁白'));
  assert.equal((host.innerHTML.match(/<div class="ev[" ]/g) || []).length, 6);
  assert.equal(handle.el, host);
  for (const k of ['update', 'setLine', 'play', 'stop']) assert.equal(typeof handle[k], 'function');
  assert.equal(handle.speaking, false);
  assert.equal(typeof host.listeners.click[0], 'function', '容器级点击委托已挂');
});

test('M09 setLine：字幕=lines[i]（textContent）且 map[i] 事件点亮、其余熄灭、head 随之（prototype L441-442）', () => {
  const { handle, evs, head, sub } = mountWired();
  handle.setLine(3);
  assert.equal(sub.textContent, LINES[3]);
  assert.ok(evs[MAP[3]].classList.contains('lit'), 'map[3]=4 的事件点亮');
  assert.equal(evs.filter((e) => e.classList.contains('lit')).length, 1);
  assert.equal(head.style.left, '76.3%', 'head=clampX(events[map[3]=4])');
  handle.setLine(0);
  assert.equal(sub.textContent, LINES[0]);
  assert.ok(evs[0].classList.contains('lit'));
  assert.ok(!evs[4].classList.contains('lit'), '旧点亮熄灭');
  assert.equal(head.style.left, '8%');
});

test('M09 setLine 边界：负数/超大归 0/末句；map 缺行清点亮（prototype drawRail(undefined) 语义）', () => {
  const { handle, evs, head, sub } = mountWired();
  handle.setLine(-5);
  assert.equal(sub.textContent, LINES[0]);
  handle.setLine(99);
  assert.equal(sub.textContent, LINES[LINES.length - 1]);
  const short = mountWired({ map: [0] });
  short.handle.setLine(3);
  assert.equal(short.evs.filter((e) => e.classList.contains('lit')).length, 0, 'map 无 3 行 → 不点亮');
  assert.equal(short.head.style.left, '0');
  const noLines = mountWired({ lines: [] });
  assert.doesNotThrow(() => noLines.handle.setLine(1));
});

test('M09 setLine 增量：只切 class/字幕/head，绝不重写 rail（PRD §5.2 末教训）', () => {
  const { handle, rail, evs } = mountWired();
  evs[2].setAttribute('data-marker', 'keep');
  rail.writes = 0;
  handle.setLine(4);
  assert.equal(rail.writes, 0, 'rail innerHTML 不得重写');
  assert.equal(evs[2].getAttribute('data-marker'), 'keep', '事件节点身份保留');
  handle.setLine(1);
  assert.equal(rail.writes, 0);
  assert.equal(evs[2].getAttribute('data-marker'), 'keep');
});

test('M09 update({litIdx})：只切换点亮类，旧节点保留不重建（spec「只动 class」契约）', () => {
  const { handle, evs } = mountWired();
  handle.update({ litIdx: 0 });
  assert.ok(evs[0].classList.contains('lit'));
  evs[0].setAttribute('data-marker', 'keep');
  handle.update({ litIdx: 3 });
  assert.equal(evs.filter((e) => e.classList.contains('lit')).length, 1);
  assert.ok(evs[3].classList.contains('lit'));
  assert.equal(evs[0].getAttribute('data-marker'), 'keep', '旧点亮节点不得重建');
  handle.update({ litIdx: 99 });
  assert.equal(evs.filter((e) => e.classList.contains('lit')).length, 0, '越界 litIdx 清点亮');
});

test('M09 update({events})：签名变才重建 rail；字幕行/按钮不动', () => {
  const { handle, host, rail, sub, btn } = mountWired();
  rail.writes = 0;
  handle.update({ lines: LINES }); // 非 events 键不触发重建
  assert.equal(rail.writes, 0);
  handle.update({ events: JSON.parse(JSON.stringify(EVENTS)) }); // 同内容
  assert.equal(rail.writes, 0, '同集合零写');
  handle.update({ events: EVENTS.slice(0, 4) });
  assert.equal(rail.writes, 1, '事件集合变了重建 rail');
  assert.equal((rail.innerHTML.match(/<div class="ev[" ]/g) || []).length, 4);
  assert.equal(host.writes, 1, '宿主整体仍只有首渲染一次');
  sub.textContent = '留在原地';
  const evs2 = Array.from({ length: 4 }, () => stubNode('div'));
  rail.lists['.ev'] = evs2; // 模拟浏览器解析新 rail
  handle.update({ litIdx: 3 });
  assert.ok(evs2[3].classList.contains('lit'), '重建后点亮走新节点');
  assert.equal(sub.textContent, '留在原地', '字幕/按钮节点不受 rail 重建影响');
  assert.ok(btn);
});

test('M09 ▶ 听旁白：点击立即出第一句 + aria-pressed=true；逐句推进；再点停止', () => {
  const sp = fakeSpeech();
  const log = [];
  const { host, handle, sub, evs, btn } = mountWired({ speech: sp, schedule: manualSchedule(log) });
  clickStoryButton(host);
  assert.equal(sub.textContent, LINES[0], '点击同步出第一句（prototype L435-449）');
  assert.ok(evs[MAP[0]].classList.contains('lit'));
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
  assert.equal(handle.speaking, true);
  sp.calls[0].h.onend();
  log[log.length - 1].fn();
  assert.equal(sub.textContent, LINES[1]);
  assert.ok(evs[MAP[1]].classList.contains('lit'));
  clickStoryButton(host); // 播放中再点 = 停
  assert.equal(handle.speaking, false);
  assert.equal(sp.cancels, 1);
  assert.equal(btn.getAttribute('aria-pressed'), 'false');
  assert.equal(sub.textContent, LINES[1], '停播冻结当前句（不回默认）');
});

test('M09 旁白播完：末句后 onEnd 清点亮/head 归 0、字幕留末句（prototype L436-447 drawRail()）', () => {
  const sp = fakeSpeech();
  const log = [];
  let ended = 0;
  const { host, evs, head, sub, btn } = mountWired({ speech: sp, schedule: manualSchedule(log), onEnd: () => { ended += 1; } });
  clickStoryButton(host);
  for (let i = 0; i < LINES.length; i += 1) {
    sp.calls[i].h.onend();
    log[log.length - 1].fn();
  }
  assert.equal(ended, 1);
  assert.equal(evs.filter((e) => e.classList.contains('lit')).length, 0, '播完清点亮');
  assert.equal(head.style.left, '0');
  assert.equal(sub.textContent, LINES[LINES.length - 1], '字幕停在末句');
  assert.equal(btn.getAttribute('aria-pressed'), 'false');
});

test('M09 无 TTS 壳降级：available=false 时点击走 2400ms/句', () => {
  const log = [];
  const { host, sub } = mountWired({ speech: { available: false }, schedule: manualSchedule(log) });
  clickStoryButton(host);
  assert.equal(sub.textContent, LINES[0]);
  assert.equal(log[0].ms, NO_TTS_MS);
});

test('M09 reduced-motion：静态步进——ev/head 内联 transition:none（prototype L185 全局降级的组件级兜底）', () => {
  const a = mountWired({ reducedMotion: true });
  a.handle.update({ litIdx: 1 });
  for (const e of a.evs) assert.equal(e.style.transition, 'none');
  assert.equal(a.head.style.transition, 'none');
  const b = mountWired({ reducedMotion: false });
  b.handle.update({ litIdx: 1 });
  assert.notEqual(b.evs[0].style.transition, 'none', '正常动画不动内联样式');
});

test('M09 容错：空 props/非法键不炸、无查询能力宿主不抛、点击非按钮无效', () => {
  const host = stubNode('div');
  const handle = mount(host);
  assert.equal(host.writes, 1);
  assert.doesNotThrow(() => handle.update(undefined).update({ events: 'no' }).setLine(0));
  const plain = { _h: undefined, _v: '', writes: 0, set innerHTML(v) { this.writes += 1; this._v = v; }, get innerHTML() { return this._v; } };
  const h2 = mount(plain, { events: EVENTS, lines: LINES, map: MAP });
  assert.equal(plain.writes, 1);
  assert.doesNotThrow(() => h2.setLine(2).update({ litIdx: 1 }));
  const { host: host3 } = mountWired();
  assert.doesNotThrow(() => host3.listeners.click[0]({ target: null }));
  assert.doesNotThrow(() => host3.listeners.click[0]({ target: stubNode('span') }));
});

test('M09 预接线宿主：mount 即对已解析节点施加 rm 静态化；events 变更同步补 label/ticks', () => {
  const host = stubNode('div');
  mount(host, { events: EVENTS, lines: LINES, map: MAP, reducedMotion: true });
  const w = wire(host); // 模拟浏览器已解析 mount 产物
  host.children['.rail'] = w.rail; // 重建场景：再 mount 一次走 buildAll 的节点查询路径
  const host2 = stubNode('div');
  const pre = wire(host2);
  const h2 = mount(host2, { events: EVENTS, reducedMotion: true });
  assert.equal(pre.evs[0].style.transition, 'none', 'mount 后 rm 即作用于已解析 ev/head');
  assert.equal(pre.head.style.transition, 'none');
  h2.update({ label: '上午会这样进行', ticks: ['09:00', '12:00'], events: EVENTS.slice(0, 2) });
  assert.equal(pre.label.innerHTML, '上午会这样进行', 'events 变更时机同步补 label');
  assert.equal(pre.ticks.innerHTML, '<span>09:00</span><span>12:00</span>', 'ticks 同步补');
  h2.update({ label: '不重建时不动', events: EVENTS.slice(0, 2) }); // 同集合：label 不补丁
  assert.equal(pre.label.innerHTML, '上午会这样进行');
  void w;
});

test('M09 rm 即时生效：挂载后切换 prefers-reduced-motion，事件节点内联过渡随之开/关', () => {
  let fire = null;
  const win = { matchMedia: () => ({ addEventListener: (t, fn) => { fire = fn; } }) };
  const host = stubNode('div');
  const handle = mount(host, { events: EVENTS, lines: LINES, map: MAP, win });
  const pre = wire(host);
  assert.equal(pre.evs[0].style.transition, undefined, '默认非 rm 不动内联');
  fire({ matches: true });
  assert.equal(pre.evs[0].style.transition, 'none', '切 rm 即静态化现有节点');
  assert.equal(pre.head.style.transition, 'none');
  handle.update({ litIdx: 2 });
  assert.equal(pre.evs[2].style.transition, 'none', 'rm 态下新点亮维持静态');
  fire({ matches: false });
  assert.notEqual(pre.evs[0].style.transition, 'none', '切回恢复（清内联）');
});
