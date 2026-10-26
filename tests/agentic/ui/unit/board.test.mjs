// M15 交付台泳道 单测（RED 先行 · 实现前必红）
// 依据：plan.md M15、PRD §5.4（L294 交付台 Day Board：纵轴今天的日程块（泳道）、横轴时间；
//   每条泳道显示该块 agent 的步骤条、用户触点、交付时刻；当前时刻竖线；全局「全部暂停」
//   按钮常驻）、§5.8（L324 交付台在 50 个块内保持 60fps；L325 移动端交付台改为纵向时间线）、
//   §5.2 末（L275 增量更新硬约束——整块重绘会让点击失效/展开被收起）、§1.2 P4（一键停）；
//   prototype.html（唯一视觉/交互标准）L107-116（.board/.lanes/.lane 120px+1fr/.track
//   34px 圆角溢出隐藏/.seg 色类 r/w/v/u/d/g + title 提示/.nowline you 色 2px/axis 120px
//   刻度 space-between）、L133（.toolbar flex）、L222-231（交付台卡：toolbar = h2 +
//   spacer + #simState 文案 + 速度 ×1 按钮 + .danger 全部暂停（disabled）；.axis 七刻度
//   13:00–19:00；#lanes）、L507-513（renderLanes：每块一 .lane（.name=statusDot+标题 +
//   .track）；时间窗虚线框 left/width=窗口百分比 border-left/right dashed（起点 ≥ 19:00
//   不画）；seg left/width calc 百分比；nowline left=pct(min(DAY1,max(DAY0,sim)))，
//   running||signed 才显示）、L528-530（pauseAll.disabled=!running、paused 文案「继续」、
//   simState 四态文案）、L58-64（.dot prep/live/need/ready/done + pulse 动画）、
//   L638-639（全部暂停开合 / 速度 ×1↔×4 → onSpeed 回调）、L244-247（T/HM/pct：
//   DAY0=13:00=780、DAY1=19:00=1140、百分比 toFixed(2)）。
// 契约：web/agentic/ui/board.js 具名导出
//   BOARD_TITLE / DAY0_MIN / DAY1_MIN / AXIS_TICKS / SEG_CLASSES / DOT_STATUSES /
//   PAUSE_LABEL / RESUME_LABEL / SPEED_PREFIX / DEFAULT_SIM_STATE、esc/setHTML、
//   parseHM / clampToDay / pctStr / nowPctStr、normalizeBlocks / normalizeSegs /
//   normalizeSpeed / normalizeSimState / normalizeNow / segsFor、statusDotHTML /
//   nowlineHTML / segHTML / winHTML / laneHTML / lanesHTML / axisHTML / toolbarHTML /
//   boardHTML、BOARD_CSS / ensureStyles、
//   mount(el, { blocks, segs, now, running, paused, signed, speed, simState,
//               onPauseAll, onSpeed }) → { el, update(props) }
//   block = { id, start, end, title, status? }（HH:MM 窗口）；segs = { b, s, e, c, text }[]
//   （c ∈ r/w/v/u/d/g）；now = 当日分钟数（number 或 'HH:MM'）。
// 增量硬约束（DAG M15「update 只挪 seg/nowline 样式不重建行」，50 块 60fps）：壳
//   （toolbar+axis+.lanes 容器）首绘一次；blocks/segs 签名不变时 update 只改 nowline
//   内联 left/display 与 toolbar 文案/disabled（compare-first 零写），绝不重建 .lane 行。
// esc/setHTML 探测 M01 utils.js（同 M03-M14 并行落地模式），未落地本地兜底。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD_TITLE, DAY0_MIN, DAY1_MIN, AXIS_TICKS, SEG_CLASSES, DOT_STATUSES,
  PAUSE_LABEL, RESUME_LABEL, SPEED_PREFIX, DEFAULT_SIM_STATE,
  esc, setHTML, parseHM, clampToDay, pctStr, nowPctStr,
  normalizeBlocks, normalizeSegs, normalizeSpeed, normalizeSimState, normalizeNow, segsFor,
  statusDotHTML, nowlineHTML, segHTML, winHTML, laneHTML, lanesHTML, axisHTML,
  toolbarHTML, boardHTML, BOARD_CSS, ensureStyles, mount,
} from '../../../../web/agentic/ui/board.js';

// 黄金场景（prototype L249-253 blocks 前三 + L509 seg 形状同源；spec board.spec.ts 同款）
const BLOCKS = [
  { id: 'r', start: '14:00', end: '15:00', title: 'AI 教育的深度研究', status: 'live' },
  { id: 'c', start: '15:00', end: '17:00', title: '课程设计', status: '' },
];
const SEGS = [
  { b: 'r', s: '13:30', e: '14:05', c: 'r', text: '检索 ×3' },
  { b: 'r', s: '14:05', e: '14:40', c: 'w', text: '写作 第 1–5 节' },
  { b: 'c', s: '15:00', e: '15:25', c: 'g', text: '规划 4 课时' },
];

// ---------- A. 常量（prototype 原文） ----------

test('M15 常量：标题/暂停-继续文案/速度前缀/默认 simState/时间窗 780-1140/七刻度/六色类/五状态点', () => {
  assert.equal(BOARD_TITLE, '交付台'); // L224
  assert.equal(PAUSE_LABEL, '全部暂停'); // L227
  assert.equal(RESUME_LABEL, '继续'); // L529 paused 分支
  assert.equal(SPEED_PREFIX, '速度 ×'); // L226/L639
  assert.equal(DEFAULT_SIM_STATE, '签约后开始执行'); // L225 原文
  assert.equal(DAY0_MIN, 13 * 60); // L246 DAY0 = T('13:00') = 780
  assert.equal(DAY1_MIN, 19 * 60); // L246 DAY1 = T('19:00') = 1140
  assert.deepEqual(AXIS_TICKS, ['13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00']); // L229
  assert.deepEqual(SEG_CLASSES, ['r', 'w', 'v', 'u', 'd', 'g']); // L113 色类原文序
  assert.deepEqual(DOT_STATUSES, ['prep', 'live', 'need', 'ready', 'done']); // L59-63
});

// ---------- B. 纯核：时间与定位（prototype L244-247/L511） ----------

test('M15 parseHM：HH:MM → 当日分钟；非法 NaN（与 storyboard 同规则）', () => {
  assert.equal(parseHM('13:30'), 810);
  assert.equal(parseHM('19:00'), 1140);
  assert.equal(parseHM('0:00'), 0);
  for (const bad of ['24:00', '13:60', '1330', '', null, undefined, 810]) {
    assert.ok(Number.isNaN(parseHM(bad)), `必须 NaN：${String(bad)}`);
  }
});

test('M15 pctStr：窗口百分比 toFixed(2) 串（prototype L247 pct 原文语义）', () => {
  assert.equal(pctStr(780), '0.00%');
  assert.equal(pctStr(810), '8.33%'); // 30/360
  assert.equal(pctStr(840), '16.67%'); // 60/360
  assert.equal(pctStr(845), '18.06%'); // 65/360
  assert.equal(pctStr(900), '33.33%');
  assert.equal(pctStr(1140), '100.00%');
});

test('M15 clampToDay/nowPctStr：now 夹进 [780,1140] 再取百分比（prototype L511 min/max 夹紧）', () => {
  assert.equal(clampToDay(700), 780);
  assert.equal(clampToDay(840), 840);
  assert.equal(clampToDay(1200), 1140);
  assert.equal(nowPctStr(840), '16.67%');
  assert.equal(nowPctStr(700), '0.00%', '窗前夹到 13:00');
  assert.equal(nowPctStr(1200), '100.00%', '窗后夹到 19:00');
  assert.equal(nowPctStr(NaN), '0.00%', '非法 now 归窗起点，不炸');
});

// ---------- C. 纯核：归一 ----------

test('M15 normalizeBlocks：{id,start,end,title,status?} 四必填（start/end 合法 HH:MM）+ status 白名单；无效项剔除', () => {
  assert.deepEqual(normalizeBlocks(BLOCKS), BLOCKS);
  assert.deepEqual(
    normalizeBlocks([{ id: ' r ', start: '14:00', end: '15:00', title: ' 研究 ', status: 'live' }]),
    [{ id: 'r', start: '14:00', end: '15:00', title: '研究', status: 'live' }],
    'trim',
  );
  assert.deepEqual(normalizeBlocks([BLOCKS[0], null, { id: 'x' }, { title: '无 id' }, 7, 'b']), [BLOCKS[0]], '无效剔除');
  assert.deepEqual(
    normalizeBlocks([{ ...BLOCKS[0], start: '14:0' }, { ...BLOCKS[0], end: '25:00' }, { ...BLOCKS[0], start: '' }]),
    [],
    '时间窗非法剔除',
  );
  assert.deepEqual(normalizeBlocks([]), []);
  assert.deepEqual(normalizeBlocks(undefined), []);
  assert.deepEqual(normalizeBlocks(null), []);
});

test('M15 normalizeBlocks：status 非白名单/非字符串归空串（保留块，不渲染状态点）', () => {
  assert.equal(normalizeBlocks([{ ...BLOCKS[0], status: 'weird' }])[0].status, '');
  assert.equal(normalizeBlocks([{ ...BLOCKS[0], status: 7 }])[0].status, '');
  assert.equal(normalizeBlocks([{ ...BLOCKS[0] }])[0].status, '', '缺省空串');
  assert.equal(normalizeBlocks([{ ...BLOCKS[0], status: ' prep ' }])[0].status, 'prep');
});

test('M15 normalizeSegs：{b,s,e,c,text} c 白名单 r/w/v/u/d/g、e>s；无效剔除；text 缺省空串', () => {
  assert.deepEqual(normalizeSegs(SEGS), SEGS);
  assert.deepEqual(
    normalizeSegs([{ b: ' r ', s: ' 13:30 ', e: ' 14:05 ', c: 'r', text: ' 检索 ' }]),
    [{ b: 'r', s: '13:30', e: '14:05', c: 'r', text: '检索' }],
    'trim',
  );
  assert.deepEqual(normalizeSegs([{ ...SEGS[0] }]).length, 1);
  assert.equal(normalizeSegs([{ b: 'r', s: '13:30', e: '14:05', c: 'r' }])[0].text, '', 'text 缺省空串');
  const dropped = [
    { ...SEGS[0], b: '' }, { ...SEGS[0], c: 'x' }, { ...SEGS[0], c: 'R' },
    { ...SEGS[0], s: '13:3' }, { ...SEGS[0], e: '垃圾' },
    { ...SEGS[0], e: '13:30' }, { ...SEGS[0], s: '14:05', e: '13:30' },
    null, 'seg', 42,
  ];
  assert.deepEqual(normalizeSegs(dropped), [], '九种无效形态全剔');
  assert.deepEqual(normalizeSegs(undefined), []);
  assert.deepEqual(normalizeSegs('segs'), []);
});

test('M15 normalizeSpeed/normalizeSimState/normalizeNow：speed 正数（缺省 1）/文案 trim 兜底/now 数字或 HH:MM', () => {
  assert.equal(normalizeSpeed(4), 4);
  assert.equal(normalizeSpeed('4'), 4);
  assert.equal(normalizeSpeed(1), 1);
  assert.equal(normalizeSpeed(0), 1, '非正归 1');
  assert.equal(normalizeSpeed(-2), 1);
  assert.equal(normalizeSpeed('x'), 1);
  assert.equal(normalizeSpeed(undefined), 1, '缺省 ×1（prototype L226）');
  assert.equal(normalizeSimState('执行中（模拟时钟）'), '执行中（模拟时钟）');
  assert.equal(normalizeSimState('  已暂停 '), '已暂停');
  assert.equal(normalizeSimState(''), DEFAULT_SIM_STATE);
  assert.equal(normalizeSimState(42), DEFAULT_SIM_STATE);
  assert.equal(normalizeSimState(undefined), DEFAULT_SIM_STATE);
  assert.equal(normalizeNow(840), 840);
  assert.equal(normalizeNow('14:00'), 840, 'HH:MM 串也收');
  assert.ok(Number.isNaN(normalizeNow('xx:yy')));
  assert.ok(Number.isNaN(normalizeNow(undefined)));
  assert.ok(Number.isNaN(normalizeNow(null)));
});

test('M15 segsFor：按块 id 过滤保序（prototype L509 feed.filter(f.b===b.id)）', () => {
  assert.equal(segsFor(SEGS, 'r').length, 2);
  assert.equal(segsFor(SEGS, 'c').length, 1);
  assert.equal(segsFor(SEGS, 'c')[0].text, '规划 4 课时');
  assert.deepEqual(segsFor(SEGS, 'zz'), []);
  assert.deepEqual(segsFor(undefined, 'r'), []);
});

// ---------- D. 纯核：结构 HTML（prototype L507-513/L222-231 原文结构） ----------

test('M15 segHTML：left/width=calc 百分比 toFixed(2) + title 提示 + 文本（prototype L509 原文）', () => {
  assert.equal(
    segHTML(SEGS[0]),
    '<div class="seg r" style="left:8.33%;width:calc(18.06% - 8.33%)" title="检索 ×3">检索 ×3</div>',
  );
  assert.equal(
    segHTML({ b: 'c', s: '15:00', e: '15:25', c: 'g', text: '规划 4 课时' }),
    '<div class="seg g" style="left:33.33%;width:calc(40.28% - 33.33%)" title="规划 4 课时">规划 4 课时</div>',
  );
  assert.equal(segHTML(null), '');
  assert.equal(segHTML({ b: 'r', s: '垃圾', e: '14:00', c: 'r', text: 'x' }), '', '无效 seg 归空');
});

test('M15 segHTML 转义：text 五路 esc（title 属性 + 文本体，M01 XSS 基线）', () => {
  const html = segHTML({ b: 'r', s: '13:30', e: '14:00', c: 'w', text: '<img src=x onerror=1>"&\'' });
  assert.ok(!html.includes('<img '), 'img 破坏');
  assert.ok(html.includes('title="&lt;img src=x onerror=1&gt;&quot;&amp;&#39;"'), 'title 属性转义');
  assert.ok(html.includes('>&lt;img src=x onerror=1&gt;&quot;&amp;&#39;</div>'), '文本体转义');
});

test('M15 winHTML：块时间窗虚线框 left/width=窗百分比夹 [780,1140]（prototype L510 原文）', () => {
  assert.equal(
    winHTML(BLOCKS[0]),
    '<div class="win" aria-hidden="true" style="left:16.67%;width:calc(33.33% - 16.67%)"></div>',
  );
  assert.equal(
    winHTML({ id: 'x', start: '12:00', end: '14:00', title: 't', status: '' }),
    '<div class="win" aria-hidden="true" style="left:0.00%;width:calc(16.67% - 0.00%)"></div>',
    '窗前块夹到 13:00',
  );
  assert.equal(
    winHTML({ id: 'x', start: '18:00', end: '20:00', title: 't', status: '' }),
    '<div class="win" aria-hidden="true" style="left:83.33%;width:calc(100.00% - 83.33%)"></div>',
    '窗后块夹到 19:00',
  );
  assert.equal(winHTML({ id: 'x', start: '19:00', end: '21:00', title: 't', status: '' }), '', '起点 ≥ DAY1 不画（prototype L511 三元）');
  assert.equal(winHTML({ id: 'x', start: '22:00', end: '23:00', title: 't', status: '' }), '');
  assert.equal(winHTML({ id: 'x', start: '14:00', end: '14:00', title: 't', status: '' }), '', '退化窗口不画');
  assert.equal(winHTML(null), '');
});

test('M15 statusDotHTML：五状态点原样；空/非白名单不出点（prototype L339-341）', () => {
  assert.equal(statusDotHTML('live'), '<span class="dot live" aria-hidden="true"></span>');
  assert.equal(statusDotHTML('prep'), '<span class="dot prep" aria-hidden="true"></span>');
  assert.equal(statusDotHTML('need'), '<span class="dot need" aria-hidden="true"></span>');
  assert.equal(statusDotHTML('ready'), '<span class="dot ready" aria-hidden="true"></span>');
  assert.equal(statusDotHTML('done'), '<span class="dot done" aria-hidden="true"></span>');
  assert.equal(statusDotHTML(''), '');
  assert.equal(statusDotHTML('weird'), '');
  assert.equal(statusDotHTML(undefined), '');
});

test('M15 nowlineHTML：left=nowPctStr；不显示时 display:none 内联（prototype L511/L114）', () => {
  assert.equal(nowlineHTML(840, true), '<div class="nowline" aria-hidden="true" style="left:16.67%"></div>');
  assert.equal(nowlineHTML(840, false), '<div class="nowline" aria-hidden="true" style="left:16.67%;display:none"></div>');
  assert.equal(nowlineHTML(900, true), '<div class="nowline" aria-hidden="true" style="left:33.33%"></div>');
});

test('M15 laneHTML：.lane[data-lane] + .name(状态点+标题) + .track(win+segs+nowline)（prototype L511）', () => {
  const html = laneHTML(BLOCKS[0], SEGS, 840, true);
  assert.ok(html.startsWith('<div class="lane" data-lane="r"><span class="name"><span class="dot live" aria-hidden="true"></span>AI 教育的深度研究</span><div class="track">'), 'lane 开头（name=dot+标题）');
  assert.ok(html.includes(winHTML(BLOCKS[0])), '时间窗虚线框');
  assert.ok(html.includes(segHTML(SEGS[0])) && html.includes(segHTML(SEGS[1])), '本块 segs');
  assert.ok(!html.includes('规划 4 课时'), '他块 seg 不混入');
  assert.ok(html.endsWith(nowlineHTML(840, true) + '</div></div>'), 'track 末位 nowline');
  const plain = laneHTML(BLOCKS[1], SEGS, 840, false);
  assert.ok(plain.startsWith('<div class="lane" data-lane="c"><span class="name">课程设计</span>'), '无状态点不出 dot');
  assert.ok(plain.includes(segHTML(SEGS[2])));
  assert.ok(plain.includes('display:none'), 'nowline 隐藏');
  const noSegs = laneHTML({ id: 'f', start: '19:00', end: '21:00', title: '和小王吃饭', status: '' }, SEGS, 840, true);
  assert.ok(!noSegs.includes('class="win"'), '窗后块无虚线框');
  assert.equal(laneHTML(null, SEGS, 840, true), '');
});

test('M15 laneHTML 转义：data-lane/title 入属性与文本必经 esc', () => {
  const html = laneHTML({ id: '"><script>alert(1)</script>', start: '14:00', end: '15:00', title: '<em>块</em>', status: '' }, [], 840, true);
  assert.ok(!html.includes('"><script>'), 'data-lane 属性注入破坏');
  assert.ok(!html.includes('<em>块</em>') && html.includes('&lt;em&gt;块&lt;/em&gt;'), '标题转义');
});

test('M15 lanesHTML：每块一行保序；nowline 每轨一条（prototype L508-512）', () => {
  const html = lanesHTML(BLOCKS, SEGS, 840, true);
  assert.equal((html.match(/<div class="lane" data-lane="/g) || []).length, 2);
  assert.equal((html.match(/class="nowline"/g) || []).length, 2, '每轨一条 nowline');
  assert.ok(html.indexOf('data-lane="r"') < html.indexOf('data-lane="c"'), '给定序');
  assert.equal(lanesHTML([], SEGS, 840, true), '');
});

test('M15 axisHTML：七刻度原文（prototype L229）', () => {
  assert.equal(
    axisHTML(),
    '<div class="axis"><div></div><div><span>13:00</span><span>14:00</span><span>15:00</span><span>16:00</span><span>17:00</span><span>18:00</span><span>19:00</span></div></div>',
  );
});

test('M15 toolbarHTML：h2+spacer+simState+速度+全部暂停（未运行 disabled，prototype L223-228 原文序）', () => {
  assert.equal(
    toolbarHTML({}),
    '<div class="toolbar"><h2>交付台</h2><span class="spacer"></span>'
    + '<span class="small muted simState" data-sim-state>签约后开始执行</span>'
    + '<button class="btn" type="button" data-board-speed>速度 ×1</button>'
    + '<button class="btn danger" type="button" data-board-pause disabled>全部暂停</button></div>',
  );
  assert.equal(
    toolbarHTML({ running: true, paused: true, speed: 4, simState: '执行中（模拟时钟）' }),
    '<div class="toolbar"><h2>交付台</h2><span class="spacer"></span>'
    + '<span class="small muted simState" data-sim-state>执行中（模拟时钟）</span>'
    + '<button class="btn" type="button" data-board-speed>速度 ×4</button>'
    + '<button class="btn danger" type="button" data-board-pause>继续</button></div>',
    '运行中可点、暂停态文案「继续」（L528-529）',
  );
  assert.ok(toolbarHTML({ simState: '<script>x</script>' }).includes('&lt;script&gt;x&lt;/script&gt;'), 'simState 转义');
});

test('M15 boardHTML：toolbar → axis → lanes 三段序（prototype L222-231 卡结构）', () => {
  const html = boardHTML({ blocks: BLOCKS, segs: SEGS, now: 840, running: true });
  const iToolbar = html.indexOf('<div class="toolbar">');
  const iAxis = html.indexOf('<div class="axis">');
  const iLanes = html.indexOf('<div class="lanes">');
  assert.ok(iToolbar >= 0 && iAxis > iToolbar && iLanes > iAxis, '三段齐且有序');
  assert.ok(html.includes('data-lane="r"'));
});

// ---------- E. 纯核：CSS（prototype L107-116/L58-64 原文 + a11y + 移动降级） ----------

test('M15 BOARD_CSS：泳道 120px+1fr/track 34px 溢出隐藏/六色类/nowline you 色 2px/axis 刻度', () => {
  assert.ok(/\.lane\s*{[^}]*grid-template-columns:120px 1fr/.test(BOARD_CSS), 'L109 泳道两栏');
  assert.ok(/\.lane \.track\s*{[^}]*height:34px[^}]*overflow:hidden/.test(BOARD_CSS), 'L111 track');
  assert.ok(/\.seg\s*{[^}]*position:absolute[^}]*white-space:nowrap/.test(BOARD_CSS), 'L112 seg');
  assert.ok(/\.seg\.r\s*{[^}]*background:var\(--k-explore,#4D7699\)/.test(BOARD_CSS), 'L113 r');
  assert.ok(/\.seg\.w\s*{[^}]*background:var\(--k-create,#B07A36\)/.test(BOARD_CSS));
  assert.ok(/\.seg\.v\s*{[^}]*background:var\(--k-restore,#4F8570\)/.test(BOARD_CSS));
  assert.ok(/\.seg\.u\s*{[^}]*background:var\(--you,#E95432\)/.test(BOARD_CSS));
  assert.ok(/\.seg\.d\s*{[^}]*background:var\(--deep,#2E4636\)/.test(BOARD_CSS));
  assert.ok(/\.seg\.g\s*{[^}]*background:var\(--k-connect,#B05A4D\)/.test(BOARD_CSS));
  assert.ok(/\.nowline\s*{[^}]*width:2px[^}]*background:var\(--you,#E95432\)/.test(BOARD_CSS), 'L114 当前时刻竖线');
  assert.ok(/\.axis\s*{[^}]*grid-template-columns:120px 1fr/.test(BOARD_CSS), 'L115');
  assert.ok(/\.axis div:last-child\s*{[^}]*justify-content:space-between/.test(BOARD_CSS), 'L116 刻度两端对齐');
});

test('M15 BOARD_CSS：时间窗虚线框 border-left dashed + toolbar + danger/disabled + 五状态点 pulse 动画', () => {
  assert.ok(/\.win\s*{[^}]*border-left:\s*1px dashed[^}]*border-right:\s*1px dashed/.test(BOARD_CSS), 'L510 虚线框');
  assert.ok(/\.toolbar\s*{[^}]*display:flex[^}]*flex-wrap:wrap/.test(BOARD_CSS), 'L133');
  assert.ok(/\.btn\.danger\s*{[^}]*color:var\(--bad,#A53B25\)/.test(BOARD_CSS), 'L35');
  assert.ok(/\.btn\[disabled\]\s*{[^}]*opacity:\.5/.test(BOARD_CSS), 'L36');
  assert.ok(/\.dot\.live\s*{[^}]*animation:[^}]*\.8s/.test(BOARD_CSS), 'L60 live pulse .8s');
  assert.ok(/\.dot\.need\s*{[^}]*animation:[^}]*\.6s/.test(BOARD_CSS), 'L61');
  assert.ok(/\.dot\.ready\s*{[^}]*background:var\(--ok,#3F7A55\)/.test(BOARD_CSS), 'L62');
  assert.ok(/@keyframes agentic-board-pulse/.test(BOARD_CSS), 'pulse 关键帧');
});

test('M15 BOARD_CSS：≤560 纵向时间线降级单列 + focus-visible + reduced-motion（PRD §5.8/W5.3 硬性）', () => {
  assert.ok(/@media \(max-width:560px\)[\s\S]*?\.lane\s*{[^}]*grid-template-columns:1fr/.test(BOARD_CSS), '泳道单列');
  assert.ok(/@media \(max-width:560px\)[\s\S]*?\.axis\s*{[^}]*grid-template-columns:1fr/.test(BOARD_CSS), '刻度行单列');
  assert.ok(/focus-visible\s*{[^}]*outline:2px solid var\(--you,#E95432\)/.test(BOARD_CSS), '焦点可见');
  assert.ok(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation:\s*none/.test(BOARD_CSS), 'rm 禁动画（DAG M15）');
});

test('M15 ensureStyles：幂等注入 + 无 DOM 环境安全（M06-M14 同款桩）', () => {
  const mkDoc = (tag) => {
    const doc = { _styles: [] };
    doc.querySelector = (sel) => (sel === `style[${tag}]` ? doc._styles[0] ?? null : null);
    doc.createElement = () => ({ _attrs: {}, textContent: '', setAttribute(k, v) { this._attrs[k] = String(v); } });
    doc.head = { appendChild: (n) => doc._styles.push(n) };
    return doc;
  };
  const doc = mkDoc('data-agentic-board');
  assert.equal(ensureStyles(doc), true);
  assert.equal(doc._styles.length, 1);
  assert.ok(doc._styles[0].textContent.includes('.lane'));
  assert.equal(ensureStyles(doc), false, '已注入不再重复');
  assert.equal(ensureStyles(null), false);
});

// ---------- F. 壳：mount / update（fake-DOM 桩，白盒同 M10-M14 模式） ----------

/** classList 桩 */
function mkClassList(initial = '') {
  const set = new Set(initial.split(/\s+/).filter(Boolean));
  return {
    add: (...cs) => cs.forEach((c) => set.add(c)),
    remove: (...cs) => cs.forEach((c) => set.delete(c)),
    toggle(c, force) { const on = force === undefined ? !set.has(c) : !!force; if (on) set.add(c); else set.delete(c); return on; },
    contains: (c) => set.has(c),
    _join: () => [...set].join(' '),
  };
}

const UNESC = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const unesc = (s) => String(s).replace(/&(amp|lt|gt|quot|#39);/g, (m) => UNESC[m]);

const styleOf = (attr) => {
  const st = {};
  for (const part of (attr || '').split(';')) {
    const i = part.indexOf(':');
    if (i > 0) st[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return st;
};

/** track 子节点桩：seg/win/nowline（className/style(解析内联)/title/textContent） */
function parseTrackChildren(html) {
  const out = [];
  const re = /<div class="(seg [a-z]+|win|nowline)"([^>]*)>([^<]*)<\/div>/g;
  let m;
  while ((m = re.exec(html))) {
    const cls = m[1];
    const attrs = m[2] || '';
    out.push({
      kind: cls === 'win' ? 'win' : cls === 'nowline' ? 'nowline' : 'seg',
      className: cls,
      classList: mkClassList(cls),
      style: styleOf(/style="([^"]*)"/.exec(attrs)?.[1]),
      title: unesc(/title="([^"]*)"/.exec(attrs)?.[1] ?? ''),
      dataset: {},
      _t: unesc(m[3] || ''),
      get textContent() { return this._t; },
      set textContent(v) { this._t = String(v); },
    });
  }
  return out;
}

/** lane 行桩 */
function mkLane(id, inner) {
  const tIdx = inner.indexOf('<div class="track">');
  const nameHTML = inner.slice(0, tIdx);
  const trackInner = inner.slice(tIdx + '<div class="track">'.length).replace(/<\/div>$/, '');
  const track = {
    className: 'track',
    children: parseTrackChildren(trackInner),
    querySelector(sel) { return this.children.find((c) => `.${c.kind}` === sel || c.className === sel) ?? null; },
    querySelectorAll(sel) { return this.children.filter((c) => `.${c.kind}` === sel || c.className === sel); },
  };
  return {
    className: 'lane',
    dataset: { lane: id },
    nameHTML: unesc(nameHTML),
    track,
    querySelector(sel) { return sel === '.track' ? track : null; },
  };
}

/** lanes 容器桩：innerHTML 写即重解析行 */
function mkLanes(html) {
  const lanes = {
    _v: html, writes: 0, rows: [],
    get innerHTML() { return this._v; },
    set innerHTML(v) { this.writes += 1; this._v = v; this.rows = parseLanes(v); },
    querySelectorAll(sel) {
      if (sel === '.lane') return this.rows.slice();
      if (sel === '.nowline') return this.rows.flatMap((r) => r.track.children.filter((c) => c.kind === 'nowline'));
      return [];
    },
  };
  lanes.rows = parseLanes(html);
  return lanes;
}

function parseLanes(html) {
  const rows = [];
  const open = /<div class="lane" data-lane="([^"]*)">/g;
  let m;
  while ((m = open.exec(html))) {
    const tag = /<div\b|<\/div>/g;
    tag.lastIndex = open.lastIndex;
    let depth = 1; let end = html.length; let t;
    while ((t = tag.exec(html))) {
      if (t[0] === '</div>') { depth -= 1; if (depth === 0) { end = t.index; break; } } else depth += 1;
    }
    rows.push(mkLane(unesc(m[1]), html.slice(open.lastIndex, end)));
    open.lastIndex = end + '</div>'.length;
  }
  return rows;
}

function mkText(v) {
  return { writes: 0, _t: String(v), get textContent() { return this._t; }, set textContent(v) { this.writes += 1; this._t = String(v); } };
}

/** 宿主桩：innerHTML 写即模拟浏览器重解析（toolbar 三件 + .lanes 重建） */
function stubBoardHost() {
  const doc = {
    _styles: [],
    querySelector(sel) { return sel === 'style[data-agentic-board]' ? this._styles[0] ?? null : null; },
    createElement: () => ({ _attrs: {}, textContent: '', setAttribute(k, v) { this._attrs[k] = String(v); } }),
    head: { appendChild: (n) => doc._styles.push(n) },
  };
  const build = (html) => {
    const simM = /<span class="small muted simState"[^>]*>([^<]*)<\/span>/.exec(html);
    const speedM = /<button class="btn" type="button" data-board-speed>([^<]*)<\/button>/.exec(html);
    const pauseM = /<button class="btn danger" type="button" data-board-pause( disabled)?>([^<]*)<\/button>/.exec(html);
    const lanesM = /<div class="lanes">([\s\S]*)<\/div>\s*$/.exec(html);
    return {
      simNode: mkText(unesc(simM?.[2] ?? simM?.[1] ?? '')),
      speedBtn: mkText(unesc(speedM?.[1] ?? '')),
      pauseBtn: { ...mkText(unesc(pauseM?.[2] ?? '')), disabled: !!pauseM?.[1] },
      lanes: mkLanes(lanesM?.[1] ?? ''),
    };
  };
  let dom = build('');
  const host = {
    _h: undefined, _v: '', writes: 0, listeners: {}, ownerDocument: doc,
    classList: mkClassList(''),
    get innerHTML() { return this._v; },
    set innerHTML(v) { this.writes += 1; this._v = v; dom = build(v); },
    querySelector(sel) {
      if (sel === '.lanes') return dom.lanes;
      if (sel === '[data-sim-state]') return dom.simNode;
      if (sel === '[data-board-speed]') return dom.speedBtn;
      if (sel === '[data-board-pause]') return dom.pauseBtn;
      return null;
    },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
  };
  return { host, get dom() { return dom; } };
}

/** 模拟点击：target.closest 按选择器回查（事件委托路径） */
function clickOn(host, closestSel, stub) {
  const ev = { target: { closest: (sel) => (sel === closestSel ? stub : null) } };
  (host.listeners.click ?? []).forEach((fn) => fn(ev));
}

test('M15 mount：壳（toolbar+axis+lanes）首绘一次；泳道/刻度/nowline 就位', () => {
  const s = stubBoardHost();
  const handle = mount(s.host, { blocks: BLOCKS, segs: SEGS, now: 840, running: true, simState: '执行中（模拟时钟）' });
  assert.equal(s.host.writes, 1, '壳一次（增量基石）');
  assert.ok(s.host.classList.contains('board'), '宿主补 .board 类（prototype L222 卡）');
  assert.equal(s.dom.simNode.textContent, '执行中（模拟时钟）');
  assert.equal(s.dom.speedBtn.textContent, '速度 ×1');
  assert.equal(s.dom.pauseBtn.textContent, '全部暂停');
  assert.equal(s.dom.pauseBtn.disabled, false, '运行中可点（L528）');
  assert.equal(s.dom.lanes.rows.length, 2);
  assert.ok(s.host.innerHTML.includes(axisHTML()), '刻度 13:00–19:00');
  const nl = s.dom.lanes.querySelectorAll('.nowline')[0];
  assert.equal(nl.style.left, '16.67%', 'nowline=now 百分比（L511）');
  assert.notEqual(nl.style.display, 'none', 'running → 显示');
  assert.equal(handle.el, s.host);
  assert.equal(typeof handle.update, 'function');
});

test('M15 mount：未 running 未 signed → nowline 内联 display:none（仍占节点身份）', () => {
  const s = stubBoardHost();
  mount(s.host, { blocks: BLOCKS, segs: SEGS, now: 840, running: false });
  const nl = s.dom.lanes.querySelectorAll('.nowline')[0];
  assert.equal(nl.style.display, 'none');
  assert.equal(s.dom.pauseBtn.disabled, true, '未运行禁用（L528）');
});

test('M15 mount：signed（未 running）也显示 nowline（prototype L511 running||signed）', () => {
  const s = stubBoardHost();
  mount(s.host, { blocks: BLOCKS, segs: SEGS, now: 840, running: false, signed: true });
  assert.notEqual(s.dom.lanes.querySelectorAll('.nowline')[0].style.display, 'none');
});

test('M15 增量：update 只挪 nowline 内联 left——节点身份不重建、壳与 lanes 零写（DAG M15 硬约束）', () => {
  const s = stubBoardHost();
  const handle = mount(s.host, { blocks: BLOCKS, segs: SEGS, now: 840, running: true });
  const nl = s.dom.lanes.querySelectorAll('.nowline')[0];
  const segNode = s.dom.lanes.rows[0].track.children.find((c) => c.kind === 'seg');
  nl.marker = 'keep-nl'; segNode.marker = 'keep-seg';
  handle.update({ now: 900 });
  assert.equal(s.host.writes, 1, '壳未重写');
  assert.equal(s.dom.lanes.writes, 0, 'lanes 容器未重写');
  const nl2 = s.dom.lanes.querySelectorAll('.nowline')[0];
  assert.equal(nl2, nl, 'nowline 同一节点');
  assert.equal(s.dom.lanes.rows[0].track.children.find((c) => c.kind === 'seg'), segNode, 'seg 同一节点');
  assert.equal(nl.marker, 'keep-nl');
  assert.equal(segNode.marker, 'keep-seg');
  assert.equal(nl.style.left, '33.33%');
});

test('M15 性能基线：50 块 × 60 次 update(now) → 壳/lanes 各仍只首绘一次（PRD §5.8 50 块 60fps）', () => {
  const s = stubBoardHost();
  const blocks50 = Array.from({ length: 50 }, (_, i) => ({ id: `b${i}`, start: '13:30', end: '18:00', title: `块 ${i}` }));
  const handle = mount(s.host, { blocks: blocks50, segs: SEGS, now: 800, running: true });
  assert.equal(s.dom.lanes.rows.length, 50);
  const lanesWrites = s.dom.lanes.writes;
  const nl0 = s.dom.lanes.querySelectorAll('.nowline')[0];
  for (let i = 0; i < 60; i += 1) handle.update({ now: 800 + i });
  assert.equal(s.host.writes, 1);
  assert.equal(s.dom.lanes.writes, lanesWrites, '零重建');
  assert.notEqual(s.dom.lanes.querySelectorAll('.nowline')[0], undefined);
  assert.equal(s.dom.lanes.querySelectorAll('.nowline')[0], nl0, 'nowline 节点恒定');
});

test('M15 增量：running/signed 切换只改 nowline display（同节点）', () => {
  const s = stubBoardHost();
  const handle = mount(s.host, { blocks: BLOCKS, segs: SEGS, now: 840, running: true });
  const nl = s.dom.lanes.querySelectorAll('.nowline')[0];
  handle.update({ running: false });
  assert.equal(nl.style.display, 'none');
  handle.update({ signed: true });
  assert.equal(nl.style.display, '', 'signed 恢复显示');
  handle.update({ signed: false });
  assert.equal(nl.style.display, 'none');
  assert.equal(s.dom.lanes.writes, 0);
});

test('M15 增量：toolbar 状态切文案/disabled（compare-first 零写）', () => {
  const s = stubBoardHost();
  const handle = mount(s.host, { blocks: BLOCKS, segs: SEGS, now: 840, running: false });
  assert.equal(s.dom.pauseBtn.disabled, true);
  handle.update({ running: true });
  assert.equal(s.dom.pauseBtn.disabled, false);
  handle.update({ paused: true });
  assert.equal(s.dom.pauseBtn.textContent, '继续', 'L529 暂停态文案');
  handle.update({ speed: 4 });
  assert.equal(s.dom.speedBtn.textContent, '速度 ×4', 'L639 速度 ×4');
  handle.update({ simState: '已暂停 · 恢复时会重新校验合同与资源' });
  assert.equal(s.dom.simNode.textContent, '已暂停 · 恢复时会重新校验合同与资源');
  const simW = s.dom.simNode.writes; const speedW = s.dom.speedBtn.writes; const pauseW = s.dom.pauseBtn.writes;
  handle.update({}); // 同状态零写
  assert.equal(s.dom.simNode.writes, simW);
  assert.equal(s.dom.speedBtn.writes, speedW);
  assert.equal(s.dom.pauseBtn.writes, pauseW);
  assert.equal(s.host.writes, 1, '壳不重写');
});

test('M15 增量：segs 变化 → 只重建 .lanes 容器一次（壳/toolbar 节点不动）', () => {
  const s = stubBoardHost();
  const handle = mount(s.host, { blocks: BLOCKS, segs: SEGS, now: 840, running: true });
  const simBefore = s.dom.simNode;
  handle.update({ segs: [...SEGS, { b: 'c', s: '15:46', e: '16:35', c: 'w', text: '活动卡 ×4' }] });
  assert.equal(s.host.writes, 1, '壳零写');
  assert.equal(s.dom.lanes.writes, 1, 'lanes 重建一次');
  assert.equal(s.dom.simNode, simBefore, 'toolbar 节点身份不变');
  const cSegs = s.dom.lanes.rows[1].track.children.filter((c) => c.kind === 'seg');
  assert.equal(cSegs.length, 2);
  assert.equal(cSegs[1].textContent, '活动卡 ×4');
  const nl = s.dom.lanes.querySelectorAll('.nowline')[0];
  assert.equal(nl.style.left, '16.67%', '重建后 nowline 位置就位');
});

test('M15 增量：blocks 变化（增/删）→ 重建 lanes 反映新行数', () => {
  const s = stubBoardHost();
  const handle = mount(s.host, { blocks: BLOCKS, segs: SEGS, now: 840, running: true });
  handle.update({ blocks: [BLOCKS[0]] });
  assert.equal(s.dom.lanes.rows.length, 1);
  assert.equal(s.dom.lanes.rows[0].dataset.lane, 'r');
  handle.update({ blocks: [...BLOCKS, { id: 'f', start: '19:00', end: '21:00', title: '和小王吃饭' }] });
  assert.equal(s.dom.lanes.rows.length, 3);
  assert.equal(s.dom.lanes.querySelectorAll('.nowline').length, 3);
});

test('M15 增量：blocks 内容变化（标题改）也触发重建（签名含内容）', () => {
  const s = stubBoardHost();
  const handle = mount(s.host, { blocks: BLOCKS, segs: SEGS, now: 840, running: true });
  handle.update({ blocks: [{ ...BLOCKS[0], title: 'AI 教育研究（v2）' }, BLOCKS[1]] });
  assert.equal(s.dom.lanes.writes, 1);
  assert.ok(s.dom.lanes.rows[0].nameHTML.includes('AI 教育研究（v2）'));
});

test('M15 点击委托：暂停 → onPauseAll、速度 → onSpeed（prototype L638-639）', () => {
  const s = stubBoardHost();
  const calls = [];
  mount(s.host, {
    blocks: BLOCKS, segs: SEGS, now: 840, running: true,
    onPauseAll: () => calls.push(['pauseAll']), onSpeed: () => calls.push(['speed']),
  });
  clickOn(s.host, '[data-board-pause]', {});
  clickOn(s.host, '[data-board-speed]', {});
  assert.deepEqual(calls, [['pauseAll'], ['speed']]);
  clickOn(s.host, 'button.other', {}); // 非匹配
  assert.deepEqual(calls, [['pauseAll'], ['speed']]);
});

test('M15 点击护栏：无 closest 的 target / 空事件不炸不触发', () => {
  const s = stubBoardHost();
  const calls = [];
  mount(s.host, { blocks: BLOCKS, segs: SEGS, now: 840, running: true, onPauseAll: () => calls.push(1), onSpeed: () => calls.push(2) });
  (s.host.listeners.click ?? []).forEach((fn) => fn({ target: {} })); // 无 closest
  (s.host.listeners.click ?? []).forEach((fn) => fn(undefined)); // 空事件
  assert.deepEqual(calls, []);
});

test('M15 update 合并语义：未传键不动旧值；回调可后续替换；链式返回 handle', () => {
  const s = stubBoardHost();
  const calls1 = []; const calls2 = [];
  const handle = mount(s.host, { blocks: BLOCKS, segs: SEGS, now: 840, running: true, onPauseAll: () => calls1.push('p1') });
  handle.update(undefined); // 空补丁
  assert.equal(s.dom.lanes.writes, 0);
  clickOn(s.host, '[data-board-pause]', {});
  assert.deepEqual(calls1, ['p1']);
  const ret = handle.update({ onPauseAll: () => calls2.push('p2'), now: 900 });
  assert.equal(typeof ret.update, 'function', '链式返回');
  assert.equal(s.dom.lanes.querySelectorAll('.nowline')[0].style.left, '33.33%');
  clickOn(s.host, '[data-board-pause]', {});
  assert.deepEqual(calls1, ['p1'], '旧回调不再触发');
  assert.deepEqual(calls2, ['p2'], '新回调生效');
});

test('M15 mount 容忍：el=null / 裸宿主（无 querySelector）不抛；update 安全跳过', () => {
  const h1 = mount(null, { blocks: BLOCKS, segs: SEGS, now: 840, running: true });
  assert.equal(typeof h1.update, 'function');
  h1.update({ now: 900, segs: [] }); // 不抛
  const bare = { _h: undefined, _v: '', writes: 0, get innerHTML() { return this._v; }, set innerHTML(v) { this.writes += 1; this._v = v; } };
  const h2 = mount(bare, { blocks: BLOCKS, segs: SEGS, now: 840, running: true });
  assert.equal(bare.writes, 1, '壳仍首绘');
  h2.update({ now: 900 }); // 无 zones：安全跳过
  assert.equal(bare.writes, 1);
});

test('M15 空数据：blocks/segs 皆空 → 壳 + 空 lanes 不炸；nowline 无处渲染', () => {
  const s = stubBoardHost();
  const handle = mount(s.host, {});
  assert.equal(s.host.writes, 1);
  assert.equal(s.dom.simNode.textContent, DEFAULT_SIM_STATE, '缺省文案「签约后开始执行」');
  assert.equal(s.dom.lanes.rows.length, 0);
  handle.update({ blocks: BLOCKS, segs: SEGS, now: 840, running: true });
  assert.equal(s.dom.lanes.rows.length, 2, '后续补块渲染');
});

// ---------- G. esc/setHTML 兜底（M01 未落地时本地实现） ----------

test('M15 esc/setHTML 兜底：五实体转义 + 内容比对跳过重写（prototype L328-329）', () => {
  assert.equal(esc('<a href="x">&\''), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  const el = { _h: undefined, writes: 0, _v: '', get innerHTML() { return this._v; }, set innerHTML(v) { this.writes += 1; this._v = v; } };
  assert.equal(setHTML(el, '<b>x</b>'), true);
  assert.equal(setHTML(el, '<b>x</b>'), false, '同内容零写');
  assert.equal(el.writes, 1);
  assert.equal(setHTML(null, 'x'), false, 'null 宿主安全');
});
