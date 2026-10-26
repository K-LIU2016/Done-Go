// M18 demo.html 黄金场景装配 —— 组装 M03–M17 全组件 + 模拟时钟剧本状态机（纯核 + DOM 壳）
// 依据：plan.md M18、PRD §3.2（黄金场景表）、§5.2 末（增量更新：整块重绘丢按钮/展开态/字幕——
//   本模块把「切内容」全部下沉为子组件 update(props)，壳只在 createApp 写一次）；
//   prototype.html（唯一视觉/交互标准）：
//   L188-239 页面骨架（header.top + stepper + .grid 左列表右抽屉 + .board + .inbox）、
//   L249-322 黄金数据（blocks/previews/boundaries/script）、L258 state 初值、
//   L325-536 渲染函数族、L538-579 预演片、L581-589 场景片/拍一下、
//   L592-615 tick（模拟时钟 + 超时默认 + 13:30–14:00 准备窗 + 19:00 收卷）、
//   L617-648 事件（say/sign→hash→600ms startSim/revoke/speed/answer/accept/revise/bell/theme）。
// 分层：纯核（数据兜底 + reducer + tick + props builders，node --test 可测）+ DOM 壳
//   （createApp：挂全组件、容器级事件、模拟时钟定时器）。
// 增量纪律：bound/live/art/trace 四段 HTML 恒为常量串（抽屉 diff 永不重写 → 子组件 DOM 保活）；
//   preview 段只随 sel/patched 变（切块/讨论才重建，同原型 renderPreview 语义）；
//   槽位 syncSlot 以节点身份比对，段重写后自动重挂。
// fixtures：静态 import ./fixtures.js（M02 契约同名导出，黄金数据单一来源；
//   并行落地期的 LOCAL_FIXTURES 逐字双份已收编为别名视图）；页面骨架样式由 APP_CSS 顶上。
// 与原型的有意差异（记录在案）：
//   1) costFor 给 b 块补了 calls 兜底（原型 {r,c,f,s}[b] → undefined 渲染「undefined 次」）；
//   2) 拒绝（data-rej）三操作之一，原型未给行为，本壳同款 no-op；
//   3) tick 增加可选 advance 参数（缺省 1 分钟，同原型）便于测试/快进截图。
import * as blockCardMod from './block-card.js';
import * as drawerMod from './drawer.js';
import * as tiersMod from './tiers.js';
import * as sceneCardMod from './scene-card.js';
import * as galleryMod from './gallery.js';
import * as storyboardMod from './storyboard.js';
import * as discussMod from './discuss.js';
import * as boundariesMod from './boundaries.js';
import * as activityFeedMod from './activity-feed.js';
import * as acceptanceMod from './acceptance.js';
import * as traceViewMod from './trace-view.js';
import * as inboxMod from './inbox.js';
import * as boardMod from './board.js';
import * as captureCardMod from './capture-card.js';
import * as reelPlayerMod from './reel-player.js';
import { renderShape } from './shape/registry.js';
import './shape/text-shapes.js'; // 注册副作用：outline/facts/caveat/table/cards
import './shape/rich-shapes.js'; // 注册副作用：checklist/timeline/slides/diffSummary/mapRoute/personCard/sample
import { STATUS_TEXT } from './block-card.js';
import { figuresHTML } from './gallery.js';
import * as fixturesNS from './fixtures.js'; // M02 黄金场景数据单一来源（原 LOCAL_FIXTURES 逐字双份已收编）

// M01 utils.js 已落地为硬依赖：esc/setHTML 直引共享实现，单一来源
//（并行落地期的「动态探测 + 本地同规则兜底」已收编，组件顶层 await 随之移除）。
import { esc, setHTML, T } from './utils.js';

export { esc, setHTML }; // 保持既有 re-export 导入面（单测/组件页按组件模块导入）

// ---------- 常量 ----------
const DAY1 = 1140; // 19:00（DAY0=780 由 fixtures.js 导出，单一来源）
const SIGN_DELAY_MS = 600; // prototype L635：签约 600ms 后开跑
const TICK_MS_BASE = 600; // prototype L614：interval = 600 / speed（1 分钟 ≈ 600ms）
const SCENE_STEP_PCT = 4; // prototype L584：进度 +4%/拍
const SCENE_STEP_MS = 200; // prototype L584：200ms/拍
const CAPTURE_DEEP_MS = 4500; // prototype L588：快卡 4.5s 后升深卡
const PREP_FROM = T('13:30'); // prototype L608 准备窗
const PREP_TO = T('14:00');
export const REVISE_DEFAULT_OPINION = '第 4 节再短一点'; // prototype L642 默认意见
export const SAY_SUMMARY = '新增 课堂实践 / 教师准备度 / 落地建议；删除 海外案例；变更 来源范围仅国内；课程改为 4 课时工作坊（2.4 秒）'; // prototype L458
export const NARR_MAP = [0, 1, 2, 4, 5, 7]; // prototype L437：字幕行 → 点亮事件索引

// ---------- 黄金场景数据（单一来源 fixtures.js）+ app 侧屏显补充 ----------

/** 抽屉 h2 屏显标题（prototype L260-294 文案；契约 Preview 无顶层 title，屏显由 app 侧提供） */
const UI_TITLES = {
  r: ['AI 教育现状与趋势', '国内 K12 的 AI 教育：政策、课堂与教师准备度'],
  c: ['课程设计（受众与课时待定）', '「AI 进课堂」初中教师工作坊 · 4 课时'],
  f: ['和小王吃饭 · 行前准备'], b: ['三层原木小书架 · 第一次做'], s: ['自己的时间'],
};
export function titleFor(state) {
  const pair = UI_TITLES[state.sel] || UI_TITLES.r;
  return pair[state.patched && pair.length > 1 ? 1 : 0] || pair[0];
}

/** app 侧补充数据（fixtures 契约之外，恒由本模块提供） */
const APP_EXTRA = {
  examples: ['研究只看国内 K12', '课程是给初中老师的 4 课时工作坊'], // prototype L410
  artifacts: { // prototype L484-485
    r: { title: '国内 K12 的 AI 教育：政策、课堂与教师准备度 · v1', meta: '3120 字 · 5 节 · 9 个引用', evidence: '证据：引用核验 9/9 通过（1 处数据曾不符，已修正并复核）· 来源均为 2024 年后官方或公开论文 · 查看引用列表' },
    c: { title: '「AI 进课堂」初中教师工作坊 · 4 课时 · v1', meta: '课时表 + 4 张活动卡 + 评估量表', evidence: '证据：DoD 6/6 通过 · 引用研究报告第 2、3 节 · 方向：A（每课时 1 个动手活动）' },
  },
  gains: { r: '约 45 分钟', c: '约 70 分钟' }, // prototype L487
  agentsOf: { r: '研究员 ×3 · 写作者 · 校对员', c: '规划者 · 设计者 · 校对员', f: '向导 · 路线' }, // prototype L475
  coverPatched: { title: '国内 K12 的 AI 教育：政策、课堂与教师准备度', nums: [['5', '节'], ['7–12', '引用'], ['100%', '结论挂来源']] }, // prototype L369
};

/**
 * 黄金场景数据访问面（单一来源）：fixtures.js 全量导出 + app 侧补充数据（examples/
 * artifacts/gains/agentsOf/coverPatched，契约之外恒由本模块提供）。
 * LOCAL_FIXTURES 保留为具名导出（app.test.mjs 既有契约面），值即本访问面——不再有第二份数据。
 * traceText 的 `{{contract}}` 占位由 traceFor 替换。
 */
export const LOCAL_FIXTURES = { ...APP_EXTRA, ...fixturesNS };

/** 数据访问面：fixtures.js（单一来源）+ app 侧补充数据 */
export function getData() {
  return LOCAL_FIXTURES;
}

// ---------- 纯核：参数 / 工具 ----------

/** 分钟数 → 'HH:MM'（prototype L245） */
export function HM(t) {
  const n = Number.isFinite(t) ? Math.max(0, Math.trunc(t)) : 0;
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}

/**
 * URL 参数（plan M18：?speed=/?theme=/?block= 便于测试与截图）：
 * speed 正有限数（×1/×4 之外也收，供快进）；theme ∈ light|dark；block 须在黄金块集内。
 */
export function parseParams(search) {
  const get = (k) => {
    if (typeof search === 'string') return new RegExp(`[?&]${k}=([^&]*)`).exec(search)?.[1] ?? '';
    if (search && typeof search.get === 'function') return search.get(k) ?? '';
    return '';
  };
  const sp = Number(get('speed'));
  const speed = Number.isFinite(sp) && sp > 0 ? sp : 1;
  const th = get('theme');
  const theme = th === 'light' || th === 'dark' ? th : '';
  const blk = get('block');
  const block = getData().blocks.some((b) => b.id === blk) ? blk : 'r';
  return { speed, theme, block };
}

/** 6 字节 → 'sha256:hex×12…'（prototype L633 格式；字节由壳注入，测试可定值） */
export function makeHash(bytes) {
  const arr = Array.from(bytes ?? [], (b) => Number(b) & 0xff);
  return `sha256:${arr.map((b) => b.toString(16).padStart(2, '0')).join('')}…`;
}

/** 浏览器随机源（crypto 不可用时回退 Math.random，演示不因此炸） */
export function defaultRng() {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
  if (c && typeof c.getRandomValues === 'function') return c.getRandomValues(new Uint8Array(6));
  return Array.from({ length: 6 }, () => Math.floor(Math.random() * 256));
}

// ---------- 纯核：状态机 ----------

/** 初始态（prototype L258 全量；blocks 拷贝——reducer 绝不碰共享 fixtures） */
export function initialState(data = getData(), params = { speed: 1, theme: '', block: 'r' }) {
  return {
    stage: 'see',
    sel: params.block,
    patched: false,
    signed: false,
    hash: '',
    sim: T('13:10'),
    speed: params.speed,
    running: false,
    paused: false,
    answered: {},
    status: Object.fromEntries(data.blocks.map((b) => [b.id, ''])),
    accepted: {},
    feed: [],
    needs: [],
    scene: {},
    capture: 0,
    note: null,
    blocks: data.blocks.map((b) => ({ ...b })),
  };
}

/** 讨论 → patched 两态（prototype applySay L452-459）：空文本原样返回；源数据不可变 */
export function applySay(state, text, data = getData()) {
  void data;
  const t = String(text ?? '').trim();
  if (!t) return state;
  return {
    ...state,
    patched: true,
    stage: 'see',
    note: { utterance: t, summary: SAY_SUMMARY },
    blocks: state.blocks.map((b) => {
      if (b.id === 'c') return { ...b, feas: ['hi', '可交付度 高'] };
      if (b.id === 'r') return { ...b, needs: 0 };
      return b;
    }),
  };
}

/** 签约 → hash + 阶段 sign；patched 时预答 n1（prototype L631-635） */
export function applySign(state, hash) {
  return {
    ...state,
    signed: true,
    stage: 'sign',
    hash: String(hash ?? ''),
    answered: state.patched ? { ...state.answered, n1: true } : state.answered,
  };
}

/** 撤回（prototype L637）：复位签约四项，执行痕迹（feed/needs）保留 */
export function applyRevoke(state) {
  return { ...state, signed: false, running: false, stage: 'see', hash: '' };
}

/** 作答 need（prototype L640）：关卡 + 状态回 live + feed 回执；未知 need 原样返回 */
export function applyAnswer(state, needId, value) {
  const need = state.needs.find((n) => n.id === needId);
  if (!need) return state;
  const v = String(value ?? '');
  return {
    ...state,
    needs: state.needs.map((n) => (n.id === needId ? { ...n, done: `你选了「${v}」` } : n)),
    status: { ...state.status, [need.b]: 'live' },
    feed: [...state.feed, { t: HM(state.sim), b: need.b, icon: '✓', text: `你回答了「${need.title}」：${v}` }],
  };
}

/** 接受交付（prototype L641）：accepted + 状态 done */
export function applyAccept(state, blockId) {
  return {
    ...state,
    accepted: { ...state.accepted, [blockId]: true },
    status: { ...state.status, [blockId]: 'done' },
  };
}

/** 要求修改（prototype L642）：意见进 feed（v1 保留语义）；无意见走原型默认文案 */
export function applyRevise(state, blockId, opinion) {
  const op = String(opinion ?? '').trim() || REVISE_DEFAULT_OPINION;
  return {
    ...state,
    feed: [...state.feed, { t: HM(state.sim), b: blockId, icon: '↺', text: `你要求修改：「${op}」→ 写作者开始 v2（v1 保留）` }],
  };
}

/** 速度 ×1↔×4（prototype L639） */
export function applySpeedToggle(state) {
  return { ...state, speed: state.speed === 1 ? 4 : 1 };
}

/** 全部暂停/继续（prototype L638） */
export function applyPauseToggle(state) {
  return { ...state, paused: !state.paused };
}

/**
 * 模拟时钟一拍（prototype tick L593-611，逐条对齐）：
 *   paused 不推进；sim 前进 advance 分钟（缺省 1）；剧本行按 tm ≤ sim 依序落地——
 *   未预答的行进 feed（need 无 text 的行补「需要你：标题」）、状态 deliver→ready 否则 live、
 *   need 弹卡置 need（n1 已预答则改记「不再打扰你」）；随后超时默认（done=「超时 · 默认」，
 *   need→live）；13:30–14:00 研究块 live→prep；sim ≥ 19:00 收卷 running=false。
 */
export function tick(state, script, cursor, advance = 1) {
  if (state.paused) return { state, cursor };
  const rows = Array.isArray(script) ? script : [];
  let cur = Number.isInteger(cursor) ? cursor : 0;
  const step = Number.isFinite(advance) && advance > 0 ? Math.trunc(advance) : 1;
  const sim = state.sim + step;
  const feed = [...state.feed];
  const needs = state.needs.map((n) => ({ ...n }));
  const status = { ...state.status };
  while (cur < rows.length && rows[cur].tm <= sim) {
    const s = rows[cur++];
    const preAnswered = s.need && state.answered[s.need.id];
    if (!preAnswered) feed.push(s.need && !s.text ? { ...s, text: `需要你：${s.need.title}` } : { ...s });
    status[s.b] = s.deliver ? 'ready' : 'live';
    if (s.need) {
      if (s.need.id === 'n1' && state.answered.n1) {
        feed.push({ t: s.t, b: s.b, icon: '✓', text: '受众已在签约时确认，不再打扰你' });
      } else {
        needs.push({ ...s.need, b: s.b, done: '' });
        status[s.b] = 'need';
      }
    }
  }
  for (const n of needs) {
    if (!n.done && sim >= T(n.due)) {
      n.done = `超时 · ${n.def}`;
      if (status[n.b] === 'need') status[n.b] = 'live';
    }
  }
  if (PREP_FROM <= sim && sim < PREP_TO && status.r === 'live') status.r = 'prep';
  return {
    state: { ...state, sim, feed, needs, status, running: sim >= DAY1 ? false : state.running },
    cursor: cur,
  };
}

// ---------- 纯核：文案与 props builders（state → 各组件 props） ----------

/** 交付台状态文案四态（prototype L530 原文） */
export function simStateText(state) {
  if (!state.signed) return '签约后开始执行';
  if (state.paused) return '已暂停 · 恢复时会重新校验合同与资源';
  if (state.sim >= DAY1) return '今日执行回放结束';
  return '执行中（模拟时钟）';
}

/** 时钟文案 */
export function clockText(state) {
  return HM(state.sim);
}

/**
 * 「需要你 N」映射：needs 为空 → undefined（block-card 回落 block.needs，
 * PRD +3s 扫描行的静态角标）；有 need 后显式全量映射（0 也压过块静态值）。
 */
export function pendingMap(state) {
  if (!state.needs.length) return undefined;
  const out = {};
  for (const b of state.blocks) out[b.id] = 0;
  for (const n of state.needs) if (!n.done && n.b in out) out[n.b] += 1;
  return out;
}

/** 进行中 cost 行（prototype L473-475；b 块原型漏定义 → 兜底条数，差异记录在案） */
export function costFor(state, blockId, data = getData()) {
  const items = state.feed.filter((f) => f.b === blockId);
  const cap = { r: 40, c: 60 };
  const per = { r: 6, c: 9, f: 2, b: 1 };
  const raw = per[blockId] !== undefined ? Math.min(cap[blockId] ?? Infinity, items.length * per[blockId]) : 0;
  return {
    agents: data.agentsOf?.[blockId] ?? '无',
    calls: raw,
    status: state.status[blockId] ? STATUS_TEXT[state.status[blockId]] ?? '等待开始' : '等待开始',
  };
}

/** 泳道段：feed 行 seg 四元组 → board {b,s,e,c,text}（prototype L509） */
export function segsFromFeed(feed) {
  return (Array.isArray(feed) ? feed : [])
    .filter((f) => f && Array.isArray(f.seg))
    .map((f) => ({ b: f.b, s: f.seg[0], e: f.seg[1], c: f.seg[2], text: f.seg[3] }));
}

/** 追踪层文本：{{contract}} → hash 或（未签约）（prototype L493；fixtures 串无占位则原样） */
export function traceFor(state, data = getData()) {
  const raw = typeof data.traceText === 'string' ? data.traceText : '';
  return raw.split('{{contract}}').join(state.hash || '（未签约）');
}

/** 拍一下卡：0 无卡 / 1 快卡 / 2 深卡（prototype L386-390） */
export function captureCardFor(state) {
  if (state.capture === 1) {
    return {
      phase: 'quick', blockId: 'b', imageRef: 'assets/photo-craft.jpg',
      seen: '正在按说明书组装书架，胶水和螺丝已就位。',
    };
  }
  if (state.capture === 2) {
    return {
      phase: 'deep', blockId: 'b', imageRef: 'assets/photo-craft.jpg',
      change: '隔板已上胶，但胶水溢出、没用夹具固定，可能会不平。',
      suggestion: '用湿布擦掉多余胶水 → 直尺检查隔板水平，必要时垫纸片微调 → 夹子固定 15 分钟再拧螺丝。',
    };
  }
  return null;
}

/** 样张：patched 后 r 块封面标题/节数切换（prototype L369 cover 分支） */
export function gallerySamples(state, data = getData()) {
  const list = Array.isArray(data.samplesFor(state.sel)) ? data.samplesFor(state.sel) : [];
  if (state.sel !== 'r' || !state.patched) return list;
  return list.map((sm) => (sm && sm.kind === 'cover' ? { ...sm, ...(data.coverPatched ?? {}) } : sm));
}

/** 抽屉五段 HTML：bound/live/art/trace 恒为常量串（子组件 DOM 跨 render 保活的根基） */
export function sectionsFor(state, data = getData()) {
  const p = data.preview(state.sel, { patched: state.patched });
  /** 把握度屏显：Preview JSON confidence 为 PRD §10.3 的 0–1，原型 64%/78% 由 ×100 取整还原 */
  const confPct = (pv) => Math.round((Number(pv.confidence) || 0) * 100);
  const heading = state.sel === 'r' ? '研究报告 · 目录骨架'
    : state.sel === 'c' ? '课程方案 · 课时表与样张'
      : state.sel === 'b' ? '步骤与物料' : '交付内容';
  const samples = gallerySamples(state, data);
  const isRC = state.sel === 'r' || state.sel === 'c';
  const preview = `<h2>${esc(titleFor(state))}</h2>`
    + `<div class="conf">把握 <i style="--v:${confPct(p)}%"></i> ${confPct(p)}% · 这是交付物大致的样子，不是成品</div>`
    + (state.sel !== 's' ? '<div data-slot="tiers"></div>' : '')
    + `<div class="shape"><h3>${esc(heading)}</h3>${p.shape.blocks.map((b) => renderShape(b)).join('')}</div>`
    + (samples.length ? `<div class="gallery">${figuresHTML(samples)}</div>` : '')
    + (state.sel === 'c' ? '<div data-slot="scene"></div>' : '')
    + (state.sel === 'b' ? '<div data-slot="capture"></div>' : '')
    + (isRC ? '<div data-slot="story"></div><div data-slot="discuss"></div>' : '');
  return {
    preview,
    bound: '<div data-slot="bound"></div>',
    live: '<div data-slot="live"></div>',
    art: '<div data-slot="art"></div>',
    trace: '<div data-slot="trace"></div>',
  };
}

/** 块列表 props（M05） */
export function blockListProps(state, data = getData()) {
  return { blocks: state.blocks, sel: state.sel, status: state.status, pending: pendingMap(state), blocksData: data.blocks };
}

/** 四档进度 props（M07）：scene 原始态直传（tiers 自行归一） */
export function tiersProps(state) {
  return { blockId: state.sel, scene: state.scene[state.sel] };
}

/** 场景片卡 props（M07）：gen→generating；ready 带 16:9 媒体（prototype L381-382） */
export function sceneCardProps(state) {
  const raw = state.scene[state.sel];
  if (state.sel === 'c' && raw === 'gen') return { scene: { status: 'generating' } };
  if (state.sel === 'c' && raw === 'ready') {
    return { scene: { status: 'ready', url: 'assets/scene-classroom.mp4', poster: 'assets/scene-classroom-poster.jpg', title: '场景片 · 第 2 课时现场（示意）' } };
  }
  return { scene: { status: 'off' } };
}

/** 分镜轴 + 旁白 props（M09；map = 字幕行→点亮事件，prototype L437） */
export function storyboardProps(state, data = getData()) {
  return { events: data.storyEvents, lines: data.narration(state.patched), map: NARR_MAP };
}

/** 讨论框 props（M10） */
export function discussProps(state, data = getData()) {
  return { examples: data.examples, note: state.note };
}

/** 边界 + 签约 props（M11；签约块数剔除 s，prototype L467） */
export function boundariesProps(state, data = getData()) {
  return {
    boundary: data.boundaries[state.sel],
    sysWont: data.SYS_WONT,
    signed: state.signed,
    hash: state.hash,
    blockCount: state.blocks.filter((b) => b.id !== 's').length,
  };
}

/** 进行中活动流 props（M12） */
export function feedProps(state, data = getData()) {
  return { signed: state.signed, cost: costFor(state, state.sel, data), items: state.feed.filter((f) => f.b === state.sel) };
}

/** 验收 props（M13） */
export function acceptanceProps(state, data = getData()) {
  const st = state.status[state.sel];
  return {
    ready: st === 'ready' || st === 'done',
    artifact: data.artifacts?.[state.sel] ?? {},
    accepted: !!state.accepted[state.sel],
    gainText: data.gains?.[state.sel] ?? '',
  };
}

/** 追踪层 props（M13） */
export function traceProps(state, data = getData()) {
  return { traceText: traceFor(state, data) };
}

/** 交付台 props（M15） */
export function boardProps(state) {
  return {
    blocks: state.blocks.map((b) => ({ id: b.id, start: b.start, end: b.end, title: b.title, status: state.status[b.id] || '' })),
    segs: segsFromFeed(state.feed),
    now: state.sim,
    running: state.running,
    paused: state.paused,
    signed: state.signed,
    speed: state.speed,
    simState: simStateText(state),
  };
}

/** 收件箱 props（M14） */
export function inboxProps(state) {
  return { needs: state.needs, blocks: state.blocks };
}

/** 铃铛计数：未决 need 数（prototype L516-517） */
export function bellCount(state) {
  return state.needs.filter((n) => !n.done).length;
}

/** 预演片六镜（prototype reelShots L540-550；cover/slide 走 M08 模板带示意水印） */
export function reelShots(state, data = getData()) {
  const n = data.narration(state.patched);
  const cover = galleryMod.frameHTML({ kind: 'cover', ...(state.patched ? data.coverPatched ?? {} : {}) });
  const slide = galleryMod.frameHTML({ kind: 'slide' });
  return [
    { at: '13:30 · 研究员 ×3', body: '<img src="assets/illus-lesson.jpg" alt="">', text: n[0] },
    { at: '13:55 · 需要你 30 秒', body: cover, text: n[1] },
    { at: '14:30 · 校对员核验引用', body: cover, text: n[2] },
    { at: '15:00 · 课程设计接力', body: slide, text: n[3] },
    { at: '15:28 · 你选大纲方向', body: '<img src="assets/slide-qwen.jpg" alt="">', text: n[4] },
    { at: '17:00 · 交付', body: '<img src="assets/scene-classroom-poster.jpg" alt="">', text: n[5] },
  ];
}

// ---------- 页面骨架样式（M01 agentic.css 落地前顶上；同名规则值同源 prototype，共存无害） ----------

export const APP_CSS = `
:root{--bg:#EEF3EC;--surface:#FFFFFF;--text:#22302A;--text-2:#5C6B61;--line:rgba(34,48,42,.14);--accent:#3E5A47;--warm:#8A5A2B;--paper:#FCFBF6;--deep:#2E4636;--spring:#EEF0BE;--k-create:#B07A36;--k-connect:#B05A4D;--k-explore:#4D7699;--k-stillness:#6E7E72;--k-restore:#4F8570;--ok:#3F7A55;--warn:#B07A36;--bad:#A53B25;--you:#E95432;--add:rgba(63,122,85,.14);--del:rgba(165,59,37,.12);--chg:rgba(238,240,190,.9);--font-serif:"Noto Serif SC","Songti SC","STSong",serif;--font-sans:"Noto Sans SC","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;color-scheme:light}
.ag-app *{box-sizing:border-box}
.ag-app{background:var(--bg,#EEF3EC);color:var(--text,#22302A);font:15px/1.55 var(--font-sans,sans-serif);-webkit-font-smoothing:antialiased;min-height:100vh}
.ag-app h1,.ag-app h2,.ag-app h3{font-family:var(--font-serif,serif);font-weight:400;margin:0}
.ag-app p{margin:0}
.ag-app button{font:inherit;color:inherit;cursor:pointer}
.ag-wrap{max-width:1180px;margin:0 auto;padding:16px}
.ag-top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.ag-top h1{font-size:24px;letter-spacing:.08em}
.ag-top .sub{color:var(--text-2,#5C6B61);font-size:13px}
.spacer{flex:1}
.ag-app .btn{border:1px solid var(--line,rgba(34,48,42,.14));background:var(--surface,#FFFFFF);border-radius:999px;padding:8px 16px;min-height:40px}
.ag-app .btn.primary{background:var(--accent,#3E5A47);border-color:var(--accent,#3E5A47);color:var(--surface,#FFFFFF)}
.ag-app .btn.danger{color:var(--bad,#A53B25)}
.ag-app .btn[disabled]{opacity:.5;cursor:default}
.ag-app .btn:focus-visible{outline:2px solid var(--accent,#3E5A47);outline-offset:2px}
.clock{font-variant-numeric:tabular-nums;font-family:var(--font-serif,serif);font-size:22px}
.ag-grid{display:grid;grid-template-columns:340px 1fr;gap:16px;align-items:start}
@media (max-width:900px){.ag-grid{grid-template-columns:1fr}}
.ag-app .card{background:var(--surface,#FFFFFF);border:1px solid var(--line,rgba(34,48,42,.14));border-radius:18px;padding:16px}
.muted{color:var(--text-2,#5C6B61)}
.small{font-size:13px}
.blocks{display:grid;gap:10px}
.ag-app .block{border:1px solid var(--line,rgba(34,48,42,.14));border-left:5px solid var(--k-explore,#4D7699);border-radius:14px;padding:12px 12px 12px 14px;background:var(--surface,#FFFFFF);text-align:left;width:100%;display:grid;gap:6px}
.ag-app .block.sel{box-shadow:0 0 0 2px var(--accent,#3E5A47)}
.ag-app .block .t{font-variant-numeric:tabular-nums;color:var(--text-2,#5C6B61);font-size:13px}
.ag-app .block .ttl{font-size:16px;font-weight:600}
.chips{display:flex;gap:6px;flex-wrap:wrap}
.ag-app .chip{font-size:12px;border-radius:999px;padding:2px 9px;background:var(--paper,#FCFBF6);border:1px solid var(--line,rgba(34,48,42,.14));color:var(--text-2,#5C6B61)}
.ag-app .chip.hi{color:var(--ok,#3F7A55);border-color:var(--ok,#3F7A55)}
.ag-app .chip.mid{color:var(--warn,#B07A36);border-color:var(--warn,#B07A36)}
.ag-app .chip.you{color:var(--you,#E95432);border-color:var(--you,#E95432)}
.ag-app .dot{width:9px;height:9px;border-radius:50%;display:inline-block;background:var(--line,rgba(34,48,42,.14));margin-right:6px;vertical-align:middle}
.ag-app .dot.prep{background:var(--k-explore,#4D7699);animation:agentic-pulse 1.2s infinite}
.ag-app .dot.live{background:var(--k-create,#B07A36);animation:agentic-pulse .8s infinite}
.ag-app .dot.need{background:var(--you,#E95432);animation:agentic-pulse .6s infinite}
.ag-app .dot.ready{background:var(--ok,#3F7A55)}
.ag-app .dot.done{background:var(--deep,#2E4636)}
@keyframes agentic-pulse{50%{transform:scale(1.4);opacity:.55}}
.ag-drawer h2{font-size:20px;margin-bottom:4px}
.conf{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-2,#5C6B61);margin:6px 0 12px}
.conf i{display:block;height:6px;width:120px;border-radius:3px;background:var(--line,rgba(34,48,42,.14));overflow:hidden}
.conf i::after{content:"";display:block;height:100%;width:var(--v,50%);background:var(--accent,#3E5A47)}
.shape{border:1px dashed var(--line,rgba(34,48,42,.14));border-radius:14px;padding:14px;background:var(--paper,#FCFBF6);display:grid;gap:10px;margin-top:2px}
.shape h3{font-size:17px}
.outline{margin:0;padding-left:1.3em;display:grid;gap:6px}
.outline li .q{color:var(--text-2,#5C6B61);font-size:13px}
.kv{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;font-size:14px;margin:0}
.kv dt{color:var(--text-2,#5C6B61)}
.kv dd{margin:0}
table.units{width:100%;border-collapse:collapse;font-size:13px}
table.units th,table.units td{border-bottom:1px solid var(--line,rgba(34,48,42,.14));padding:6px 4px;text-align:left;vertical-align:top}
.ag-app .sample{border:1px solid var(--line,rgba(34,48,42,.14));border-radius:10px;padding:10px 12px;background:var(--surface,#FFFFFF);font-size:13px}
.caveat{font-size:13px;color:var(--warm,#8A5A2B)}
.ag-app .add{background:var(--add,rgba(63,122,85,.14));border-radius:4px}
.ag-app .del{background:var(--del,rgba(165,59,37,.12));text-decoration:line-through;border-radius:4px}
.ag-app .chg{background:var(--chg,rgba(238,240,190,.9));border-radius:4px}
.gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-top:14px}
.ag-app .samp{margin:0;display:grid;gap:6px}
.ag-app .samp figcaption{font-size:12px;color:var(--text-2,#5C6B61)}
.ag-app .frame{position:relative;aspect-ratio:4/3;border-radius:12px;overflow:hidden;border:1px solid var(--line,rgba(34,48,42,.14));background:#fff}
.ag-app .frame img,.ag-app .frame video{width:100%;height:100%;object-fit:cover;display:block}
.ag-app .wm{position:absolute;right:8px;bottom:6px;font-size:11px;color:#fff;background:rgba(0,0,0,.38);border-radius:6px;padding:1px 6px;letter-spacing:.1em}
.ag-app .slide{position:absolute;inset:0;display:grid;grid-template-columns:1.05fr 1fr;background:#F4F7F1;color:#22302A}
.ag-app .slide .txt{padding:9% 7%;display:grid;align-content:start;gap:8px}
.ag-app .slide h4{margin:0;font:600 clamp(13px,2.1vw,18px)/1.3 var(--font-sans,sans-serif);color:#2E4636}
.ag-app .slide .tag{font-size:11px;color:#4F8570;letter-spacing:.08em}
.ag-app .slide ul{margin:6px 0 0;padding-left:1.1em;display:grid;gap:5px;font-size:clamp(11px,1.5vw,13px);line-height:1.45}
.ag-app .slide .pic{background-size:cover;background-position:62% center}
.ag-app .cover{position:absolute;inset:0;display:grid;grid-template-rows:1.2fr 1fr;background:#FCFBF6}
.ag-app .cover .pic{background-size:cover;background-position:center 30%}
.ag-app .cover .meta{padding:6% 7%;display:grid;gap:5px;align-content:start;color:#22302A}
.ag-app .cover .meta b{font:600 clamp(13px,2vw,17px)/1.3 var(--font-serif,serif)}
.ag-app .cover .meta .nums{display:flex;gap:14px;font-size:11px;color:#5C6B61}
.ag-app .cover .meta .nums i{font-style:normal;font:600 18px/1 var(--font-serif,serif);color:#4D7699;display:block}
.ag-app .route{position:absolute;inset:0;background:linear-gradient(160deg,#EEF3EC,#DDE8E0);padding:7%;display:grid;gap:8px;align-content:start;color:#22302A;font-size:13px}
.ag-app .route .line{position:relative;padding-left:18px}
.ag-app .route .line::before{content:"";position:absolute;left:5px;top:6px;width:8px;height:8px;border-radius:50%;background:#B05A4D}
.ag-app .story{margin-top:14px}
.ag-app .story .rail{position:relative;height:128px;border-radius:12px;background:var(--paper,#FCFBF6);border:1px solid var(--line,rgba(34,48,42,.14));overflow:hidden}
.ag-app .story .ev{position:absolute;top:12px;transform:translateX(-50%);display:grid;justify-items:center;gap:3px;width:112px;text-align:center;font-size:12px;white-space:nowrap;transition:opacity .3s,transform .3s}
.ag-app .story .ev .av{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:var(--surface,#FFFFFF);border:1px solid var(--line,rgba(34,48,42,.14));font-size:15px}
.ag-app .story .ev.you .av{border-color:var(--you,#E95432);color:var(--you,#E95432)}
.ag-app .story .ev.lit .av{box-shadow:0 0 0 4px rgba(233,84,50,.18);transform:scale(1.12)}
.ag-app .story .head{position:absolute;top:0;bottom:0;width:2px;background:var(--you,#E95432);left:0}
.ag-app .story .ticks{display:flex;justify-content:space-between;font-size:11px;color:var(--text-2,#5C6B61);padding:4px 2px 0;font-variant-numeric:tabular-nums}
.ag-app .story .narr{display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap}
.ag-app .subtitle{min-height:1.6em;font-size:14px;color:var(--text,#22302A);background:var(--paper,#FCFBF6);border-radius:10px;padding:6px 10px;flex:1}
.ag-app .note{font-size:12px;color:var(--text-2,#5C6B61);margin-top:18px}
.ag-app .hidden{display:none !important}
:root[data-theme="dark"] .ag-app{--bg:#263C32;--surface:#324B40;--text:#F8F7EE;--text-2:#D0DDD2;--line:rgba(248,247,238,.24);--accent:#EEF0BE;--paper:#2B4337;--deep:#152C20;--add:rgba(120,200,150,.18);--del:rgba(240,120,100,.18);--chg:rgba(238,240,190,.22)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .ag-app{--bg:#263C32;--surface:#324B40;--text:#F8F7EE;--text-2:#D0DDD2;--line:rgba(248,247,238,.24);--accent:#EEF0BE;--paper:#2B4337;--deep:#152C20;--add:rgba(120,200,150,.18);--del:rgba(240,120,100,.18);--chg:rgba(238,240,190,.22)}}
:root[data-theme="dark"] .ag-app .btn.primary{color:var(--deep,#152C20)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .ag-app .btn.primary{color:var(--deep,#152C20)}}
@media (prefers-reduced-motion:reduce){.ag-app *,.ag-app *::before,.ag-app *::after{animation:none !important;transition:none !important}}
`;

/** 幂等注入样式；无 DOM 环境（node 纯核）安全返回 false（M06+ 同款） */
export function ensureStyles(doc) {
  if (!doc || typeof doc.createElement !== 'function') return false;
  if (doc.querySelector('style[data-agentic-app]')) return false;
  const st = doc.createElement('style');
  st.setAttribute('data-agentic-app', '');
  st.textContent = APP_CSS;
  const head = doc.head || doc.documentElement;
  if (!head || typeof head.appendChild !== 'function') return false;
  head.appendChild(st);
  return true;
}

/** 页面骨架（prototype L189-239 结构；交互区一律 data-region 槽） */
export function shellHTML() {
  return '<div class="ag-wrap">'
    + '<header class="ag-top"><h1>探戈</h1><span class="sub">Done&amp;Go · 日程到交付 · 演示（数据为演示）</span>'
    + '<span class="spacer"></span><span class="clock" data-region="clock" aria-live="off">13:10</span>'
    + '<button class="btn" type="button" data-app-reel="1">▶ 今日预演</button>'
    + '<span data-region="bell"></span>'
    + '<button class="btn" type="button" data-app-theme="1" aria-label="切换深浅色">◐</button></header>'
    + '<div class="ag-grid"><aside><div class="card">'
    + '<p class="small muted" style="margin-bottom:8px">今天 · 10 月 26 日 周一</p>'
    + '<div class="blocks" data-region="blocks"></div>'
    + '<p class="small muted" style="margin-top:10px">你刚才说：「今天下午两点到三点做一个 AI 教育的深度研究，三点到五点做一个课程设计。」</p>'
    + '</div></aside><main class="card" data-region="drawer"></main></div>'
    + '<section class="card ag-board" data-region="board"></section>'
    + '<p class="note">演示说明：模拟时钟把 13:10–19:00 压缩为约 2 分钟回放；旁白用浏览器语音合成演示（正式版用本地 sherpa-onnx TTS）；所有文字与数据为演示。对应设计见 PRD.md §5。URL 参数：?speed=4&amp;theme=dark&amp;block=c。</p>'
    + '</div>'
    + '<div data-region="inbox" class="hidden"></div>'
    + '<div data-region="reel"></div>';
}

// ---------- DOM 壳：createApp ----------

/** 默认 interval 适配（浏览器/node 同形）：返回取消函数 */
export function defaultMakeTimer(fn, ms) {
  const g = typeof globalThis !== 'undefined' ? globalThis : null;
  const id = g?.setInterval ? g.setInterval(fn, ms) : null;
  return () => { if (id != null && g?.clearInterval) g.clearInterval(id); };
}

/** 默认一次性延时适配 */
export function defaultDelay(fn, ms) {
  const g = typeof globalThis !== 'undefined' ? globalThis : null;
  const id = g?.setTimeout ? g.setTimeout(fn, ms) : null;
  return () => { if (id != null && g?.clearTimeout) g.clearTimeout(id); };
}

const DEFAULT_COMPONENTS = {
  blockCard: blockCardMod, drawer: drawerMod, tiers: tiersMod, sceneCard: sceneCardMod,
  gallery: galleryMod, storyboard: storyboardMod, discuss: discussMod, boundaries: boundariesMod,
  activityFeed: activityFeedMod, acceptance: acceptanceMod, traceView: traceViewMod,
  inbox: inboxMod, board: boardMod, captureCard: captureCardMod, reelPlayer: reelPlayerMod,
};

/**
 * 装配壳（demo.html / 组件页 / 测试 DI）：createApp(root, opts) → handle。
 * opts = { data, params, components, makeTimer, delay, doc, rng }（均可注入，缺省走真实实现）。
 * handle = { el, state(getter), render(), step(), actions, slots }。
 * 增量：壳 HTML 只写一次；此后一切变化经子组件 update(props)（内部 setHTML 内容比对）；
 *   段落串未变时抽屉不重写 → 槽内子组件节点跨 render 保活（PRD §5.2 末教训）。
 */
export function createApp(root, opts = {}) {
  const data = opts.data ?? getData();
  const params = opts.params ?? { speed: 1, theme: '', block: 'r' };
  const C = { ...DEFAULT_COMPONENTS, ...(opts.components ?? {}) };
  const makeTimer = typeof opts.makeTimer === 'function' ? opts.makeTimer : defaultMakeTimer;
  const delay = typeof opts.delay === 'function' ? opts.delay : defaultDelay;
  const rng = typeof opts.rng === 'function' ? opts.rng : defaultRng;
  const doc = opts.doc ?? (root && root.ownerDocument) ?? (typeof document !== 'undefined' ? document : null);
  ensureStyles(doc);
  if (params.theme && doc?.documentElement?.dataset) doc.documentElement.dataset.theme = params.theme;

  let state = initialState(data, params);
  let cursor = 0;
  let timerCancel = null;
  let clockLast = null;
  const slots = {};

  setHTML(root, shellHTML());
  const region = (name) => (typeof root?.querySelector === 'function' ? root.querySelector(`[data-region="${name}"]`) : null);
  const clockEl = region('clock');
  const inboxHost = region('inbox');
  const reelHost = region('reel');

  const actions = {
    select(id) {
      if (!state.blocks.some((b) => b.id === id)) return;
      state = { ...state, sel: id };
      render();
    },
    say(text) {
      state = applySay(state, text, data);
      render();
    },
    sign() {
      state = applySign(state, makeHash(rng()));
      render();
      delay(() => startSim(), SIGN_DELAY_MS);
    },
    revoke() {
      stopTimer();
      state = applyRevoke(state);
      render();
    },
    answer(id, value) {
      state = applyAnswer(state, id, value);
      render();
    },
    accept({ opinion } = {}) {
      void opinion; // 接受无意见（prototype L641 data-acc）
      state = applyAccept(state, state.sel);
      render();
    },
    revise({ opinion } = {}) {
      state = applyRevise(state, state.sel, opinion);
      render();
      drawerH.showTab?.('live'); // prototype L642：要求修改后切到进行中
    },
    reject() {
      // prototype L488 拒绝钮无分支：三操作之一保留位，行为待 PRD 后续定稿
    },
    speedToggle() {
      state = applySpeedToggle(state);
      if (state.running) restartTimer();
      render();
    },
    pauseToggle() {
      state = applyPauseToggle(state);
      render();
    },
    openReel() {
      C.reelPlayer.mount(reelHost, { shots: reelShots(state, data) }); // 重开即重放（prototype openReel 语义）
    },
    startScene(id) {
      state = { ...state, scene: { ...state.scene, [id]: 'gen' } };
      render();
      let p = 0;
      const stop = makeTimer(() => {
        p += SCENE_STEP_PCT;
        slots.scene?.setProgress?.(Math.min(p, 100));
        if (p >= 100) {
          stop();
          state = { ...state, scene: { ...state.scene, [id]: 'ready' } };
          render();
        }
      }, SCENE_STEP_MS);
    },
    capture() {
      state = { ...state, capture: 1 };
      render();
      delay(() => {
        state = { ...state, capture: 2 };
        render();
      }, CAPTURE_DEEP_MS);
    },
    toggleTheme() {
      const de = doc?.documentElement;
      if (!de?.dataset) return;
      de.dataset.theme = de.dataset.theme === 'dark' ? 'light' : 'dark';
    },
    toggleInbox() {
      inboxHost?.classList?.toggle?.('hidden');
    },
    closeInbox() {
      inboxHost?.classList?.add?.('hidden');
    },
  };

  // 五大区挂载（回调就地闭包，组件内零全局）
  const blockH = C.blockCard.mount(region('blocks'), { ...blockListProps(state, data), onSelect: (id) => actions.select(id) });
  const drawerH = C.drawer.mount(region('drawer'), { blockId: state.sel, stage: state.stage, sections: sectionsFor(state, data) });
  const boardH = C.board.mount(region('board'), {
    ...boardProps(state), onPauseAll: () => actions.pauseToggle(), onSpeed: () => actions.speedToggle(),
  });
  const inboxH = C.inbox.mount(inboxHost, {
    ...inboxProps(state), onAnswer: (id, v) => actions.answer(id, v), onClose: () => actions.closeInbox(),
  });
  const bellH = C.inbox.mountBell(region('bell'), { count: bellCount(state), onToggle: () => actions.toggleInbox() });

  // 顶栏按钮（今日预演 / 主题）：root 级委托（壳节点恒定，监听不丢）
  if (typeof root?.addEventListener === 'function') {
    root.addEventListener('click', (e) => {
      const t = e?.target?.closest?.('[data-app-reel],[data-app-theme]');
      if (!t) return;
      if (t.dataset?.appReel !== undefined) actions.openReel();
      else if (t.dataset?.appTheme !== undefined) actions.toggleTheme();
    });
  }

  /** 槽位同步：节点身份在（段未重写）→ update；身份换（段重写/切块）→ 重挂；消失 → 清句柄 */
  function slot(name, mountFn, props) {
    const el = drawerH?.el && typeof drawerH.el.querySelector === 'function'
      ? drawerH.el.querySelector(`[data-slot="${name}"]`)
      : null;
    if (!el) {
      slots[name] = null;
      return;
    }
    if (!slots[name] || slots[name].el !== el) {
      slots[name] = mountFn(el, props);
      return;
    }
    slots[name].update(props);
  }

  function syncSlots() {
    slot('tiers', (el, p) => C.tiers.mount(el, { ...p, onReel: () => actions.openReel(), onScene: (id) => actions.startScene(id) }), tiersProps(state));
    slot('scene', (el, p) => C.sceneCard.mount(el, p), sceneCardProps(state));
    slot('capture', (el, p) => C.captureCard.mount(el, { ...p, onCapture: () => actions.capture() }), { card: captureCardFor(state) });
    slot('story', (el, p) => C.storyboard.mount(el, p), storyboardProps(state, data));
    slot('discuss', (el, p) => C.discuss.mount(el, { ...p, onSay: (t) => actions.say(t) }), discussProps(state, data));
    slot('bound', (el, p) => C.boundaries.mount(el, { ...p, onSign: () => actions.sign(), onRevoke: () => actions.revoke() }), boundariesProps(state, data));
    slot('live', (el, p) => C.activityFeed.mount(el, p), feedProps(state, data));
    slot('art', (el, p) => C.acceptance.mount(el, {
      ...p, onAccept: (o) => actions.accept(o), onRevise: (o) => actions.revise(o), onReject: () => actions.reject(),
    }), acceptanceProps(state, data));
    slot('trace', (el, p) => C.traceView.mount(el, p), traceProps(state, data));
  }

  /** 全量同步：state → 各组件 props（子组件内部 setHTML 内容比对，未变零写） */
  function render() {
    drawerH.update({ blockId: state.sel, stage: state.stage, sections: sectionsFor(state, data) });
    syncSlots();
    blockH.update(blockListProps(state, data));
    boardH.update(boardProps(state));
    inboxH.update(inboxProps(state));
    bellH.update({ count: bellCount(state) });
    if (clockEl && clockLast !== state.sim) {
      clockLast = state.sim;
      clockEl.textContent = clockText(state);
    }
  }

  function stopTimer() {
    if (timerCancel) {
      timerCancel();
      timerCancel = null;
    }
  }

  function restartTimer() {
    stopTimer();
    timerCancel = makeTimer(() => step(), Math.round(TICK_MS_BASE / state.speed));
  }

  function startSim() {
    state = { ...state, running: true, stage: 'run' };
    restartTimer();
    render();
  }

  /** 一拍模拟时钟 + 全量同步（定时器回调 / 测试手动驱动共用） */
  function step() {
    const out = tick(state, data.script, cursor);
    state = out.state;
    cursor = out.cursor;
    if (!state.running) stopTimer();
    render();
  }

  render();
  return {
    el: root,
    get state() { return state; },
    render,
    step,
    actions,
    slots,
  };
}

/** demo.html 引导：解析 location.search 参数后装配 */
export function boot(root, opts = {}) {
  const win = opts.win ?? (typeof window !== 'undefined' ? window : undefined);
  const params = opts.params ?? parseParams(win?.location?.search ?? '');
  return createApp(root, { ...opts, params });
}

// 自动引导：页面存在 #ag-app 宿主时装配（node 无 document，安全跳过）
const bootEl = typeof document !== 'undefined' && typeof document.getElementById === 'function'
  ? document.getElementById('ag-app')
  : null;
if (bootEl) boot(bootEl);
