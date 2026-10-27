// M07 预演四档进度 + 场景片异步卡 纯核/壳桩单测（RED 先行 · 实现前必红）
// 依据：BUILD-PLAN §2.3 TDD / §3 W5 小节；plan.md M07；PRD §5.2.1 四档语义（L0 形/L1 样/L2 动/L3 真）
//   + D-9（L3 默认关，PRD L942）+ §10.3 scene 字段（status: off|queued|generating|ready，默认 off，L770-775）；
//   prototype.html（唯一视觉标准）L137-140（.tiers/.tier）、L146（.wm）、L159-164（.scenebox/.bar）、
//   L373-377（tiersHTML 四档 + 真三态）、L378-382（sceneHTML 两态）、L583-584（进度条 0→100% 语义）。
// 契约：
//   web/agentic/ui/tiers.js 具名导出
//     SCENE_STATES / normalizeScene / canSceneOf / sampleSecOf / realTierHTML / tiersHTML /
//     TIER_CSS / ensureStyles / mount(el,{blockId,scene,canScene,secs,onReel,onScene}) → handle.update
//   web/agentic/ui/scene-card.js 具名导出
//     SAFE_MEDIA / safeMedia / barWidth / sceneHTML / SCENE_CSS / ensureStyles /
//     mount(el,{scene,progress,title,caption,model}) → {el,update,setProgress}
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as tiersMod from '../../../../web/agentic/ui/tiers.js';
import * as sceneMod from '../../../../web/agentic/ui/scene-card.js';

const {
  SCENE_STATES, normalizeScene, canSceneOf, sampleSecOf,
  realTierHTML, tiersHTML, TIER_CSS, ensureStyles, mount,
} = tiersMod;
const {
  SAFE_MEDIA, safeMedia, barWidth, sceneHTML, SCENE_CSS,
  ensureStyles: ensureSceneStyles, mount: mountScene,
} = sceneMod;

// ---------- A. tiers.js 纯核 ----------

test('M07 SCENE_STATES：PRD §10.3 四态顺序，off 为默认（D-9）', () => {
  assert.deepEqual(SCENE_STATES, ['off', 'queued', 'generating', 'ready']);
});

test('M07 normalizeScene：字符串/对象归一，非法一律 off（D-9 默认关）', () => {
  assert.equal(normalizeScene('off'), 'off');
  assert.equal(normalizeScene('queued'), 'queued');
  assert.equal(normalizeScene('generating'), 'generating');
  assert.equal(normalizeScene('ready'), 'ready');
  assert.equal(normalizeScene({ status: 'generating' }), 'generating');
  assert.equal(normalizeScene({ status: 'ready', url: 'assets/x.mp4' }), 'ready');
  assert.equal(normalizeScene('gen'), 'generating', 'prototype L375 内部态 gen 别名归一');
  assert.equal(normalizeScene(''), 'off');
  assert.equal(normalizeScene(undefined), 'off');
  assert.equal(normalizeScene(null), 'off');
  assert.equal(normalizeScene('bogus'), 'off');
  assert.equal(normalizeScene('Ready'), 'off', '大小写敏感：非法归 off');
  assert.equal(normalizeScene({ status: 42 }), 'off');
  assert.equal(normalizeScene({}), 'off');
  assert.equal(normalizeScene([]), 'off');
});

test('M07 canSceneOf：黄金场景仅 c 块可生成场景片（prototype L373/375 id===c）', () => {
  assert.equal(canSceneOf('c'), true);
  for (const id of ['r', 'f', 'b', 's']) assert.equal(canSceneOf(id), false, `${id} 不需要`);
  assert.equal(canSceneOf(undefined), false);
  assert.equal(canSceneOf(''), false);
});

test('M07 sampleSecOf：c 块 7.4s（qwen-image-2.0 带字），其余 3.9s（prototype L376）', () => {
  assert.equal(sampleSecOf('c'), '7.4s');
  assert.equal(sampleSecOf('r'), '3.9s');
  assert.equal(sampleSecOf(), '3.9s');
});

test('M07 tiersHTML：四档 chips 结构与形/样/动 原文（prototype L376）', () => {
  const html = tiersHTML({ blockId: 'c', scene: 'off' });
  assert.ok(html.startsWith('<div class="tiers">'), '.tiers 容器');
  const chips = [...html.matchAll(/class="tier(?: ok| go)?"([^>]*)>([^<]*)/g)];
  assert.equal(chips.length, 4, '恰好四档（不含 .tiers 容器自身）');
  assert.ok(html.includes('<span class="tier ok">形 ✓ 1.6s</span>'), 'L0 形 ✓ 1.6s');
  assert.ok(html.includes('<span class="tier ok">样 ✓ 7.4s</span>'), 'c 块 L1 样 7.4s');
  assert.ok(html.includes('<button type="button" class="tier go" data-reel="1">动 ▶ 预演片 42s</button>'), 'L2 动 ▶ 预演片 42s');
  assert.ok(tiersHTML({ blockId: 'r', scene: 'off' }).includes('样 ✓ 3.9s'), 'r 块样张 3.9s');
});

test('M07 realTierHTML 三态 + 不需要（prototype L375，D-9 默认关）', () => {
  assert.equal(
    realTierHTML({ blockId: 'c', scene: 'off' }),
    '<button type="button" class="tier go" data-scene="c">真 · 生成场景片（约 2 分钟）</button>',
  );
  assert.ok(realTierHTML({ blockId: 'c', scene: 'queued' }).includes('生成中'), 'queued 计入生成中');
  const gen = realTierHTML({ blockId: 'c', scene: 'generating' });
  assert.ok(gen.startsWith('<span class="tier"'), '生成中非按钮（防重复触发）');
  assert.ok(gen.includes('真 · 生成中…'));
  assert.ok(gen.includes('aria-busy="true"'), '忙态播报');
  const ok = realTierHTML({ blockId: 'c', scene: 'ready' });
  assert.ok(ok.includes('class="tier ok"') && ok.includes('真 ✓ 场景片'), 'ready → ok ✓');
  assert.equal(realTierHTML({ blockId: 'r', scene: 'off' }), '<span class="tier">真 · 不需要</span>');
  assert.equal(realTierHTML({ blockId: 'r', scene: 'ready' }), '<span class="tier">真 · 不需要</span>', '状态不改变「不需要」');
});

test('M07 canScene 显式覆盖：非 c 块也可开（D2/R1/R3 任务），c 块也可关', () => {
  assert.ok(realTierHTML({ blockId: 'b', scene: 'off', canScene: true }).includes('data-scene="b"'));
  assert.ok(realTierHTML({ blockId: 'b', scene: 'ready', canScene: true }).includes('tier ok'));
  assert.equal(realTierHTML({ blockId: 'c', scene: 'off', canScene: false }), '<span class="tier">真 · 不需要</span>');
  assert.equal(realTierHTML({ blockId: 'c', scene: 'off', canScene: 0 }), '<span class="tier">真 · 不需要</span>', '假值生效');
});

test('M07 secs 覆盖：形/样/动 耗时文案可注入（fixtures/真实计时）', () => {
  const html = tiersHTML({ blockId: 'c', scene: 'off', secs: { shape: '2.0s', sample: '8.1s', reel: '55s' } });
  assert.ok(html.includes('形 ✓ 2.0s'));
  assert.ok(html.includes('样 ✓ 8.1s'));
  assert.ok(html.includes('动 ▶ 预演片 55s'));
});

test('M07 转义：blockId 入属性必经 esc（M01 XSS 基线）', () => {
  const html = realTierHTML({ blockId: '"><script>', scene: 'off', canScene: true });
  assert.ok(!html.includes('"><script>'), '不得透传原始注入串');
  assert.ok(html.includes('data-scene="&quot;&gt;&lt;script&gt;"'));
});

test('M07 TIER_CSS/ensureStyles：.tiers/.tier 规则 + 幂等注入（M06 同款桩）', () => {
  assert.ok(TIER_CSS.includes('.tiers'), '含 .tiers 布局（prototype L137）');
  assert.ok(TIER_CSS.includes('.tier.go'), '含 go 态（L140）');
  const mkDoc = (tag) => {
    const doc = { _styles: [] };
    doc.querySelector = (sel) => (sel === `style[${tag}]` ? doc._styles[0] ?? null : null);
    doc.createElement = () => ({ _attrs: {}, textContent: '', setAttribute(k, v) { this._attrs[k] = String(v); } });
    doc.head = { appendChild: (n) => doc._styles.push(n) };
    return doc;
  };
  const doc = mkDoc('data-agentic-tiers');
  assert.equal(ensureStyles(doc), true);
  assert.equal(doc._styles.length, 1);
  assert.ok(doc._styles[0].textContent.includes('.tiers'));
  assert.equal(ensureStyles(doc), false, '已注入不再重复');
  assert.equal(ensureStyles(null), false, '无 doc 安全返回');
});

// ---------- B. tiers.js DOM 壳（mount/update，stub 同 M05/M06 白盒桩模式） ----------

function stubReelTarget(dataset) {
  return {
    dataset,
    closest(sel) {
      if (sel === '[data-reel]' && 'reel' in this.dataset) return this;
      if (sel === '[data-scene]' && 'scene' in this.dataset) return this;
      return null;
    },
  };
}

function stubHost() {
  return {
    _h: undefined, _v: '', writes: 0, listeners: {},
    get innerHTML() { return this._v; },
    set innerHTML(v) { this.writes += 1; this._v = v; },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    fire(type, target) { for (const fn of this.listeners[type] ?? []) fn({ target }); },
  };
}

test('M07 tiers mount：首渲染写入；同参 update 零重写（setHTML 内容比对）', () => {
  const host = stubHost();
  const handle = mount(host, { blockId: 'c', scene: 'off' });
  assert.equal(host.writes, 1);
  assert.ok(host.innerHTML.includes('data-reel="1"') && host.innerHTML.includes('生成场景片'));
  assert.equal(handle.el, host);
  assert.equal(typeof handle.update, 'function');
  host.writes = 0;
  handle.update({ blockId: 'c', scene: 'off' });
  assert.equal(host.writes, 0, '状态未变不得重写（增量约束）');
});

test('M07 tiers update 状态机 off→generating→ready 切档正确重绘', () => {
  const host = stubHost();
  const handle = mount(host, { blockId: 'c', scene: 'off' });
  handle.update({ scene: 'generating' });
  assert.ok(host.innerHTML.includes('生成中') && !host.innerHTML.includes('生成场景片（约'));
  handle.update({ scene: 'ready' });
  assert.ok(host.innerHTML.includes('tier ok') && host.innerHTML.includes('真 ✓ 场景片'));
  handle.update({ scene: 'off' });
  assert.ok(host.innerHTML.includes('生成场景片（约 2 分钟）'), '回 off 恢复生成按钮（可重试）');
  handle.update({ blockId: 'r' });
  assert.ok(host.innerHTML.includes('真 · 不需要') && host.innerHTML.includes('样 ✓ 3.9s'), '切块换文案+关真档');
});

test('M07 tiers 点击委托：动 ▶ → onReel()；生成场景片 → onScene(blockId)', () => {
  const host = stubHost();
  const calls = [];
  mount(host, { blockId: 'c', scene: 'off', onReel: () => calls.push(['reel']), onScene: (id) => calls.push(['scene', id]) });
  host.fire('click', stubReelTarget({ reel: '1' }));
  host.fire('click', stubReelTarget({ scene: 'c' }));
  assert.deepEqual(calls, [['reel'], ['scene', 'c']]);
  assert.equal((host.listeners.click ?? []).length, 1, '容器级单监听');
  host.fire('click', { closest: () => null }); // 点到档外：不回调不抛
  host.fire('click', {}); // target 无 closest：容忍
  assert.deepEqual(calls, [['reel'], ['scene', 'c']]);
  const silent = stubHost(); // 未给回调：点击不得抛
  mount(silent, { blockId: 'c', scene: 'off' });
  silent.fire('click', stubReelTarget({ reel: '1' }));
  silent.fire('click', stubReelTarget({ scene: 'c' }));
  const headless = stubHost(); // 宿主无 addEventListener：mount 不得抛
  delete headless.addEventListener;
  mount(headless, { blockId: 'c', scene: 'off' });
  assert.equal(headless.writes, 1);
});

test('M07 tiers update 容忍空/非法 props 且链式；scene 缺省不覆盖旧值', () => {
  const host = stubHost();
  const handle = mount(host, { blockId: 'c', scene: 'generating' });
  const ret = handle.update({}).update(undefined);
  assert.equal(typeof ret.update, 'function', '链式返回 handle');
  assert.ok(host.innerHTML.includes('生成中'), '未传 scene 不得回退 off');
  handle.update({ scene: null }); // 显式 null 归一 off（D-9 缺省即关）
  assert.ok(host.innerHTML.includes('生成场景片'));
  handle.update({ onReel: '不是函数' }); // 非函数回调归一，不抛
  host.fire('click', stubReelTarget({ reel: '1' }));
});

// ---------- C. scene-card.js 纯核 ----------

test('M07 SAFE_MEDIA/safeMedia：相对路径白名单（同 M04 SAFE_SRC 规则）', () => {
  assert.equal(SAFE_MEDIA.source, /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.source);
  assert.equal(safeMedia('assets/scene-classroom.mp4'), 'assets/scene-classroom.mp4');
  assert.equal(safeMedia('assets/scene-classroom-poster.jpg'), 'assets/scene-classroom-poster.jpg');
  assert.equal(safeMedia('javascript:alert(1)'), '', '禁协议');
  assert.equal(safeMedia('DATA:text/html,x'), '', '禁 data:');
  assert.equal(safeMedia('https://evil.com/x.mp4'), '', '禁绝对 URL');
  assert.equal(safeMedia('//evil.com/x.mp4'), '', '禁协议相对');
  assert.equal(safeMedia('/abs/x.mp4'), '', '禁站内绝对路径');
  assert.equal(safeMedia('../secret.mp4'), '', '禁父目录');
  assert.equal(safeMedia('assets/../../etc/passwd'), '', '禁内嵌 ..');
  assert.equal(safeMedia('a b.mp4'), '', '禁空白字符');
  assert.equal(safeMedia(''), '');
  assert.equal(safeMedia(null), '');
  assert.equal(safeMedia(42), '');
});

test('M07 barWidth：0–100 夹取，非数归 0', () => {
  assert.equal(barWidth(0), 0);
  assert.equal(barWidth(40), 40);
  assert.equal(barWidth(100), 100);
  assert.equal(barWidth(-5), 0);
  assert.equal(barWidth(120), 100);
  assert.equal(barWidth('40'), 40, '数字串容忍');
  assert.equal(barWidth(40.6), 40, '取整');
  assert.equal(barWidth(undefined), 0);
  assert.equal(barWidth(NaN), 0);
  assert.equal(barWidth('abc'), 0);
});

test('M07 sceneHTML：off → 空串（D-9 不渲染）', () => {
  assert.equal(sceneHTML({ status: 'off' }), '');
  assert.equal(sceneHTML({}), '');
  assert.equal(sceneHTML(undefined), '');
  assert.equal(sceneHTML('off'), '');
});

test('M07 sceneHTML：generating → aria-live + 进度条 + 不阻塞文案（prototype L380/L162-164）', () => {
  const html = sceneHTML({ status: 'generating' });
  assert.ok(html.includes('class="scenebox"'), '.scenebox 容器');
  assert.ok(html.includes('aria-live="polite"'), 'polite 播报（DAG M07）');
  assert.ok(html.includes('role="status"'));
  assert.ok(html.includes('<b>场景片生成中</b>'));
  assert.ok(html.includes('happyhorse-1.1'), '默认模型（prototype L380）');
  assert.ok(html.includes('不影响签约'), '绝不阻塞签约（PRD §5.2.1 L3 规则）');
  assert.ok(html.includes('<div class="bar"><i style="width:0%"></i></div>'), '进度条 0% 起（L583 pctv=0）');
  assert.ok(sceneHTML({ status: 'generating', progress: 40 }).includes('width:40%'), 'progress 注入');
});

test('M07 sceneHTML：queued → 排队中变体 + 进度条', () => {
  const html = sceneHTML({ status: 'queued' });
  assert.ok(html.includes('场景片排队中'));
  assert.ok(html.includes('<div class="bar">'));
});

test('M07 sceneHTML：ready → 16:9 frame + video 五属性 + 「示意 · AI 生成」角标（prototype L381-382）', () => {
  const html = sceneHTML({ status: 'ready', url: 'assets/scene-classroom.mp4', poster: 'assets/scene-classroom-poster.jpg' });
  assert.ok(html.includes('aria-live="polite"'), 'ready 也保持播报容器');
  assert.ok(html.includes('style="aspect-ratio:16/9"'), '.frame 16:9（L381 原文）');
  const video = html.match(/<video ([^>]*)>/);
  assert.ok(video, '含 video');
  const attrs = video[1];
  assert.ok(attrs.includes('src="assets/scene-classroom.mp4"'));
  assert.ok(attrs.includes('poster="assets/scene-classroom-poster.jpg"'));
  assert.ok(attrs.includes('controls'));
  assert.ok(attrs.includes('muted'));
  assert.ok(attrs.includes('playsinline'));
  assert.ok(attrs.includes('loop'));
  assert.ok(html.includes('<span class="wm">示意 · AI 生成</span>'), 'wm 角标（L381/P1 诚实原则）');
  assert.ok(html.includes('1080p 5 秒'), '规格行（L382）');
  assert.ok(html.includes('只是氛围参考，不是交付物'), '防把预演当成品');
});

test('M07 sceneHTML：title/caption/model 可覆盖；ready 无 url → 降级无 video 不造假', () => {
  const html = sceneHTML({ status: 'ready', url: 'assets/x.mp4', title: '场景片 · 第 2 课时现场（示意）' });
  assert.ok(html.includes('<b>场景片 · 第 2 课时现场（示意）</b>'), '标题注入（prototype L381 原文）');
  const noUrl = sceneHTML({ status: 'ready' });
  assert.ok(!noUrl.includes('<video'), '无 url 不渲染空 video');
  assert.ok(noUrl.includes('示意 · AI 生成'), '角标仍在（宁缺勿假）');
  const custom = sceneHTML({ status: 'generating', model: 'wan2.7-t2v' });
  assert.ok(custom.includes('wan2.7-t2v') && !custom.includes('happyhorse'), '模型名注入（PRD §2.4 wan2.7）');
  const cap = sceneHTML({ status: 'ready', url: 'assets/x.mp4', caption: '5 秒 · 生成用时 300s' });
  assert.ok(cap.includes('5 秒 · 生成用时 300s'));
});

test('M07 sceneHTML：url/poster 白名单外的值整段丢弃（XSS 基线）', () => {
  const html = sceneHTML({ status: 'ready', url: 'javascript:alert(1)', poster: 'https://evil/x.jpg' });
  assert.ok(!html.includes('javascript:'), '协议 url 不落 src');
  assert.ok(!html.includes('https://evil'), '协议 poster 不落属性');
  assert.ok(!html.includes('<video'), 'url 无效则不渲染 video');
  const half = sceneHTML({ status: 'ready', url: 'assets/ok.mp4', poster: 'javascript:x' });
  assert.ok(half.includes('src="assets/ok.mp4"'));
  assert.ok(!half.includes('poster='), '坏 poster 只丢 poster');
});

test('M07 SCENE_CSS/ensureStyles：.scenebox/.bar/.wm 规则 + 幂等（M06 同款桩）', () => {
  assert.ok(SCENE_CSS.includes('.scenebox'), '容器（prototype L159）');
  assert.ok(SCENE_CSS.includes('.scenebox .bar i'), '进度条（L163-164）');
  assert.ok(SCENE_CSS.includes('prefers-reduced-motion'), 'reduced-motion 降级');
  const mkDoc = (tag) => {
    const doc = { _styles: [] };
    doc.querySelector = (sel) => (sel === `style[${tag}]` ? doc._styles[0] ?? null : null);
    doc.createElement = () => ({ _attrs: {}, textContent: '', setAttribute(k, v) { this._attrs[k] = String(v); } });
    doc.head = { appendChild: (n) => doc._styles.push(n) };
    return doc;
  };
  const doc = mkDoc('data-agentic-scene');
  assert.equal(ensureSceneStyles(doc), true);
  assert.equal(doc._styles.length, 1);
  assert.equal(ensureSceneStyles(doc), false, '已注入不再重复');
  assert.equal(ensureSceneStyles(null), false);
});

// ---------- D. scene-card.js DOM 壳（.scenebox 节点跨 update 存活 = spec 增量断言的 node 等价覆盖） ----------

function stubEl() {
  return { _h: undefined, _v: '', writes: 0, get innerHTML() { return this._v; }, set innerHTML(v) { this.writes += 1; this._v = v; } };
}

/** .scenebox 桩：innerHTML 写入即模拟浏览器重解析子节点（b/.small/.bar i/.frame 按内容重建） */
function stubBox() {
  const box = {
    _h: undefined, _v: '', writes: 0, marker: 'keep-scenebox',
    b: stubEl(), small: stubEl(), barI: { style: {} }, frame: null,
    get innerHTML() { return this._v; },
    set innerHTML(v) {
      this.writes += 1; this._v = v;
      this.b = stubEl(); this.small = stubEl();
      const w = v.match(/width:(\d+)%/);
      this.barI = { style: { width: w ? `${w[1]}%` : '0%' } };
      this.frame = v.includes('<div class="frame"') ? stubEl() : null;
    },
    querySelector(sel) {
      if (sel === 'b') return this.b;
      if (sel === '.small') return this.small;
      if (sel === '.bar' || sel === '.bar i') return this.hasBar() ? this.barI : null;
      if (sel === '.frame') return this.frame;
      return null;
    },
    hasBar() { return this._v.includes('class="bar"'); },
  };
  return box;
}

function stubSceneHost() {
  const host = {
    _h: undefined, _v: '', writes: 0, box: null,
    get innerHTML() { return this._v; },
    set innerHTML(v) {
      this.writes += 1; this._v = v;
      if (v.includes('class="scenebox"')) {
        if (!this.box) this.box = stubBox();
        const inner = v.slice(v.indexOf('>') + 1);
        this.box._h = undefined; // 宿主重写 = 浏览器重新解析 .scenebox 全部子节点
        this.box.innerHTML = inner.slice(0, -6);
      } else {
        this.box = null;
      }
    },
    querySelector(sel) { return sel === '.scenebox' ? this.box : null; },
  };
  return host;
}

test('M07 scene mount：off → 宿主空（D-9 默认不渲染）', () => {
  const host = stubSceneHost();
  const handle = mountScene(host, { scene: { status: 'off' } });
  assert.equal(host.innerHTML, '');
  assert.equal(typeof handle.update, 'function');
  assert.equal(typeof handle.setProgress, 'function');
});

test('M07 scene mount：generating → bar 宽度百分比；同态 update 不重建（spec「width:%」断言等价）', () => {
  const host = stubSceneHost();
  const handle = mountScene(host, { scene: { status: 'generating' }, progress: 20 });
  const box = host.box;
  assert.ok(box, '已建 .scenebox');
  assert.equal(box.querySelector('.bar i').style.width, '20%');
  const barINode = box.barI;
  box.writes = 0;
  handle.update({ scene: { status: 'generating' } }); // progress 未传 → 保旧值
  assert.equal(box.writes, 0, '同态只补宽度/文案，.scenebox 子树不整绘');
  assert.equal(barINode.style.width, '20%', '<i> 节点身份保留且宽度恒为百分比');
  assert.equal(box.marker, 'keep-scenebox', '.scenebox 节点身份保留');
  handle.update({ progress: 64 });
  assert.equal(box.querySelector('.bar i').style.width, '64%', 'progress 单独可推');
  handle.update({ scene: { status: 'queued' } });
  assert.equal(box.b.innerHTML, '场景片排队中', 'queued→标题打补丁');
});

test('M07 scene update：generating→ready 同卡原地升级（.scenebox 存活 + video 出现，spec 等价）', () => {
  const host = stubSceneHost();
  const handle = mountScene(host, { scene: { status: 'generating' } });
  const box = host.box;
  handle.update({ scene: { status: 'ready', url: 'assets/scene-classroom.mp4', poster: 'assets/scene-classroom-poster.jpg' } });
  assert.equal(host.box, box, '同一 .scenebox 节点（data-marker 等价断言）');
  assert.ok(box._v.includes('<video'), '原地升级出 video');
  assert.ok(box._v.includes('示意 · AI 生成'));
  assert.ok(box._v.includes('assets/scene-classroom.mp4'));
  box.writes = 0;
  handle.update({ scene: { status: 'ready' } }); // 同 ready 同参：内容比对跳过
  assert.equal(box.writes, 0, 'ready→ready 未变不重写');
  handle.update({ scene: { status: 'ready', url: 'assets/other.mp4' } });
  assert.ok(box._v.includes('assets/other.mp4'), '换 url 原地重灌');
  handle.update({ scene: { status: 'off' } });
  assert.equal(host.innerHTML, '', '回 off 整卡移除');
  assert.equal(host.box, null);
});

test('M07 scene setProgress：夹取 + 直接推条不重绘；非生成态 no-op', () => {
  const host = stubSceneHost();
  const handle = mountScene(host, { scene: { status: 'generating' } });
  const box = host.box;
  box.writes = 0;
  assert.equal(handle.setProgress(48), true);
  assert.equal(box.barI.style.width, '48%');
  assert.equal(handle.setProgress(300), true);
  assert.equal(box.barI.style.width, '100%');
  assert.equal(handle.setProgress(-9), true);
  assert.equal(box.barI.style.width, '0%');
  assert.equal(box.writes, 0, '只动 style 不重写子树');
  handle.update({ scene: { status: 'ready', url: 'assets/x.mp4' } });
  assert.equal(handle.setProgress(50), false, 'ready 态无进度条可推');
  assert.equal(handle.setProgress('x'), false, '非数 no-op');
});

test('M07 scene mount 容忍：无 props / 字符串 scene / update 空对象链式', () => {
  const host = stubSceneHost();
  const handle = mountScene(host);
  assert.equal(host.innerHTML, '', '缺省 scene 归 off（D-9）');
  const ret = handle.update({}).update(undefined);
  assert.equal(typeof ret.update, 'function');
  handle.update({ scene: 'generating' }); // 字符串形态（tiers 同款归一）
  assert.ok(host.box, '字符串 scene 也能建卡');
  handle.update({ scene: { status: 'queued' } });
  assert.equal(host.box.querySelector('b').innerHTML, '场景片排队中', 'queued 标题打补丁');
  handle.update({ title: '场景片 · 第 2 课时现场（示意）' });
  assert.equal(host.box.querySelector('b').innerHTML, '场景片排队中', '忙态标题固定为状态文案，不吃自定义标题');
  handle.update({ scene: { status: 'ready', url: 'assets/x.mp4' } });
  assert.ok(host.box._v.includes('场景片 · 第 2 课时现场（示意）'), 'ready 后自定义标题生效');
});
