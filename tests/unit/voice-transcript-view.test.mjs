import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
// VI·V3转写视图 — web/voice/transcript-view.js + voice.css 定向单测（先 RED 后 GREEN）。
// 唯一标准 design/voice-intent/SPEC.md：
//   §3 transcript-view.js：只增量渲染；已确认前缀保持稳定，只更新尾部灰字；新字逐字浮现；
//        final 该句灰转黑 settle 320ms；光标闪烁；不允许整段闪烁重排；尊重 prefers-reduced-motion
//   §4  视觉 token（--vt-* / --p1..--p5，值必须与 SPEC 原文一致）
//   原型 prototype.html ①屏：.tx > .f(.just) + .p > .ch + .caret 结构图
// 契约（commit 77a59d5 web/voice/contracts.js）：initTranscriptState / applyServerMessage /
//   transcriptView —— 本测试用真实契约函数构造状态，不 mock 协议语义。
import {
  prefersReducedMotion,
  diffChars,
  planTranscript,
  createTranscriptView,
  MOTION_CLASSES,
} from '../../web/voice/transcript-view.js';
import { initTranscriptState, applyServerMessage, transcriptView } from '../../web/voice/contracts.js';

// —— Node 端最小假 DOM：只实现 transcript-view 用到的 API ——
class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this._text = '';
    this.dataset = {};
    this.style = {};
    this.ariaHidden = null;
    // className 与 classList 双向同步（真实 DOM 语义）
    const classes = new Set();
    Object.defineProperty(this, 'className', {
      get: () => [...classes].join(' '),
      set: (v) => {
        classes.clear();
        for (const c of String(v).split(/\s+/)) if (c) classes.add(c);
      },
    });
    this.classList = {
      add: (...cs) => { for (const c of cs) classes.add(c); },
      remove: (...cs) => { for (const c of cs) classes.delete(c); },
      contains: (c) => classes.has(c),
    };
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; } // 与真实 DOM 一致：清空子节点
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) {
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i === -1) return this.appendChild(c);
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    this.children.splice(i, 0, c);
    return c;
  }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i !== -1) { this.children.splice(i, 1); c.parentNode = null; }
    return c;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
}
const fakeDoc = () => ({ createElement: (t) => new FakeEl(t) });

// —— 用真实契约函数驱动一条完整语音会话（对应原型①屏文本）——
function session() {
  let st = initTranscriptState();
  const step = (msg) => { st = applyServerMessage(st, msg); return st; };
  return {
    p0a: step({ type: 'partial', seg: 0, text: '明天下午三点' }),
    p0b: step({ type: 'partial', seg: 0, text: '明天下午三点要跟导师开组' }),
    f0: step({ type: 'final', seg: 0, text: '明天下午三点要跟导师开组会，必须把实验数据先整理好。' }),
    p1a: step({ type: 'partial', seg: 1, text: '还有周五前' }),
    p1b: step({ type: 'partial', seg: 1, text: '还有周五前交课程报告，' }),
    f1: step({ type: 'final', seg: 1, text: '还有周五前交课程报告，' }),
    p2: step({ type: 'partial', seg: 2, text: '晚上有空的话去跑个步' }),
    end: step({ type: 'end' }),
  };
}

const ROOT_CHILD_AFTER = (v) => v.el.children;

// ============================================================
// 纯函数：diffChars / planTranscript / prefersReducedMotion
// ============================================================

test('diffChars：公共前缀 diff（增长 / 改口回退 / 代理对安全）', () => {
  assert.deepEqual(diffChars('', '你好'), { keep: 0, add: '你好', remove: 0 });
  assert.deepEqual(diffChars('明天下午三点', '明天下午三点要跟导师开组'), { keep: 6, add: '要跟导师开组', remove: 0 });
  // ASR 改口（在线结果被替换）：'跑个步' → '跑步'
  assert.deepEqual(diffChars('跑个步', '跑步'), { keep: 1, add: '步', remove: 2 });
  // 完全改写
  assert.deepEqual(diffChars('abc', 'xyz'), { keep: 0, add: 'xyz', remove: 3 });
  // 代理对（emoji / 扩展区汉字）不被拆成半个码元
  assert.deepEqual(diffChars('🎉好', '🎉'), { keep: 1, add: '', remove: 1 });
  assert.deepEqual(diffChars(null, undefined), { keep: 0, add: '', remove: 0 });
});

test('planTranscript：untouched / finalize / partialOps / stablePrefix 分类正确', () => {
  const prev = [
    { seg: 0, text: '第一句定稿。', final: true },
    { seg: 1, text: '还有周五', final: false },
  ];
  const next = [
    { seg: 0, text: '第一句定稿。', final: true },
    { seg: 1, text: '还有周五前交报告，', final: true },
    { seg: 2, text: '晚上', final: false },
  ];
  const plan = planTranscript(prev, next);
  assert.deepEqual(plan.untouched, [{ seg: 0, text: '第一句定稿。' }]); // 已确认前缀：不许重建
  assert.deepEqual(plan.finalize, [{ seg: 1, text: '还有周五前交报告，' }]); // 灰转黑 settle
  assert.deepEqual(plan.partialOps, [
    { seg: 2, text: '晚上', keep: 0, add: '晚上', remove: 0, create: true },
  ]);
  assert.equal(plan.stablePrefix, 1);
  assert.deepEqual(plan.reviseFinal, []);
  assert.deepEqual(plan.createFinal, []);
  assert.deepEqual(plan.drop, []);
});

test('planTranscript：重复 final 同文本 → untouched；改文本 → reviseFinal；稳定前缀断裂处停', () => {
  const prev = [
    { seg: 0, text: 'A。', final: true },
    { seg: 1, text: 'B。', final: true },
  ];
  const same = planTranscript(prev, [
    { seg: 0, text: 'A。', final: true },
    { seg: 1, text: 'B。', final: true },
  ]);
  assert.equal(same.stablePrefix, 2);
  assert.equal(same.untouched.length, 2);
  assert.equal(same.finalize.length, 0);

  const revised = planTranscript(prev, [
    { seg: 0, text: 'A。', final: true },
    { seg: 1, text: 'B 改正。', final: true }, // 契约幂等替换
  ]);
  assert.equal(revised.stablePrefix, 1); // 断裂处停：seg1 不再计入稳定前缀
  assert.deepEqual(revised.reviseFinal, [{ seg: 1, text: 'B 改正。' }]);

  const dropped = planTranscript(prev, [{ seg: 0, text: 'A。', final: true }]);
  assert.deepEqual(dropped.drop, [1]); // 防御分支（契约下不应出现）
});

test('prefersReducedMotion：matchMedia 探测 + 异常环境兜底 false', () => {
  assert.equal(prefersReducedMotion({ matchMedia: (q) => ({ matches: q.includes('reduce') }) }), true);
  assert.equal(prefersReducedMotion({ matchMedia: () => ({ matches: false }) }), false);
  assert.equal(prefersReducedMotion({}), false); // 无 matchMedia
  assert.equal(prefersReducedMotion(undefined), false); // 无 window（Node）
  assert.equal(prefersReducedMotion({ matchMedia: () => { throw new Error('boom'); } }), false);
});

// ============================================================
// 渲染器：增量 DOM（前缀节点不被重建）· 动画类 · 光标 · done
// ============================================================

test('增量渲染：已确认前缀节点对象跨帧保持同一，绝不被重建（不允许整段重排）', () => {
  const doc = fakeDoc();
  const v = createTranscriptView({ doc });
  const s = session();
  const root = v.el;

  // seg0 灰字逐字生长：字符节点只追加，公共前缀节点保持同一对象
  v.update(s.p0a);
  const g0 = root.children[0];
  assert.equal(g0.classList.contains('vt-partial'), true);
  assert.equal(g0.textContent, '明天下午三点');
  const ch0 = g0.children[0];
  v.update(s.p0b);
  assert.equal(root.children[0], g0, 'partial 组节点不得重建');
  assert.equal(g0.children[0], ch0, '已渲染字符节点不得重建');
  assert.equal(g0.children.length, 12); // '明天下午三点要跟导师开组'＝12 字
  assert.equal(g0.textContent, '明天下午三点要跟导师开组');

  // seg0 定稿：灰转黑（settle 动画类），替换该句灰字
  v.update(s.f0);
  assert.notEqual(root.children[0], g0, 'final 后该句节点按原型替换为 .f 结构');
  const f0 = root.children[0];
  assert.equal(f0.classList.contains('vt-final'), true);
  assert.equal(f0.classList.contains(MOTION_CLASSES.settle), true); // settle 320ms 动画类
  assert.equal(f0.textContent, '明天下午三点要跟导师开组会，必须把实验数据先整理好。');
  assert.equal(root.children[root.children.length - 1].classList.contains('vt-caret'), true); // 光标恒在尾部

  // seg1 灰字出现：插在 f0 与光标之间；f0 一步都不许动
  v.update(s.p1a);
  assert.equal(root.children.length, 3);
  assert.equal(root.children[0], f0, '前缀 final 节点不得重建');
  const f0Classes = ['vt-final', MOTION_CLASSES.settle].every((c) => f0.classList.contains(c));
  assert.equal(f0Classes, true);
  const f0Text = f0.textContent;
  const g1 = root.children[1];
  const g1ch0 = g1.children[0];

  // seg1 继续生长 → seg1 定稿：f0 仍是同一对象、同一内容
  v.update(s.p1b);
  assert.equal(g1.children[0], g1ch0);
  v.update(s.f1);
  const f1 = root.children[1];
  assert.equal(f1.classList.contains('vt-final'), true);
  assert.equal(f1.classList.contains(MOTION_CLASSES.settle), true);
  assert.equal(root.children[0], f0, '★核心断言：跨多次更新后前缀 final 节点对象不变');
  assert.equal(f0.textContent, f0Text, '前缀文本不变');
  assert.equal(f0.classList.contains('vt-final'), true);

  // seg2 灰字追加到尾部（只更新尾部）
  const before = root.children.length;
  v.update(s.p2);
  assert.equal(root.children.length, before + 1);
  assert.equal(root.children[0], f0);
  assert.equal(root.children[1], f1);
  assert.equal(root.children[2].classList.contains('vt-partial'), true);
  assert.equal(root.children[3].classList.contains('vt-caret'), true);
});

test('逐字浮现：新字符节点带 vt-in；早先字符不重复加动画类；重复同帧更新零 DOM churn', () => {
  const doc = fakeDoc();
  const v = createTranscriptView({ doc });
  const s = session();
  v.update(s.p0a);
  const g0 = v.el.children[0];
  for (const ch of g0.children) assert.equal(ch.classList.contains(MOTION_CLASSES.charIn), true);
  const snapshot = [...g0.children];
  v.update(s.p0a); // 完全相同的帧：不得新建/删除任何节点
  assert.deepEqual(v.el.children[0].children, snapshot);
  assert.equal(g0.children.length, snapshot.length);
  v.update(s.p0b);
  assert.equal(g0.children[0], snapshot[0]);
  for (let i = 0; i < snapshot.length; i++) assert.equal(g0.children[i], snapshot[i]);
  for (const ch of g0.children.slice(snapshot.length)) {
    assert.equal(ch.classList.contains(MOTION_CLASSES.charIn), true); // 只有新字带浮现动画
    assert.equal(ch.classList.contains('vt-ch'), true);
  }
});

test('光标与终态：end 后 caret 移除并打 vt-done；text() 走 contracts.transcriptView', () => {
  const doc = fakeDoc();
  const v = createTranscriptView({ doc });
  const s = session();
  v.update(s.p0a);
  v.update(s.f0);
  v.update(s.p1b);
  v.update(s.f1);
  v.update(s.p2);
  const caret = v.el.children[v.el.children.length - 1];
  assert.equal(caret.classList.contains('vt-caret'), true);
  assert.equal(caret.ariaHidden, 'true');
  const lastSeg = v.el.children[2];
  v.update(s.end);
  assert.equal(v.el.classList.contains('vt-done'), true);
  assert.equal(v.el.children.includes(caret), false, '会话结束移除光标');
  assert.equal(v.el.children[v.el.children.length - 1], lastSeg, '尾部内容不动');
  // text() 与契约视图一致（黑 + 灰拼接）
  const viaContracts = transcriptView(s.end);
  assert.equal(v.text(), viaContracts.finalText + viaContracts.partialText);
  assert.equal(v.text(), '明天下午三点要跟导师开组会，必须把实验数据先整理好。还有周五前交课程报告，晚上有空的话去跑个步');
});

test('reset()：清空所有句子与终态类，恢复光标', () => {
  const doc = fakeDoc();
  const v = createTranscriptView({ doc });
  const s = session();
  v.update(s.f0);
  v.update(s.end);
  v.reset();
  assert.equal(v.el.children.length, 1);
  assert.equal(v.el.children[0].classList.contains('vt-caret'), true);
  assert.equal(v.el.classList.contains('vt-done'), false);
  assert.equal(v.text(), '');
  v.update(s.p0a); // reset 后可复用
  assert.equal(v.el.children[0].classList.contains('vt-partial'), true);
});

test('error 状态：打 vt-error 类并带 data-error（样式层提示，SPEC §2.2）', () => {
  const doc = fakeDoc();
  const v = createTranscriptView({ doc });
  let st = applyServerMessage(initTranscriptState(), { type: 'partial', seg: 0, text: '嗯' });
  st = applyServerMessage(st, { type: 'error', code: 'asr-unavailable' });
  v.update(st);
  assert.equal(v.el.classList.contains('vt-error'), true);
  assert.equal(v.el.dataset.error, 'asr-unavailable');
});

// ============================================================
// reduced-motion 分支（SPEC §3「尊重 prefers-reduced-motion」）
// ============================================================

test('reduced-motion 分支：vt-motion-off 根类；不加 vt-in / vt-just；前缀稳定仍成立', () => {
  const doc = fakeDoc();
  const v = createTranscriptView({ doc, reducedMotion: true });
  const s = session();
  assert.equal(v.el.classList.contains(MOTION_CLASSES.motionOff), true);
  v.update(s.p0a);
  const g0 = v.el.children[0];
  for (const ch of g0.children) assert.equal(ch.classList.contains(MOTION_CLASSES.charIn), false);
  v.update(s.f0);
  const f0 = v.el.children[0];
  assert.equal(f0.classList.contains('vt-final'), true);
  assert.equal(f0.classList.contains(MOTION_CLASSES.settle), false, '降级：无 settle 动画类');
  v.update(s.p1b);
  v.update(s.f1);
  assert.equal(v.el.children[0], f0, '降级分支前缀同样不被重建');
  assert.equal(v.el.classList.contains(MOTION_CLASSES.motionOff), true);
});

test('默认构造器用 prefersReducedMotion 探测（win.matchMedia=true → 自动降级）', () => {
  const savedGlobal = globalThis.window;
  globalThis.window = { matchMedia: (q) => ({ matches: q.includes('reduce') }) };
  try {
    const v = createTranscriptView({ doc: fakeDoc() });
    assert.equal(v.el.classList.contains(MOTION_CLASSES.motionOff), true);
  } finally {
    if (savedGlobal === undefined) delete globalThis.window; else globalThis.window = savedGlobal;
  }
});

// ============================================================
// voice.css：SPEC §4 token 与原型①屏样式对齐（静态断言）
// ============================================================

test('voice.css：SPEC §4 语音 token 值逐项一致', () => {
  const css = readFileSync(new URL('../../web/voice/voice.css', import.meta.url), 'utf8');
  for (const re of [
    /--vt-size:\s*22px/, /--vt-line:\s*1\.62/, /--vt-track:\s*\.3px/,
    /--vt-weight-final:\s*500/, /--vt-weight-partial:\s*400/,
    /--vt-final:\s*#252722/i, /--vt-partial:\s*#A3A59B/i, /--vt-caret:\s*#E95432/i,
    /--p1:\s*#C2412D/i, /--p1-bg:\s*#FCE8E3/i,
    /--p2:\s*#C7701F/i, /--p2-bg:\s*#FDF0E1/i,
    /--p3:\s*#5E6158/i, /--p3-bg:\s*#EFEEE8/i,
    /--p4:\s*#4C7A93/i, /--p4-bg:\s*#E6EFF4/i,
    /--p5:\s*#3E7B5B/i, /--p5-bg:\s*#E5F1EA/i,
  ]) {
    assert.match(css, re);
  }
});

test('voice.css：原型①屏排版与动画（palt / pretty / settle .32s / rise .18s / 光标 / 呼吸）+ reduced-motion 降级', () => {
  const css = readFileSync(new URL('../../web/voice/voice.css', import.meta.url), 'utf8');
  assert.match(css, /font-feature-settings:\s*"palt"/);       // SPEC §4：标点不落行首
  assert.match(css, /text-wrap:\s*pretty/);
  assert.match(css, /vt-settle\s+\.32s/);                     // SPEC §3：settle 320ms
  assert.match(css, /vt-rise\s+\.18s/);                       // 原型 .ch 逐字浮现
  assert.match(css, /\.vt-caret[\s{]/);                       // 光标（原型 blink 1s steps(1)）
  assert.match(css, /vt-blink\s+1s\s+steps\(1\)/);
  assert.match(css, /vt-breathe\s+1\.2s/);                    // 呼吸（原型尾部字呼吸）
  // 降级 1：CSS 媒体查询
  const m = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*{([\s\S]*?)\n}/);
  assert.ok(m, '必须有 prefers-reduced-motion 媒体查询');
  assert.match(m[1], /animation:\s*none/);
  assert.match(m[1], /\.vt-caret/);
  // 降级 2：JS 分支类 vt-motion-off 的 CSS 兜底
  assert.match(css, /\.vt-motion-off[\s\S]{0,400}animation:\s*none/);
  // settle 动画从灰到黑（灰转黑）
  const settle = css.match(/@keyframes\s+vt-settle\s*{([\s\S]*?)\n}/);
  assert.ok(settle);
  assert.match(settle[1], /--vt-partial/);
  assert.match(settle[1], /--vt-final/);
});
