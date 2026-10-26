// W11 reel-player · 浏览器胶水单测（node 侧 fake DOM 驱动 createReelPlayer 全链路）。
// 覆盖 DAG 组3：(2) Web Animations 交叉过渡 + Ken Burns（prototype @keyframes kb 规格）、顶部 3px
// 进度条、时间标签 <small>；(3) 播放/暂停/继续/重播/关闭/Esc（prototype:621-648）+ pointer 拖动
// scrub 换算；(4) 旁白 <audio> currentTime 主时钟、字幕增量显隐（PRD §5.2 工程约束：绝不整块重绘，
// 以 FakeEl.innerHTML 抛异常 + style 写入计数锁死）；(5) prefers-reduced-motion 降级分步静态。
// 依赖全部注入（document/raf/now/matchMedia/audio），player.js 顶层零 DOM 触碰的前提因此可得全真验证。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createReelPlayer,
  scrubTime,
  timelineFromIsland,
  playerState,
} from '../../../../../web/agentic/reel/player.js';

// ---------- fake DOM：只实现播放器真正用到的面 ----------
class FakeAnimation {
  constructor(keyframes, options) {
    this.keyframes = keyframes;
    this.options = options;
    this.currentTime = 0;
    this.plays = 0;
    this.pauses = 0;
    this.cancelled = false;
  }
  play() { this.plays += 1; }
  pause() { this.pauses += 1; }
  cancel() { this.cancelled = true; }
}

class FakeEl {
  constructor(tag, className = '') {
    this.tag = tag;
    this.className = className;
    this.children = [];
    this.attrs = {};
    this.textContent = '';
    this.parentElement = null;
    this.removed = false;
    this._listeners = {};
    this.anims = [];
    this.styleWrites = 0;
    this._captured = 0;
    this._rect = null;
    // 增量更新契约：播放器任何路径写 innerHTML 都直接失败
    Object.defineProperty(this, 'innerHTML', {
      get() { return ''; },
      set() { throw new Error('reel player must never rewrite innerHTML (PRD §5.2 增量更新)'); },
    });
    const bag = {};
    const self = this;
    this.style = new Proxy(bag, {
      set(target, key, value) { if (target[key] !== value) self.styleWrites += 1; target[key] = value; return true; },
      get(target, key) { return target[key]; },
    });
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }
  hasAttribute(name) { return name in this.attrs; }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  remove() { this.removed = true; }
  addEventListener(type, handler) { (this._listeners[type] ??= []).push(handler); }
  removeEventListener(type, handler) { this._listeners[type] = (this._listeners[type] ?? []).filter(h => h !== handler); }
  fire(type, ev = {}) { for (const h of [...(this._listeners[type] ?? [])]) h(ev); }
  animate(keyframes, options) { const a = new FakeAnimation(keyframes, options); this.anims.push(a); return a; }
  setPointerCapture() { this._captured += 1; }
  releasePointerCapture() { this._captured -= 1; }
  getBoundingClientRect() { return this._rect ?? { left: 0, width: 1 }; }
  matches(sel) {
    if (sel === 'script[type="application/json"]') return this.tag === 'script' && this.attrs.type === 'application/json';
    if (sel.startsWith('#')) return this.attrs.id === sel.slice(1);
    let rest = sel;
    let tag = null;
    let cls = null;
    let attr = null;
    const t = rest.match(/^[a-z]+/);
    if (t && !rest.startsWith('[')) { tag = t[0]; rest = rest.slice(t[0].length); }
    const c = rest.match(/^\.([A-Za-z0-9_-]+)/);
    if (c) { cls = c[1]; rest = rest.slice(c[0].length); }
    const a = rest.match(/^\[([^\]]+)\]$/);
    if (a) attr = a[1];
    if (tag && this.tag !== tag) return false;
    if (cls && !this.className.split(/\s+/).includes(cls)) return false;
    if (attr) {
      const m = attr.match(/^([\w-]+)(?:="(.*)")?$/);
      if (!m || !(m[1] in this.attrs)) return false;
      if (m[2] !== undefined && this.attrs[m[1]] !== m[2]) return false;
    }
    return true;
  }
  querySelector(sel) {
    for (const child of this.children) {
      if (child.matches(sel)) return child;
      const hit = child.querySelector(sel);
      if (hit) return hit;
    }
    return null;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = node => {
      for (const child of node.children) {
        if (child.matches(sel)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
}

function makeDoc() {
  const listeners = {};
  return {
    createElement: (tag, cls) => new FakeEl(tag, cls),
    addEventListener: (t, h) => { (listeners[t] ??= []).push(h); },
    removeEventListener: (t, h) => { listeners[t] = (listeners[t] ?? []).filter(x => x !== h); },
    fire: (t, ev) => { for (const h of [...(listeners[t] ?? [])]) h(ev); },
  };
}

function attachAudio(el) {
  const handlers = {};
  return Object.assign(el, {
    currentTime: 0,
    duration: NaN,
    plays: 0,
    pauses: 0,
    play() { this.plays += 1; return { catch() {} }; },
    pause() { this.pauses += 1; },
    addEventListener: (t, h) => { (handlers[t] ??= []).push(h); },
    removeEventListener: (t, h) => { handlers[t] = (handlers[t] ?? []).filter(x => x !== h); },
    fire: (t, ev) => { for (const h of [...(handlers[t] ?? [])]) h(ev); },
  });
}

function makeRaf() {
  const frames = [];
  return {
    raf: cb => { frames.push(cb); return frames.length; },
    get pending() { return frames.length; },
    pump: () => { const f = frames.shift(); if (f) f(); },
  };
}

/** composeReel 输出的最小骨架：.reel > div > (.stage(.prog + 3 shot + 2 cap), audio, #reel-data)。 */
function makeFixture() {
  const root = new FakeEl('div', 'reel');
  const wrapper = new FakeEl('div');
  const stage = new FakeEl('div', 'stage');
  const prog = new FakeEl('div', 'prog');
  const img1 = new FakeEl('img');
  const img3 = new FakeEl('img');
  const shot = (attrs, img) => {
    const s = new FakeEl('div', 'shot');
    for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
    if (img) s.appendChild(img);
    stage.appendChild(s);
    return s;
  };
  const shot1 = shot({ 'data-start': '0', 'data-duration': '3', 'data-track': 'visual', 'data-kind': 'shot' }, img1);
  const shot2 = shot({ 'data-start': '3', 'data-duration': '2.5', 'data-track': 'visual', 'data-kind': 'sample', 'data-sample-id': 's1' });
  const shot3 = shot({ 'data-start': '5.5', 'data-duration': '4.5', 'data-track': 'visual', 'data-kind': 'shot' }, img3);
  const cap = (start, dur, text) => {
    const c = new FakeEl('div', 'cap');
    c.setAttribute('data-start', String(start));
    c.setAttribute('data-duration', String(dur));
    c.setAttribute('data-track', 'caption');
    c.setAttribute('data-kind', 'caption');
    c.setAttribute('aria-live', 'polite');
    c.textContent = text;
    stage.appendChild(c);
    return c;
  };
  const cap1 = cap(0, 3, '第一句');
  const cap2 = cap(3.2, 2, '第二句');
  stage.appendChild(prog);
  const audio = attachAudio(new FakeEl('audio'));
  const island = new FakeEl('script');
  island.setAttribute('type', 'application/json');
  island.setAttribute('id', 'reel-data');
  island.textContent = JSON.stringify({ missionId: 'm1', version: 1, durationSec: 10, elements: [] });
  wrapper.appendChild(stage);
  wrapper.appendChild(audio);
  wrapper.appendChild(island);
  root.appendChild(wrapper);
  stage._rect = { left: 100, width: 400 };
  return { root, wrapper, stage, prog, shots: [shot1, shot2, shot3], caps: [cap1, cap2], audio, img1, img3 };
}

const KB_FRAMES = [
  { transform: 'scale(1) translate(0, 0)' },
  { transform: 'scale(1.09) translate(-2%, -1%)' },
];

function mount(fixture, over = {}) {
  const doc = makeDoc();
  const raf = makeRaf();
  let ms = 0;
  const player = createReelPlayer(fixture.root, {
    document: doc,
    raf: raf.raf,
    now: () => ms,
    matchMedia: () => ({ matches: false }),
    ...over,
  });
  return { player, doc, raf, clock: { get ms() { return ms; }, set(v) { ms = v; } }, advance: d => { ms += d; } };
}

test('mount lays the first frame incrementally: crossfade-in, Ken Burns, one caption visible, control bar', () => {
  const f = makeFixture();
  const { player, doc } = mount(f);
  assert.equal(player.state, 'idle');
  assert.equal(player.timeline.durationSec, 10, 'DOM data 属性推导总时长，数据岛兜底一致');

  // 镜头 1 立即到位（immediate fade），Ken Burns 按原型规格
  const fade = f.shots[0].anims.at(-1);
  assert.deepEqual(fade.keyframes, [{ opacity: 1 }]);
  assert.equal(fade.options.duration, 0);
  assert.equal(fade.options.fill, 'forwards');
  const kb = f.img1.anims.at(-1);
  assert.deepEqual(kb.keyframes, KB_FRAMES, 'prototype:172 kb 关键帧原样');
  assert.equal(kb.options.duration, 7000, 'prototype:171 kb 7s');
  assert.equal(kb.options.easing, 'ease-out');
  assert.equal(kb.options.fill, 'forwards');

  // 字幕可见性立即收敛：首句可见、其余隐藏（composeReel 自包含页多条 .cap 不再叠加）
  assert.ok(!('display' in f.caps[0].style) || f.caps[0].style.display === '', '首句显示');
  assert.equal(f.caps[1].style.display, 'none');
  assert.equal(f.prog.style.width, '0.00%');

  // 自建控制条（fixture 未带）：播放 + 关闭 + 时间标签 <small>
  const ctl = f.wrapper.children.find(c => c.matches('[data-reel-ctl]'));
  assert.ok(ctl, '控制条插入 .stage 兄弟位置');
  const toggle = ctl.children.find(c => c.matches('[data-reel-act="toggle"]'));
  const close = ctl.children.find(c => c.matches('[data-reel-act="close"]'));
  const timeEl = ctl.children.find(c => c.matches('.reel-time'));
  assert.equal(toggle.textContent, '▶ 播放');
  assert.equal(timeEl.textContent, '0:00 / 0:10');

  close.fire('click');
  assert.equal(player.state, 'closed');
  assert.ok(f.root.removed, '默认关闭=整块移除（prototype:579）');
  assert.doesNotThrow(() => doc.fire('keydown', { key: 'Escape' }), 'destroy 后 Esc 监听已拆');
});

test('narration <audio> currentTime is the master clock: shots, captions, progress follow it', () => {
  const f = makeFixture();
  const { player, raf } = mount(f, { autoplay: true });
  assert.equal(player.state, 'playing');
  assert.equal(f.audio.plays, 1);
  raf.pump();

  f.audio.currentTime = 4; // 第二镜 [3,5.5)，第二句 [3.2,5.2)
  raf.pump();
  assert.equal(player.time(), 4);
  assert.deepEqual(f.shots[1].anims.at(-1).keyframes, [{ opacity: 0 }, { opacity: 1 }], '交叉过渡入场');
  assert.equal(f.shots[1].anims.at(-1).options.duration, 600, 'prototype:168 opacity .6s');
  assert.deepEqual(f.shots[0].anims.at(-1).keyframes, [{ opacity: 1 }, { opacity: 0 }], '交叉过渡出场');
  assert.equal(f.caps[0].style.display, 'none');
  assert.equal(f.caps[1].style.display, '', '第二句显示');
  assert.equal(f.prog.style.width, '40.00%');

  // 音频 ended → 末帧保持可见 + 进度 100% + 状态 ended（prototype:565）
  f.audio.fire('ended');
  assert.equal(player.state, 'ended');
  assert.equal(f.prog.style.width, '100%');
  assert.deepEqual(f.shots[2].anims.at(-1).keyframes, [{ opacity: 0 }, { opacity: 1 }], '播完停在最末镜头');
  assert.equal(f.caps[0].style.display, 'none');
  assert.equal(f.caps[1].style.display, 'none');
});

test('pause/resume/replay follow prototype:621-648 (ended 的暂停即重播)', () => {
  const f = makeFixture();
  const { player, raf } = mount(f, { autoplay: true });
  const seen = [];
  player.onstate(s => seen.push(s));
  const ctl = f.wrapper.children.find(c => c.matches('[data-reel-ctl]'));
  const toggle = ctl.children.find(c => c.matches('[data-reel-act="toggle"]'));

  f.audio.currentTime = 1;
  raf.pump();
  player.pause();
  assert.equal(player.state, 'paused');
  assert.equal(f.audio.pauses, 1);
  assert.ok(f.img1.anims.every(a => a.pauses >= 1), '暂停时 Ken Burns 同步 pause');
  assert.equal(toggle.textContent, '继续');
  player.resume();
  assert.equal(player.state, 'playing');
  assert.equal(f.audio.plays, 2);
  assert.equal(toggle.textContent, '暂停');

  f.audio.fire('ended');
  assert.equal(toggle.textContent, '重播');
  player.pause(); // prototype:623 末尾按「暂停」即重播
  assert.equal(player.state, 'playing');
  assert.equal(f.audio.currentTime, 0, '重播从头');
  assert.equal(f.audio.plays, 3);
  assert.deepEqual(seen, ['paused', 'playing', 'ended', 'paused', 'playing'], 'rewind→play 的状态轨迹（autoplay 先于订阅）');

  player.replay();
  assert.equal(player.state, 'playing');
  assert.equal(f.audio.currentTime, 0);
});

test('Esc closes the player (prototype:648) and destroy detaches every listener', () => {
  const f = makeFixture();
  const { player, doc } = mount(f);
  doc.fire('keydown', { key: 'Escape' });
  assert.equal(player.state, 'closed');
  assert.ok(f.root.removed);

  const f2 = makeFixture();
  const p2 = mount(f2).player;
  p2.destroy();
  assert.equal(p2.state, 'idle');
  assert.ok(!f2.root.removed, 'destroy 只拆监听不动 DOM');
});

test('pointer drag scrubs the timeline: fraction→seconds, Ken Burns phase aligned, resume on release', () => {
  const f = makeFixture();
  const { player, raf } = mount(f, { autoplay: true });
  raf.pump();
  const ev = x => ({ clientX: x, pointerId: 7, preventDefault() {} });

  f.stage.fire('pointerdown', ev(300)); // frac .5 → 5s：软暂停 + 立即 seek
  assert.equal(player.state, 'paused');
  assert.equal(f.audio.pauses, 1);
  assert.equal(f.audio.currentTime, 5);
  assert.ok(f.stage._captured >= 1, '指针捕获');
  assert.equal(f.shots[1].anims.at(-1).options.duration, 0, 'scrub 中瞬切不淡入');

  f.stage.fire('pointermove', ev(20)); // frac -0.2 → 夹取 0
  assert.equal(f.audio.currentTime, 0);
  f.stage.fire('pointermove', ev(420)); // frac .8 → 8s：第三镜中段
  assert.equal(f.audio.currentTime, 8);
  assert.equal(f.shots[2].anims.at(-1).keyframes.length > 0, true);
  assert.equal(f.img3.anims.at(-1).currentTime, 2500, 'Ken Burns 相位对齐 (8-5.5)s');

  f.stage.fire('pointerup', ev(420));
  assert.equal(player.state, 'playing', '拖完恢复播放');
  assert.equal(f.audio.plays, 2);
  assert.equal(f.audio.currentTime, 8);

  assert.equal(scrubTime(-1, 10), 0, 'scrubTime 夹取 [0,1]');
  assert.equal(scrubTime(2, 10), 10);
  assert.equal(scrubTime(0.5, 10), 5);
  assert.equal(scrubTime(0.5, 0), 0);
  assert.equal(scrubTime(Number.NaN, 10), 0);
});

test('incremental rendering: unchanged nodes are never rewritten (PRD §5.2 工程约束)', () => {
  const f = makeFixture();
  const { raf } = mount(f, { autoplay: true });
  raf.pump();
  const baseline = {
    cap0: f.caps[0].styleWrites, cap1: f.caps[1].styleWrites,
    prog: f.prog.styleWrites, shot0: f.shots[0].anims.length,
    shot1: f.shots[1].anims.length,
  };
  f.audio.currentTime = 0.5; // 同镜同句推进
  raf.pump();
  assert.equal(f.caps[0].styleWrites, baseline.cap0, '字幕可见性未变不写');
  assert.equal(f.caps[1].styleWrites, baseline.cap1);
  assert.equal(f.shots[0].anims.length, baseline.shot0, '同镜不重播交叉过渡');
  assert.equal(f.shots[1].anims.length, baseline.shot1);
  assert.ok(f.prog.styleWrites > baseline.prog, '进度条随时间推进');
  raf.pump();
  assert.equal(f.prog.styleWrites, baseline.prog + 1, '时间不变进度条不重写');
  assert.equal(f.caps[0].textContent, '第一句', '字幕文本永不被改写');
});

test('prefers-reduced-motion: no animations at all, stepwise static with prev/next buttons', () => {
  const f = makeFixture();
  const { player } = mount(f, { matchMedia: () => ({ matches: true }), autoplay: true });
  assert.ok(player.reduced);
  assert.equal(f.shots[0].style.opacity, '1', '首镜一帧直接到位');
  assert.equal(f.shots[1].style.opacity, '0');
  assert.equal(f.shots[2].style.opacity, '0');
  for (const node of [...f.shots, ...f.caps, f.img1, f.img3]) assert.equal(node.anims.length, 0, '零动画');
  assert.equal(f.audio.plays, 0, '不自动播旁白');
  assert.equal(player.state, 'idle', '无自动推进');

  const ctl = f.wrapper.children.find(c => c.matches('[data-reel-ctl]'));
  const prev = ctl.children.find(c => c.matches('[data-reel-act="prev"]'));
  const next = ctl.children.find(c => c.matches('[data-reel-act="next"]'));
  const timeEl = ctl.children.find(c => c.matches('.reel-time'));
  assert.ok(prev && next, '控制条换成手动步进');
  assert.ok(!ctl.children.find(c => c.matches('[data-reel-act="toggle"]')), '无播放/暂停');

  next.fire('click');
  assert.equal(f.audio.currentTime, 3, '步进到第二镜边界');
  assert.equal(f.shots[0].style.opacity, '0');
  assert.equal(f.shots[1].style.opacity, '1');
  assert.equal(timeEl.textContent, '0:03 / 0:10');
  next.fire('click');
  assert.equal(f.shots[2].style.opacity, '1', '第三镜');
  next.fire('click');
  assert.equal(f.shots[2].style.opacity, '1', '末镜是终点，不再前进');
  prev.fire('click');
  assert.equal(f.shots[1].style.opacity, '1', '回退一步');
  player.play();
  assert.equal(player.state, 'idle', 'reduced 下 play 不进入自动播放');
});

test('data island backs the timeline when DOM lacks data attributes; broken islands degrade safely', () => {
  const root = new FakeEl('div', 'reel');
  const stage = new FakeEl('div', 'stage');
  root.appendChild(stage);
  const island = new FakeEl('script');
  island.setAttribute('type', 'application/json');
  island.setAttribute('id', 'reel-data');
  island.textContent = JSON.stringify({
    durationSec: 9,
    elements: [
      { start: 0, duration: 4, track: 'visual', kind: 'shot' },
      { start: 4, duration: 5, track: 'visual', kind: 'shot' },
      { start: 0.5, duration: 3, track: 'caption', kind: 'caption', text: '句一' },
      { start: 'x', duration: 1, track: 'visual' },
    ],
  });
  root.appendChild(island);
  const raf = makeRaf();
  let ms = 0;
  const player = createReelPlayer(root, {
    document: makeDoc(), raf: raf.raf, now: () => ms, matchMedia: () => ({ matches: false }), autoplay: true,
  });
  assert.equal(player.state, 'playing');
  assert.equal(player.timeline.durationSec, 9, '时长取数据岛声明');
  assert.equal(player.timeline.tracks.visual.length, 2, '垃圾元素（start=x）被丢弃');
  assert.equal(player.timeline.tracks.caption.length, 1);
  ms = 4500;
  raf.pump();
  assert.equal(player.time(), 4.5);
  assert.equal(root.querySelector('.prog').style.width, '50.00%', '无音频走虚拟时钟');
  ms = 10000;
  raf.pump();
  assert.equal(player.state, 'ended', '虚拟时钟播到头收尾');
  assert.equal(root.querySelector('.prog').style.width, '100%');

  // 数据岛损坏：按空时间轴处理，播放立即结束而不是抛错
  const bad = new FakeEl('div', 'reel');
  bad.appendChild(new FakeEl('div', 'stage'));
  const broken = new FakeEl('script');
  broken.setAttribute('type', 'application/json');
  broken.textContent = '{broken';
  bad.appendChild(broken);
  const p2 = createReelPlayer(bad, { document: makeDoc(), raf: makeRaf().raf, now: () => 0, matchMedia: () => ({ matches: false }) });
  p2.play();
  assert.equal(p2.state, 'ended');
});

test('host chrome is reused, missing .prog is created, onClose overrides node removal', () => {
  const f = makeFixture();
  const bar = new FakeEl('div', 'ctl');
  bar.setAttribute('data-reel-ctl', '');
  const hostToggle = new FakeEl('button');
  hostToggle.setAttribute('data-reel-act', 'toggle');
  hostToggle.setAttribute('id', 'reelPause');
  const hostClose = new FakeEl('button');
  hostClose.setAttribute('data-reel-act', 'close');
  bar.appendChild(hostToggle);
  bar.appendChild(hostClose);
  f.wrapper.appendChild(bar);
  let closedWith = null;
  const { player } = mount(f, { onClose: root => { closedWith = root; } });
  assert.equal(f.wrapper.children.filter(c => c.matches('[data-reel-ctl]')).length, 1, '不自建第二条控制条');
  hostToggle.fire('click');
  assert.equal(player.state, 'playing', '复用宿主 #reelPause');
  hostClose.fire('click');
  assert.equal(player.state, 'closed');
  assert.equal(closedWith, f.root, 'onClose 收到 root');
  assert.ok(!f.root.removed, '有 onClose 时不移除节点');

  const lean = new FakeEl('div', 'reel');
  const stage = new FakeEl('div', 'stage');
  lean.appendChild(stage);
  const leanIsland = new FakeEl('script');
  leanIsland.setAttribute('type', 'application/json');
  leanIsland.setAttribute('id', 'reel-data');
  leanIsland.textContent = JSON.stringify({ durationSec: 5, elements: [{ start: 0, duration: 5, track: 'visual' }] });
  lean.appendChild(leanIsland);
  const p3 = createReelPlayer(lean, {
    document: makeDoc(), raf: makeRaf().raf, now: () => 0,
    matchMedia: () => ({ matches: false }), controls: 'none',
  });
  assert.equal(stage.children.find(c => c.matches('.prog')).tag, 'div', '缺 .prog 时自建进度条');
  assert.equal(p3.state, 'idle', "controls:'none' 不建控制条也可运行");
  p3.play();
  assert.equal(p3.state, 'playing');
});

test('timelineFromIsland and playerState edge transitions', () => {
  const tl = timelineFromIsland({
    durationSec: 12,
    elements: [
      { start: 0, duration: 5, track: 'visual' },
      { start: 5, duration: 5, track: 'visual' },
      { start: 9, duration: 2, track: 'caption' },
    ],
  });
  assert.equal(tl.durationSec, 12, '数据岛声明时长 > 元素铺满时以声明为准');
  assert.deepEqual(tl.tracks.visual.map(e => e.start), [0, 5]);
  assert.equal(tl.tracks.caption.length, 1);
  assert.equal(timelineFromIsland(null).durationSec, 0);
  assert.equal(timelineFromIsland({}).tracks.visual.length, 0);

  assert.equal(playerState('ended', 'rewind'), 'paused', '末尾往回拖 → 可继续');
  assert.equal(playerState('paused', 'rewind'), 'paused');
  assert.equal(playerState('playing', 'replay'), 'playing', '未结束时的 replay 不动状态');
  assert.equal(playerState('nonsense', 'play'), 'playing', '未知状态按初值处理');
});
