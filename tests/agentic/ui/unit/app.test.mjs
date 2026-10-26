// M18 demo.html 黄金场景装配 单测（RED 先行 · 实现前必红）
// 依据：plan.md M18（组装全组件+左列表右抽屉+交付台+收件箱+预演片入口+主题切换；模拟时钟
//   剧本驱动 status/feed/needs/超时默认；阶段条 say→see→sign→run；讨论→patched 两态；签约→
//   hash→startSim；验收/要求修改闭环；全程 setHTML 增量；?speed/?theme/?block URL 参数）、
//   PRD §3.2（黄金场景表：13:10 说完→+3s 扫描→+8s 预演→讨论→签约→13:30–17:00 执行→
//   15:00/17:00 验收→接受计入时间收益）、§5.2 末（增量更新：整块重绘丢按钮/展开态/字幕）；
//   prototype.html（唯一视觉/交互标准）：
//   L258 state 初值 / L306-322 script 15 行 / L452-459 applySay / L461-469 renderBound /
//   L471-476 renderLive+cost / L479-489 renderArt / L491-504 renderTrace / L507-513 renderLanes /
//   L515-523 renderNeeds / L525-531 renderAll（clock/simState/pauseAll）/ L540-550 reelShots /
//   L582-584 startScene / L585-589 startCapture / L592-615 tick（模拟时钟+超时默认）/
//   L612-615 startSim / L617-648 事件（sign→hash+600ms startSim / revoke / speed ×1×4 /
//   data-ans / data-acc / data-rev / bell / theme）。
// 契约：web/agentic/ui/app.js 具名导出
//   APP_CSS / ensureStyles / HM / parseParams / LOCAL_FIXTURES / getData /
//   initialState / makeHash / applySay / applySign / applyRevoke / applyAnswer /
//   applyAccept / applyRevise / applySpeedToggle / applyPauseToggle / tick /
//   simStateText / clockText / pendingMap / costFor / segsFromFeed / traceFor /
//   captureCardFor / sectionsFor / blockListProps / tiersProps / sceneCardProps /
//   gallerySamples / storyboardProps / discussProps / boundariesProps / feedProps /
//   acceptanceProps / traceProps / boardProps / inboxProps / bellCount / reelShots /
//   createApp / boot。
// fixtures 探测：优先 import ./fixtures.js（M02），未落地用 LOCAL_FIXTURES 兜底
//   （与 fixtures.test.mjs 契约同形，M02 落地后自动切换，同 utils.js 并行落地模式）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as app from '../../../../web/agentic/ui/app.js';

const {
  HM, parseParams, LOCAL_FIXTURES, initialState, makeHash,
  applySay, applySign, applyRevoke, applyAnswer, applyAccept, applyRevise,
  applySpeedToggle, applyPauseToggle, tick, simStateText, clockText,
  pendingMap, costFor, segsFromFeed, traceFor, captureCardFor, sectionsFor,
  blockListProps, tiersProps, sceneCardProps, gallerySamples, storyboardProps,
  discussProps, boundariesProps, feedProps, acceptanceProps, traceProps,
  boardProps, inboxProps, bellCount, reelShots, createApp, getData,
} = app;

const T = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };

// 从初始态快进 sim 到 to（不跑剧本——cursor 越过全部行则剧本同推进；测试里用大 cursor 隔离
// 或直接改 state.sim 的副本）。tick 是纯函数：state 传入返回新 state。
const at = (simMin) => ({ ...initialState(), sim: simMin });

// ---------- A. 参数与工具（prototype ?speed/?theme/?block） ----------

test('M18 parseParams：三参数全收（?speed=4&theme=dark&block=c）', () => {
  assert.deepEqual(parseParams('?speed=4&theme=dark&block=c'), { speed: 4, theme: 'dark', block: 'c' });
});

test('M18 parseParams：空/缺省 → speed 1、theme ""（跟随系统）、block r', () => {
  assert.deepEqual(parseParams(''), { speed: 1, theme: '', block: 'r' });
  assert.deepEqual(parseParams('?'), { speed: 1, theme: '', block: 'r' });
});

test('M18 parseParams：非法值逐项兜底——speed 非正数归 1、theme 白名单外归空、block 未知归 r', () => {
  assert.equal(parseParams('?speed=x').speed, 1);
  assert.equal(parseParams('?speed=0').speed, 1);
  assert.equal(parseParams('?speed=-4').speed, 1);
  assert.equal(parseParams('?theme=blue').theme, '');
  assert.equal(parseParams('?theme=light').theme, 'light');
  assert.equal(parseParams('?block=zz').block, 'r');
  assert.equal(parseParams('?block=f').block, 'f');
});

test('M18 HM：分钟数 → HH:MM（prototype L245）', () => {
  assert.equal(HM(790), '13:10');
  assert.equal(HM(0), '00:00');
  assert.equal(HM(1140), '19:00');
});

test('M18 makeHash：6 字节 → sha256: 十六进制…（prototype L633 格式）', () => {
  assert.equal(makeHash([0, 1, 2, 10, 255, 16]), 'sha256:0001020a10ff…');
});

// ---------- B. 数据兜底（与 M02 fixtures 契约同形，落地后无缝切换） ----------

test('M18 LOCAL_FIXTURES：5 块/15 行剧本/3 个 need/SYS_WONT 原文/6 句旁白/DAY0-1140', () => {
  assert.deepEqual(LOCAL_FIXTURES.blocks.map((b) => b.id), ['r', 'c', 'f', 'b', 's']);
  assert.equal(LOCAL_FIXTURES.script.length, 15);
  assert.equal(LOCAL_FIXTURES.script.filter((s) => s.need).length, 3);
  assert.equal(LOCAL_FIXTURES.SYS_WONT, '系统禁止：付款下单 · 以你名义发送（除非逐次确认）· 读取凭据 · 删除文件');
  assert.equal(LOCAL_FIXTURES.narration(false).length, 6);
  assert.equal(LOCAL_FIXTURES.DAY0, 780);
  assert.equal(LOCAL_FIXTURES.DAY1, 1140);
  assert.deepEqual(LOCAL_FIXTURES.needs.map((n) => n.id), ['n1', 'n2', 'n3']);
});

test('M18 getData：提供黄金场景全套访问面（M02 fixtures.js 落地后同名自动覆盖）', () => {
  const d = getData();
  assert.equal(typeof d.preview, 'function');
  assert.equal(typeof d.narration, 'function');
  assert.equal(typeof d.samplesFor, 'function');
  assert.equal(d.blocks.length, 5);
  assert.equal(d.script.length, 15);
  assert.equal(typeof d.SYS_WONT, 'string');
  assert.equal(d.needs.length, 3);
  assert.equal(d.DAY0, 780);
  assert.equal(d.DAY1, 1140);
  assert.equal(typeof d.traceText, 'string', '兜底 traceText 为串（{{contract}} 占位）');
  assert.ok(Array.isArray(d.examples) && d.examples.length === 2, '讨论例句常在（app 侧补充数据）');
});

test('M18 preview 两态：r 块置信度 64→78、标题变、patched 大纲带 add/del/chg（prototype L260-275）', () => {
  const data = getData();
  const base = data.preview('r');
  const patched = data.preview('r', { patched: true });
  assert.equal(base.confidence, 64);
  assert.equal(patched.confidence, 78);
  assert.equal(patched.title, '国内 K12 的 AI 教育：政策、课堂与教师准备度');
  const outlinePatched = patched.shape.blocks.find((b) => b.type === 'outline');
  const ds = outlinePatched.items.map((it) => it.d || '');
  assert.ok(ds.includes('add') && ds.includes('del') && ds.includes('chg'));
  const outlineBase = base.shape.blocks.find((b) => b.type === 'outline');
  assert.ok(outlineBase.items.every((it) => !it.d), '初始态无差异类');
});

// ---------- C. tick：模拟时钟剧本（prototype L592-611 逐条） ----------

test('M18 tick：paused 不推进（prototype L594）', () => {
  const s0 = { ...initialState(), paused: true };
  const out = tick(s0, getData().script, 0);
  assert.equal(out.state.sim, s0.sim);
  assert.equal(out.state.feed.length, 0);
});

test('M18 tick：13:30 首行——feed 出检索行 + 状态 live→prep（13:30–14:00 准备窗，L608）', () => {
  let st = at(T('13:29'));
  let cursor = 0;
  const data = getData();
  ({ state: st } = tick(st, data.script, cursor)); // sim 13:30
  assert.equal(st.sim, T('13:30'));
  assert.equal(st.feed.length, 1);
  assert.equal(st.feed[0].t, '13:30');
  assert.ok(st.feed[0].text.includes('研究员 ×3 开始检索'));
  assert.equal(st.status.r, 'prep', '13:30–14:00 且 live → prep');
});

test('M18 tick：13:55 n1 弹出——feed「需要你：确认研究受众」+ needs 开启 + 状态 need（L599-604）', () => {
  const data = getData();
  let st = at(T('13:54'));
  let cursor = 2; // 越过 13:30/13:44（它们的 feed 断言见上/下）
  ({ state: st } = tick(st, data.script, cursor));
  assert.equal(st.status.r, 'need');
  assert.equal(st.needs.length, 1);
  assert.equal(st.needs[0].id, 'n1');
  assert.equal(st.needs[0].done, '');
  const row = st.feed.find((f) => f.t === '13:55');
  assert.equal(row.text, '需要你：确认研究受众');
});

test('M18 tick：超时默认——14:00 未答 n1 → done「超时 · 按"对"继续」+ need→live（L607）', () => {
  const data = getData();
  let st = at(T('13:59'));
  let cursor = 3; // 13:55 行已处理（needs 已有 n1）
  st = { ...st, needs: [{ ...data.script[2].need, b: 'r', done: '' }], status: { ...st.status, r: 'need' } };
  ({ state: st } = tick(st, data.script, cursor));
  assert.equal(st.needs[0].done, '超时 · 按"对"继续');
  assert.equal(st.status.r, 'live');
});

test('M18 tick：签约时已答 n1（patched）——不进 needs，feed 出「不再打扰你」注记（L598/L602）', () => {
  const data = getData();
  let st = { ...at(T('13:54')), answered: { n1: true } };
  ({ state: st } = tick(st, data.script, 2));
  assert.equal(st.needs.length, 0, 'pre-answered 不再弹 need');
  const note = st.feed.find((f) => f.icon === '✓');
  assert.equal(note.text, '受众已在签约时确认，不再打扰你');
  assert.equal(st.status.r, 'prep', '13:55 仍在准备窗 → prep');
});

test('M18 tick：14:52 deliver r——状态 ready（L600 deliver 分支）', () => {
  const data = getData();
  let st = at(T('14:51'));
  ({ state: st } = tick(st, data.script, 6)); // 第 7 行（14:52 交付）
  assert.equal(st.status.r, 'ready');
  assert.ok(st.feed.some((f) => f.t === '14:52' && f.deliver === 'r'));
});

test('M18 tick：18:20 n3——feed 文本取「需要你：该出发了」（该行无 text，L599 补齐规则）', () => {
  const data = getData();
  let st = at(T('18:19'));
  ({ state: st } = tick(st, data.script, 14));
  assert.equal(st.needs.at(-1).id, 'n3');
  const row = st.feed.find((f) => f.t === '18:20');
  assert.equal(row.text, '需要你：该出发了');
});

test('M18 tick：sim ≥ 19:00 → running=false（L609 收卷）', () => {
  const data = getData();
  let st = { ...at(T('18:59')), running: true };
  ({ state: st } = tick(st, data.script, 15));
  assert.equal(st.sim, T('19:00'));
  assert.equal(st.running, false);
});

test('M18 tick：大跳多行同拍——13:10→14:05 一次吃下 4 行 + n1 同拍超时（顺序：剧本先行、超时殿后）', () => {
  const data = getData();
  const out = tick(at(T('13:10')), data.script, 0);
  assert.equal(out.cursor, 4, '吃下 13:30/13:44/13:55/14:05 四行');
  assert.equal(out.state.feed.length, 4, '四行剧本各一条（13:55 无 text → 需要你：确认研究受众）');
  assert.equal(out.state.needs[0].done, '超时 · 按"对"继续', '14:05 ≥ due 14:00 同拍超时');
  assert.equal(out.state.status.r, 'live', '超时回 live');
});

// ---------- D. 状态机 reducers（prototype L452-459/631-642） ----------

test('M18 initialState：prototype L258 全量初值', () => {
  const s = initialState();
  assert.equal(s.stage, 'see');
  assert.equal(s.sel, 'r');
  assert.equal(s.patched, false);
  assert.equal(s.signed, false);
  assert.equal(s.hash, '');
  assert.equal(s.sim, T('13:10'));
  assert.equal(s.speed, 1);
  assert.equal(s.running, false);
  assert.equal(s.paused, false);
  assert.deepEqual(s.status, { r: '', c: '', f: '', b: '', s: '' });
  assert.equal(s.feed.length, 0);
  assert.equal(s.needs.length, 0);
});

test('M18 applySay：空文本原 state 返回（prototype L453 if (!text) return）', () => {
  const s = initialState();
  assert.equal(applySay(s, ''), s);
  assert.equal(applySay(s, '   '), s);
});

test('M18 applySay：patched 全链——stage see/note 落定/c 块可交付度升 hi/r 需要你清零/不动源数据', () => {
  const data = getData();
  const s0 = initialState(undefined, undefined);
  const before = JSON.parse(JSON.stringify(data.blocks));
  const s1 = applySay(s0, '研究只看国内 K12', data);
  assert.equal(s1.patched, true);
  assert.equal(s1.stage, 'see');
  assert.deepEqual(s1.note.utterance, '研究只看国内 K12');
  assert.ok(s1.note.summary.includes('新增 课堂实践 / 教师准备度 / 落地建议'));
  assert.ok(s1.note.summary.includes('删除 海外案例'));
  assert.ok(s1.note.summary.includes('变更 来源范围仅国内'));
  const c = s1.blocks.find((b) => b.id === 'c');
  assert.deepEqual(c.feas, ['hi', '可交付度 高']);
  assert.equal(s1.blocks.find((b) => b.id === 'r').needs, 0);
  assert.deepEqual(data.blocks, before, '共享 fixtures 不可变（纯 reducer）');
});

test('M18 applySign：hash/签约/stage sign；patched 才预答 n1（prototype L631-635）', () => {
  const s0 = initialState();
  const s1 = applySign(s0, 'sha256:a1b2c3…');
  assert.equal(s1.signed, true);
  assert.equal(s1.stage, 'sign');
  assert.equal(s1.hash, 'sha256:a1b2c3…');
  assert.equal(s1.answered.n1, undefined);
  const s2 = applySign(applySay(s0, 'x', getData()), 'sha256:a1b2c3…', getData());
  assert.equal(s2.answered.n1, true, 'patched → 签约即确认受众');
});

test('M18 applyRevoke：撤回复位签约四项，feed 保留（prototype L637）', () => {
  let s = applySign(initialState(), 'sha256:a1b2c3…');
  s = { ...s, running: true, feed: [{ t: '13:30', b: 'r', icon: '🔎', text: 'x' }] };
  s = applyRevoke(s);
  assert.equal(s.signed, false);
  assert.equal(s.running, false);
  assert.equal(s.stage, 'see');
  assert.equal(s.hash, '');
  assert.equal(s.feed.length, 1, '执行痕迹保留');
});

test('M18 applyAnswer：need 关闭 + 状态回 live + feed 回执；未知 need 原样返回（prototype L640）', () => {
  const data = getData();
  const n1 = { ...data.needs[0], b: 'r', done: '' };
  const s0 = { ...at(T('13:56')), needs: [n1], status: { ...initialState().status, r: 'need' } };
  const s1 = applyAnswer(s0, 'n1', '对');
  assert.equal(s1.needs[0].done, '你选了「对」');
  assert.equal(s1.status.r, 'live');
  assert.equal(s1.feed.at(-1).text, '你回答了「确认研究受众」：对');
  assert.equal(s1.feed.at(-1).t, '13:56');
  assert.equal(applyAnswer(s0, 'zz', '对'), s0, '未知 need 不动');
});

test('M18 applyAccept / applyRevise：接受→done；要求修改→feed v2 行（prototype L641-642）', () => {
  const s0 = { ...initialState(), status: { ...initialState().status, r: 'ready' } };
  const s1 = applyAccept(s0, 'r');
  assert.equal(s1.accepted.r, true);
  assert.equal(s1.status.r, 'done');
  const s2 = applyRevise(s0, 'r', '第 4 节再短一点');
  assert.equal(s2.feed.at(-1).icon, '↺');
  assert.equal(s2.feed.at(-1).text, '你要求修改：「第 4 节再短一点」→ 写作者开始 v2（v1 保留）');
  const s3 = applyRevise(s0, 'r');
  assert.ok(s3.feed.at(-1).text.includes('你要求修改'), '无意见走默认文案');
});

test('M18 applySpeedToggle / applyPauseToggle：×1↔×4、暂停开合（prototype L638-639）', () => {
  let s = initialState();
  assert.equal(applySpeedToggle(s).speed, 4);
  assert.equal(applySpeedToggle({ ...s, speed: 4 }).speed, 1);
  assert.equal(applyPauseToggle(s).paused, true);
  assert.equal(applyPauseToggle({ ...s, paused: true }).paused, false);
});

// ---------- E. 纯核 builders：state → 各组件 props ----------

test('M18 sectionsFor：preview 含把握度/骨架/插槽；切块只换 preview 串（bound/live/art/trace 恒定=增量基石）', () => {
  const data = getData();
  const s0 = initialState();
  const sec0 = sectionsFor(s0, data);
  assert.ok(sec0.preview.includes('把握'));
  assert.ok(sec0.preview.includes('64%'));
  assert.ok(sec0.preview.includes('data-slot="tiers"'));
  assert.ok(sec0.preview.includes('data-outline') || sec0.preview.includes('outline'), 'r 块出目录骨架');
  const s1 = { ...s0, sel: 'c' };
  const sec1 = sectionsFor(s1, data);
  assert.ok(sec1.preview.includes('data-slot="scene"'), 'c 块出场景片槽');
  assert.ok(sec1.preview.includes('data-slot="story"'));
  assert.ok(sec1.preview.includes('data-slot="discuss"'));
  assert.ok(sectionsFor({ ...s0, sel: 'b' }, data).preview.includes('data-slot="capture"'));
  assert.ok(!sectionsFor({ ...s0, sel: 's' }, data).preview.includes('data-slot="tiers"'), 's 块不出四档');
  const s2 = { ...s0, signed: true, patched: true, feed: [{ t: '13:30', b: 'r', icon: 'x', text: 'y' }] };
  const sec2 = sectionsFor(s2, data);
  assert.equal(sec0.bound, sec2.bound, 'bound 段串恒定（子组件 mount 保活）');
  assert.equal(sec0.live, sec2.live);
  assert.equal(sec0.art, sec2.art);
  assert.equal(sec0.trace, sec2.trace);
});

test('M18 pendingMap：needs 空不映射（回落块 needs=PRD +3s「需要你 N」）；有 need 后显式全量映射', () => {
  const data = getData();
  const s0 = initialState();
  assert.equal(pendingMap(s0), undefined);
  assert.equal(blockListProps(s0, data).pending, undefined, '未开跑回落 block.needs');
  const s1 = { ...s0, needs: [{ ...data.needs[0], b: 'r', done: '' }] };
  assert.deepEqual(pendingMap(s1), { r: 1, c: 0, f: 0, b: 0, s: 0 });
  const s2 = { ...s1, needs: [{ ...data.needs[0], b: 'r', done: '你选了「对」' }] };
  assert.deepEqual(pendingMap(s2), { r: 0, c: 0, f: 0, b: 0, s: 0 });
});

test('M18 costFor：agent 组成/调用数封顶/状态文案（prototype L473-475）', () => {
  const data = getData();
  const s0 = initialState();
  const r0 = costFor(s0, 'r', data);
  assert.equal(r0.agents, '研究员 ×3 · 写作者 · 校对员');
  assert.equal(r0.calls, 0);
  assert.equal(r0.status, '等待开始');
  const items5 = Array.from({ length: 5 }, (_, i) => ({ t: `13:3${i}`, b: 'r', icon: '🔎', text: `x${i}` }));
  assert.equal(costFor({ ...s0, feed: items5 }, 'r', data).calls, 30, 'min(40, 5×6)');
  assert.equal(costFor({ ...s0, feed: Array.from({ length: 20 }, (_, i) => ({ t: `13:${i}`, b: 'r', icon: 'x', text: 'y' })) }, 'r', data).calls, 40, '封顶 40');
  assert.equal(costFor({ ...s0, feed: items5 }, 'c', data).calls, 45, 'min(60, 5×9)');
  assert.equal(costFor({ ...s0, feed: items5 }, 'f', data).calls, 10, 'f×2');
  assert.equal(costFor(s0, 's', data).agents, '无');
  const live = costFor({ ...s0, status: { ...s0.status, r: 'live' } }, 'r', data);
  assert.equal(live.status, '进行中');
});

test('M18 segsFromFeed / boardProps：泳道段由 feed 派生；now/simState/speed 全量下传（prototype L509/L511）', () => {
  const data = getData();
  const feed = [
    { t: '13:30', b: 'r', icon: '🔎', text: 'x', seg: ['13:30', '14:05', 'r', '检索 ×3'] },
    { t: '14:05', b: 'r', icon: '✍️', text: 'y', seg: ['14:05', '14:40', 'w', '写作'] },
  ];
  assert.deepEqual(segsFromFeed(feed), [
    { b: 'r', s: '13:30', e: '14:05', c: 'r', text: '检索 ×3' },
    { b: 'r', s: '14:05', e: '14:40', c: 'w', text: '写作' },
  ]);
  const s = { ...initialState(), feed, running: true, speed: 4 };
  const bp = boardProps(s);
  assert.equal(bp.now, T('13:10'));
  assert.equal(bp.running, true);
  assert.equal(bp.speed, 4);
  assert.equal(bp.simState, '执行中（模拟时钟）');
  assert.deepEqual(bp.segs, segsFromFeed(feed));
  assert.equal(bp.blocks.find((b) => b.id === 'r').start, '14:00');
});

test('M18 simStateText：四态文案（prototype L530 原文）', () => {
  assert.equal(simStateText(initialState()), '签约后开始执行');
  assert.equal(simStateText({ ...initialState(), signed: true, paused: true }), '已暂停 · 恢复时会重新校验合同与资源');
  assert.equal(simStateText({ ...initialState(), signed: true, sim: 1140 }), '今日执行回放结束');
  assert.equal(simStateText({ ...initialState(), signed: true, sim: 800 }), '执行中（模拟时钟）');
});

test('M18 clockText：HM(sim)', () => {
  assert.equal(clockText(initialState()), '13:10');
});

test('M18 acceptanceProps：ready/收益文案（prototype L479-488）', () => {
  const data = getData();
  const s0 = initialState();
  assert.equal(acceptanceProps(s0, data).ready, false);
  const s1 = { ...s0, status: { ...s0.status, r: 'ready' } };
  const ap = acceptanceProps(s1, data);
  assert.equal(ap.ready, true);
  assert.equal(ap.gainText, '约 45 分钟');
  assert.equal(ap.artifact.title, '国内 K12 的 AI 教育：政策、课堂与教师准备度 · v1');
  assert.equal(acceptanceProps({ ...s0, sel: 'c', status: { ...s0.status, c: 'ready' } }, data).gainText, '约 70 分钟');
});

test('M18 traceFor：未签约（未签约）/签约后嵌 hash（prototype L493）', () => {
  const data = getData();
  assert.ok(traceFor(initialState(), data).includes('contract=（未签约）'));
  assert.ok(traceFor({ ...initialState(), hash: 'sha256:a1b2c3…' }, data).includes('contract=sha256:a1b2c3…'));
});

test('M18 captureCardFor：0 无卡 / 1 快卡 / 2 深卡（prototype L383-390）', () => {
  assert.equal(captureCardFor({ ...initialState(), capture: 0 }), null);
  const q = captureCardFor({ ...initialState(), capture: 1 });
  assert.equal(q.phase, 'quick');
  assert.equal(q.imageRef, 'assets/photo-craft.jpg');
  assert.ok(q.seen.includes('正在按说明书组装书架'));
  const d = captureCardFor({ ...initialState(), capture: 2 });
  assert.equal(d.phase, 'deep');
  assert.ok(d.suggestion.includes('夹子固定 15 分钟'));
});

test('M18 gallerySamples：patched 后封面标题/节数切换（prototype L369 cover 分支）', () => {
  const data = getData();
  const base = gallerySamples({ ...initialState(), sel: 'r' }, data);
  assert.equal(base[0].kind, 'cover');
  const patched = gallerySamples({ ...initialState(), sel: 'r', patched: true }, data);
  assert.equal(patched[0].title, '国内 K12 的 AI 教育：政策、课堂与教师准备度');
  assert.deepEqual(patched[0].nums, [['5', '节'], ['7–12', '引用'], ['100%', '结论挂来源']]);
  const cS = gallerySamples({ ...initialState(), sel: 'c' }, data);
  assert.deepEqual(cS.map((x) => x.kind).sort(), ['img', 'slide']);
});

test('M18 storyboardProps / discussProps / boundariesProps / inboxProps / bellCount', () => {
  const data = getData();
  const sp = storyboardProps({ ...initialState(), patched: false }, data);
  assert.equal(sp.events.length, 8);
  assert.equal(sp.lines.length, 6);
  assert.deepEqual(sp.map, [0, 1, 2, 4, 5, 7]);
  const dp = discussProps(initialState(), data);
  assert.deepEqual(dp.examples, ['研究只看国内 K12', '课程是给初中老师的 4 课时工作坊']);
  assert.equal(dp.note, null);
  const bp = boundariesProps(initialState(), data);
  assert.equal(bp.blockCount, 4, '签约块数剔除 s（prototype L467）');
  assert.equal(bp.signed, false);
  const s1 = { ...initialState(), needs: [{ ...data.needs[0], b: 'r', done: '' }] };
  assert.equal(bellCount(s1), 1);
  assert.equal(bellCount({ ...s1, needs: [{ ...data.needs[0], b: 'r', done: '你选了「对」' }] }), 0);
  assert.deepEqual(inboxProps(s1).needs, s1.needs);
});

test('M18 tiersProps / sceneCardProps：四档 scene 态映射（gen→generating/ready 带 url）', () => {
  assert.equal(tiersProps({ ...initialState(), sel: 'c' }).scene, undefined);
  const g = sceneCardProps({ ...initialState(), sel: 'c', scene: { c: 'gen' } });
  assert.equal(g.scene.status, 'generating');
  const r = sceneCardProps({ ...initialState(), sel: 'c', scene: { c: 'ready' } });
  assert.equal(r.scene.status, 'ready');
  assert.equal(r.scene.url, 'assets/scene-classroom.mp4');
  assert.equal(sceneCardProps({ ...initialState(), sel: 'r', scene: {} }).scene.status, 'off');
});

test('M18 reelShots：6 镜、at 串与旁白六句对齐、body 白名单资产（prototype L540-550）', () => {
  const data = getData();
  const shots = reelShots({ ...initialState(), patched: false }, data);
  assert.equal(shots.length, 6);
  assert.equal(shots[0].at, '13:30 · 研究员 ×3');
  assert.ok(shots[0].body.includes('assets/illus-lesson.jpg'));
  assert.ok(shots[1].body.includes('示意'), 'cover 镜带示意水印');
  assert.ok(shots[3].body.includes('slide'), '15:00 镜为幻灯片');
  const patchedShots = reelShots({ ...initialState(), patched: true }, data);
  assert.equal(patchedShots[1].text, data.narration(true)[1]);
});

// ---------- F. createApp 壳（DI 假组件 + 假根，验证装配/事件/增量） ----------

/** 假宿主元素：记 innerHTML 写次数；querySelector 按需注入 */
function fakeEl(name) {
  return {
    name,
    _h: undefined, _v: '', writes: 0,
    listeners: {},
    get innerHTML() { return this._v; },
    set innerHTML(v) { this.writes += 1; this._v = v; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); },
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    style: {},
  };
}

/** 记录型假组件模块：mount 记 (el, props)，update 记合并；inbox 另挂 mountBell */
function fakeComp(log, tag) {
  const mk = (op) => (el, props = {}) => {
    log.push({ tag, op, el, props });
    const h = {
      el,
      props,
      update(p = {}) {
        Object.assign(h.props, p);
        log.push({ tag, op: `${op}:update`, props: h.props });
        return h;
      },
      showTab(name) { log.push({ tag, op: 'showTab', name }); },
      setProgress() { return true; },
    };
    return h;
  };
  const mod = { mount: mk('mount') };
  if (tag === 'inbox') mod.mountBell = mk('mountBell');
  return mod;
}

/** 假 drawer：update(props) 时按 sections 里 data-slot 重建槽元素（模拟段落重写→槽换身份） */
function fakeDrawerComp(log) {
  return {
    mount(el, props = {}) {
      const h = {
        el,
        props,
        slots: {},
        update(p = {}) {
          Object.assign(h.props, p);
          const secs = h.props.sections || {};
          const fresh = {};
          for (const [name, html] of Object.entries(secs)) {
            for (const m of String(html).matchAll(/data-slot="(\w+)"/g)) fresh[m[1]] = fakeEl(`slot-${m[1]}`);
          }
          Object.assign(h.slots, fresh);
          log.push({ tag: 'drawer', op: 'update', props: h.props });
          return h;
        },
        showTab(name) { log.push({ tag: 'drawer', op: 'showTab', name }); },
      };
      h.slots = {};
      h.update(props);
      log.push({ tag: 'drawer', op: 'mount', props });
      return h;
    },
  };
}

function fakeRoot() {
  const regions = {};
  for (const r of ['clock', 'blocks', 'drawer', 'board', 'inbox', 'bell', 'reel']) regions[r] = fakeEl(`region-${r}`);
  const root = fakeEl('root');
  root.querySelector = (sel) => {
    const m = /\[data-region="(\w+)"\]/.exec(sel);
    return m ? regions[m[1]] : null;
  };
  root.regions = regions;
  return root;
}

function fakeTimers() {
  const timers = [];
  const makeTimer = (fn, ms) => {
    const t = { fn, ms, cancelled: false, cancel() { t.cancelled = true; } };
    timers.push(t);
    return t.cancel;
  };
  return { timers, makeTimer, delay: makeTimer };
}

function stubApp(opts = {}) {
  const log = [];
  const comps = {
    blockCard: fakeComp(log, 'blockCard'),
    drawer: fakeDrawerComp(log),
    tiers: fakeComp(log, 'tiers'),
    sceneCard: fakeComp(log, 'sceneCard'),
    gallery: fakeComp(log, 'gallery'),
    storyboard: fakeComp(log, 'storyboard'),
    discuss: fakeComp(log, 'discuss'),
    boundaries: fakeComp(log, 'boundaries'),
    activityFeed: fakeComp(log, 'activityFeed'),
    acceptance: fakeComp(log, 'acceptance'),
    traceView: fakeComp(log, 'traceView'),
    inbox: fakeComp(log, 'inbox'),
    board: fakeComp(log, 'board'),
    captureCard: fakeComp(log, 'captureCard'),
    reelPlayer: fakeComp(log, 'reelPlayer'),
  };
  const timers = fakeTimers();
  const root = fakeRoot();
  const doc = { documentElement: { dataset: {} } };
  const handle = createApp(root, {
    components: comps,
    makeTimer: timers.makeTimer,
    delay: timers.delay,
    doc,
    rng: () => [0, 1, 2, 3, 4, 5],
    ...opts,
  });
  return { handle, log, comps, timers, root, doc };
}

test('M18 createApp：壳一次写根；五大区挂载（块列表/抽屉/交付台/收件箱/铃铛）+ 时钟 13:10', () => {
  const { handle, log, root } = stubApp();
  assert.equal(root.writes, 1, '壳 HTML 只写一次（增量基石）');
  for (const tag of ['blockCard', 'drawer', 'board', 'inbox']) {
    assert.ok(log.some((x) => x.tag === tag && x.op === 'mount'), `${tag} 挂载`);
  }
  assert.ok(log.some((x) => x.tag === 'inbox' && x.op === 'mountBell' && x.el.name === 'region-bell'), '铃铛挂 bell 区');
  assert.equal(root.regions.clock._v !== undefined || root.regions.clock.textContent !== undefined, true);
  assert.equal(handle.state.sel, 'r');
});

test('M18 createApp：say → patched 传导到块列表 props（c 可交付度 hi）+ 讨论 note 下传', () => {
  const { handle, log } = stubApp();
  handle.actions.say('研究只看国内 K12');
  const blk = log.filter((x) => x.tag === 'blockCard').at(-1).props;
  assert.equal(blk.blocks.find((b) => b.id === 'c').feas[0], 'hi');
  const dis = log.filter((x) => x.tag === 'discuss').at(-1).props;
  assert.equal(dis.note.utterance, '研究只看国内 K12');
});

test('M18 createApp：sign → hash 落定 + 600ms 延时开跑（prototype L635）+ step 推进时钟', () => {
  const { handle, timers, log } = stubApp();
  handle.actions.sign();
  assert.equal(handle.state.hash, 'sha256:000102030405…');
  assert.equal(handle.state.signed, true);
  assert.equal(timers.timers.length >= 1, true, '签约后有一次延时');
  assert.equal(handle.state.running, false, '延时前未跑');
  timers.timers[0].fn(); // 触发 startSim
  assert.equal(handle.state.running, true);
  assert.equal(handle.state.stage, 'run');
  handle.step(); // 一次 tick + render
  assert.equal(handle.state.sim, T('13:11'));
  const boardProps_ = log.filter((x) => x.tag === 'board').at(-1).props;
  assert.equal(boardProps_.simState, '执行中（模拟时钟）');
});

test('M18 createApp：select 切块 → drawer blockId 换 + c 块槽重建重挂（scene/story/discuss）', () => {
  const { handle, log } = stubApp();
  const mountsBefore = log.filter((x) => x.op === 'mount' && x.tag === 'storyboard').length;
  handle.actions.select('c');
  const dw = log.filter((x) => x.tag === 'drawer').at(-1).props;
  assert.equal(dw.blockId, 'c');
  assert.equal(log.filter((x) => x.op === 'mount' && x.tag === 'storyboard').length, mountsBefore + 1, '切块后分镜轴重挂');
  assert.ok(log.some((x) => x.op === 'mount' && x.tag === 'sceneCard'), 'c 块场景片槽挂载');
});

test('M18 createApp：speed/pause → board props 回流；answer/accept → 收件箱计数与验收态', () => {
  const { handle, log, timers } = stubApp();
  handle.actions.speedToggle();
  assert.equal(log.filter((x) => x.tag === 'board').at(-1).props.speed, 4);
  handle.actions.pauseToggle();
  assert.equal(log.filter((x) => x.tag === 'board').at(-1).props.paused, true);
  handle.actions.pauseToggle(); // 恢复，便于推进
  // 开跑推进到 13:55 弹出 n1，再作答
  handle.actions.sign();
  timers.timers[0].fn(); // startSim
  for (let i = 0; i < 45; i += 1) handle.step(); // 13:11 → 13:55
  assert.equal(handle.state.needs.length, 1);
  assert.equal(log.filter((x) => x.tag === 'inbox' && x.op === 'mountBell:update').at(-1).props.count, 1, '铃铛计数 1');
  handle.actions.answer('n1', '对');
  assert.equal(handle.state.needs[0].done, '你选了「对」');
  assert.equal(log.filter((x) => x.tag === 'inbox' && x.op === 'mountBell:update').at(-1).props.count, 0);
  handle.actions.accept({ opinion: '' });
  assert.equal(handle.state.accepted.r, true);
});

test('M18 createApp：openReel → reelPlayer mount 六镜；theme 切换写 documentElement', () => {
  const { handle, log, doc } = stubApp();
  handle.actions.openReel();
  const m = log.find((x) => x.tag === 'reelPlayer' && x.op === 'mount');
  assert.equal(m.props.shots.length, 6);
  handle.actions.toggleTheme();
  assert.equal(doc.documentElement.dataset.theme, 'dark');
  handle.actions.toggleTheme();
  assert.equal(doc.documentElement.dataset.theme, 'light');
});

test('M18 createApp：startScene 进度 25 拍到 ready；capture 快→深（延时升级）', () => {
  const { handle, timers } = stubApp();
  handle.actions.select('c');
  handle.actions.startScene('c');
  assert.equal(handle.state.scene.c, 'gen');
  const sceneTimer = timers.timers.at(-1);
  for (let i = 0; i < 25; i += 1) sceneTimer.fn();
  assert.equal(handle.state.scene.c, 'ready');
  handle.actions.select('b');
  handle.actions.capture();
  assert.equal(handle.state.capture, 1);
  timers.timers.at(-1).fn();
  assert.equal(handle.state.capture, 2);
});
