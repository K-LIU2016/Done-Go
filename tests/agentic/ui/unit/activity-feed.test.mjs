// M12 活动流（可展开「为什么」）单测（RED 先行 · 实现前必红）
// 依据：plan.md M12、PRD §5.4（L291 故事层：按时间排列活动流，每条可展开看依据；
//   顶部是该块的 agent 树与花费表）、§10.6（L810-812：条目必须能回答做了什么/为什么/
//   产出在哪，不能回答的不展示；花费按块汇总显示"免费"）+ §5.2 末「原型实测教训」
//   （L275：整块重绘会让展开的"为什么"被收起——本组件增量硬约束来源）；
//   prototype.html（唯一视觉标准）L117-124（.feed/.it/.it.new(rise)/time/details/.why/
//   .cost 样式原文）、L185（reduced-motion 全局禁动画）、L342+L475（statusText 等待开始
//   兜底/agent 无→「无」）、L471-477（renderLive：未签约空态文案 / cost 三 span（agent：… ·
//   模型调用 N 次 · 免费 · 状态）/ items 反序渲染 i===0 加 new / why 用 details>summary+
//   .why「为什么：…」/ 空列表「还没开始。」/ max-height 360 滚动）。
// 契约：web/agentic/ui/activity-feed.js 具名导出
//   FEED_EMPTY_TEXT / FEED_IDLE_TEXT / COST_AGENTS_NONE / COST_STATUS_IDLE /
//   normalizeCost / normalizeItem / normalizeItems / itemKey / costInner / itemInner /
//   rowHTML / feedRowsHTML / liveShellHTML / unsignedHTML / idleHTML /
//   ACTIVITY_CSS / ensureStyles / mount(el, { signed, cost, items }) → { el, update(props) }
//   items: { t, icon, text, why? }[]（按时间正序给入，渲染最新在前）；cost: { agents,
//   calls, status }。条目身份键 = t+\u0001+text（why/icon 只是内容——why 变了是对同一行
//   节点补丁，不新增行、不重排）；增量硬约束：壳（.cost+.feed）只写一次，追加条目只
//   prepend 新行，旧行节点/顺序/属性/展开态全保留（spec data-marker 断言的 node 等价），
//   .new 只在最新一条并在追加时转移。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FEED_EMPTY_TEXT, FEED_IDLE_TEXT, COST_AGENTS_NONE, COST_STATUS_IDLE,
  normalizeCost, normalizeItem, normalizeItems, itemKey,
  costInner, itemInner, rowHTML, feedRowsHTML,
  liveShellHTML, unsignedHTML, idleHTML,
  ACTIVITY_CSS, ensureStyles, mount,
} from '../../../../web/agentic/ui/activity-feed.js';

const COST = { agents: '研究员 ×3 · 写作者 · 校对员', calls: 24, status: '进行中' };
const ITEMS = [
  { t: '13:30', icon: '🔎', text: '研究员 ×3 开始检索', why: '合同允许提前 30 分钟准备；三路并行去重后合并' },
  { t: '13:44', icon: '🗂', text: '找到 23 个来源，保留 9 个', why: '规则：2024 年以前的政策文件仅作背景' },
  { t: '14:05', icon: '✍️', text: '写作者开始合成第 1–5 节' },
];
const APPEND = { t: '14:30', icon: '🧪', text: '校对员核验引用', why: '验证与写作使用不同模型' };
const KEY_SEP = '\u0001';  // 身份键分隔符（itemKey 契约）

// ---------- A. 纯核：常量与归一 ----------

test('M12 常量：空态/未开始/兜底文案照 prototype L474/L476/L475 原文', () => {
  assert.equal(FEED_EMPTY_TEXT, '签约后，这里会实时显示每个 agent 在做什么、为什么、产出在哪。');
  assert.equal(FEED_IDLE_TEXT, '还没开始。');
  assert.equal(COST_AGENTS_NONE, '无');
  assert.equal(COST_STATUS_IDLE, '等待开始');
});

test('M12 normalizeCost：对象取三字段（calls 归非负整数）；null/缺省/标量一律 null', () => {
  assert.deepEqual(normalizeCost(COST), { agents: '研究员 ×3 · 写作者 · 校对员', calls: 24, status: '进行中' });
  assert.equal(normalizeCost(null), null);
  assert.equal(normalizeCost(undefined), null);
  assert.equal(normalizeCost('研究员 ×3'), null, '字符串不是 cost');
  assert.equal(normalizeCost([]), null, '数组不是 cost');
  assert.equal(normalizeCost(24), null);
});

test('M12 normalizeCost：缺省/非法字段兜底（agents→无 L475、status→等待开始 L342/L475、calls→0）', () => {
  assert.deepEqual(normalizeCost({}), { agents: '无', calls: 0, status: '等待开始' });
  assert.deepEqual(
    normalizeCost({ agents: '  向导 · 路线  ', calls: '12', status: '  ' }),
    { agents: '向导 · 路线', calls: 12, status: '等待开始' }, '字符串数字收、空白状态兜底、trim',
  );
  assert.equal(normalizeCost({ calls: -5 }).calls, 0, '负数归 0');
  assert.equal(normalizeCost({ calls: 9.9 }).calls, 9, '小数取整');
  assert.equal(normalizeCost({ calls: 'x' }).calls, 0, '非数字归 0');
  assert.equal(normalizeCost({ agents: 42 }).agents, '无', '非字符串 agents 兜底');
});

test('M12 normalizeItem：对象取四字段（t/text 必填非空，why 缺省空串）；无效条目 null（§10.6 不展示）', () => {
  assert.deepEqual(normalizeItem(ITEMS[0]), ITEMS[0]);
  assert.deepEqual(normalizeItem({ t: '14:05', text: '写作者开始合成' }), { t: '14:05', icon: '', text: '写作者开始合成', why: '' });
  assert.deepEqual(normalizeItem({ t: ' 13:30 ', icon: ' 🔎 ', text: ' 检索 ', why: ' 依据 ' }),
    { t: '13:30', icon: '🔎', text: '检索', why: '依据' }, '四字段 trim');
  assert.equal(normalizeItem(null), null);
  assert.equal(normalizeItem(undefined), null);
  assert.equal(normalizeItem('找到 23 个来源'), null);
  assert.equal(normalizeItem({ t: '13:30' }), null, '缺 text');
  assert.equal(normalizeItem({ text: '检索' }), null, '缺 t');
  assert.equal(normalizeItem({ t: '  ', text: '检索' }), null, '空白 t 无效');
});

test('M12 normalizeItems：数组过滤无效项保持顺序；非数组归空', () => {
  const FILLED = ITEMS.map((it) => ({ ...it, why: it.why ?? '' })); // 归一统一补 why:''
  assert.deepEqual(normalizeItems(ITEMS), FILLED);
  assert.deepEqual(normalizeItems([...ITEMS, null, { t: 'x' }, 42]), FILLED, '无效项剔除');
  assert.deepEqual(normalizeItems([]), []);
  assert.deepEqual(normalizeItems(undefined), []);
  assert.deepEqual(normalizeItems(null), []);
  assert.deepEqual(normalizeItems({ 0: ITEMS[0], length: 1 }), [], '类数组不收');
});

test('M12 itemKey：身份键 = t+分隔+text（why/icon 不参与——why 变是补丁不是新行）', () => {
  assert.equal(itemKey(ITEMS[0]), `13:30${KEY_SEP}研究员 ×3 开始检索`);
  assert.equal(
    itemKey({ t: '13:30', icon: '🔎', text: '研究员 ×3 开始检索', why: '别的依据' }),
    itemKey({ t: '13:30', icon: '🧭', text: '研究员 ×3 开始检索', why: '' }),
    'why/icon 不同同键',
  );
  assert.notEqual(itemKey(ITEMS[0]), itemKey(ITEMS[1]));
  assert.notEqual(itemKey(ITEMS[0]), itemKey({ ...ITEMS[0], text: '另一次检索' }), 'text 另起一行');
});

// ---------- B. 纯核：结构 HTML（prototype L475-476 原文结构） ----------

test('M12 costInner：null→空串；三 span 原文（agent：/模型调用 N 次 · 免费/状态）', () => {
  assert.equal(costInner(null), '');
  assert.equal(costInner(undefined), '');
  const html = costInner(COST);
  assert.ok(html.includes('<span>agent：研究员 ×3 · 写作者 · 校对员</span>'), 'agent 组成（L475）');
  assert.ok(html.includes('<span>模型调用 24 次 · 免费</span>'), '调用数 + 免费汇总（§10.6 L812）');
  assert.ok(html.includes('<span>进行中</span>'), '状态（L342 statusText）');
  assert.ok(html.startsWith('<span>') && /<\/span>\s*$/.test(html), '无多余包裹');
});

test('M12 costInner 转义：agents/status 注入串不得存活（M01 XSS 基线）', () => {
  const html = costInner({ agents: '<img src=x onerror=1>', calls: 1, status: '<script>' });
  assert.ok(!html.includes('<img'), 'img 不得存活');
  assert.ok(!html.includes('<script>'), 'script 不得存活');
  assert.ok(html.includes('agent：&lt;img src=x onerror=1&gt;'));
});

test('M12 itemInner：无 why → 纯文本 time+icon+cell（prototype L476 else 分支）', () => {
  const html = itemInner({ t: '14:05', icon: '✍️', text: '写作者开始合成第 1–5 节', why: '' });
  assert.equal(html, '<time>14:05</time><span>✍️</span><div>写作者开始合成第 1–5 节</div>');
  assert.ok(!html.includes('details'), '无依据不展开');
});

test('M12 itemInner：有 why → details>summary(text)+.why「为什么：…」（prototype L121/L476 原文）', () => {
  const html = itemInner(ITEMS[0]);
  assert.ok(html.startsWith('<time>13:30</time><span>🔎</span><div>'));
  assert.ok(html.includes('<details><summary>研究员 ×3 开始检索</summary>'));
  assert.ok(html.includes('<div class="why">为什么：合同允许提前 30 分钟准备；三路并行去重后合并</div>'));
  assert.ok(html.endsWith('</details></div>'));
});

test('M12 itemInner 转义：text/why/icon/t 四路 esc（XSS 基线）', () => {
  const html = itemInner({ t: '13:00"', icon: '<b>', text: '<script>x</script>', why: '<img src=x onerror=1>' });
  assert.ok(!html.includes('<script>'), 'script 破坏');
  assert.ok(!html.includes('<img'), 'img 破坏');
  assert.ok(!html.includes('<b>'), 'icon 转义');
  assert.ok(html.includes('<time>13:00&quot;</time>'), 't 转义');
  assert.ok(html.includes('&lt;script&gt;x&lt;/script&gt;'));
});

test('M12 rowHTML：.it[.new] + data-k 身份键（esc）；itemInner 组装', () => {
  const plain = rowHTML(ITEMS[2], false);
  assert.ok(plain.startsWith('<div class="it" data-k="'));
  assert.ok(plain.includes(`>${itemInner(ITEMS[2])}</div>`));
  const fresh = rowHTML(ITEMS[2], true);
  assert.ok(fresh.startsWith('<div class="it new" data-k="'), '最新条加 new（L476 i===0）');
  const evil = rowHTML({ t: '13:30', icon: '', text: '"><script>alert(1)</script>', why: '' }, false);
  assert.ok(!evil.includes('"><script>'), 'data-k 属性注入破坏');
  assert.ok(evil.includes(`data-k="13:30${KEY_SEP}&quot;&gt;&lt;script&gt;`), '键含分隔符也全转义');
});

test('M12 feedRowsHTML：反序（最新在前）且 .new 只给第一条；空/缺省 → 空串', () => {
  const html = feedRowsHTML(ITEMS);
  assert.ok(html.startsWith(`<div class="it new" data-k="${itemKey(ITEMS[2])}">`), '最新（14:05）在前且带 new');
  assert.ok(html.includes(`data-k="${itemKey(ITEMS[1])}"`) && html.includes(`data-k="${itemKey(ITEMS[0])}"`));
  assert.equal((html.match(/class="it new"/g) ?? []).length, 1, '仅一条 new（DAG M12）');
  assert.ok(html.indexOf(itemKey(ITEMS[2])) < html.indexOf(itemKey(ITEMS[1])), '倒序渲染（L476 slice().reverse()）');
  assert.equal(feedRowsHTML([]), '');
  assert.equal(feedRowsHTML(undefined), '');
  assert.equal(feedRowsHTML([null, { t: 'x' }]), '', '全无效项归空');
});

test('M12 壳三件：liveShellHTML（.cost+.feed 空壳）/ unsignedHTML / idleHTML 原文', () => {
  assert.equal(liveShellHTML(), '<div class="cost"></div><div class="feed"></div>');
  assert.equal(unsignedHTML(), `<p class="muted">${FEED_EMPTY_TEXT}</p>`, 'prototype L474 原文');
  assert.equal(idleHTML(), `<p class="small muted">${FEED_IDLE_TEXT}</p>`, 'prototype L476 原文');
});

// ---------- C. 纯核：CSS（prototype L117-124 原文 + rm 降级） ----------

test('M12 ACTIVITY_CSS：.feed/.it/.new(rise)/time/details/.why/.cost 原文 + max-height 360', () => {
  assert.ok(ACTIVITY_CSS.includes('.feed {'), '容器');
  assert.ok(ACTIVITY_CSS.includes('max-height: 360px'), '滚动上限（plan M12）');
  assert.ok(ACTIVITY_CSS.includes('overflow: auto'));
  assert.ok(ACTIVITY_CSS.includes('.feed .it {') && ACTIVITY_CSS.includes('grid-template-columns: 48px 24px 1fr'), '三列行（L118）');
  assert.ok(/\.feed \.it\.new\s*{[^}]*animation:\s*rise \.25s ease-out/.test(ACTIVITY_CSS), '最新条 rise 入场（L119）');
  assert.ok(ACTIVITY_CSS.includes('@keyframes rise'), '关键帧（L123）');
  assert.ok(ACTIVITY_CSS.includes('.feed .it time') && ACTIVITY_CSS.includes('tabular-nums'), '时间列（L120）');
  assert.ok(ACTIVITY_CSS.includes('.feed .it details summary') && ACTIVITY_CSS.includes('cursor: pointer'), 'summary 手型（L121）');
  assert.ok(ACTIVITY_CSS.includes('.feed .it .why'), '为什么正文（L122）');
  assert.ok(ACTIVITY_CSS.includes('.cost {') && ACTIVITY_CSS.includes('flex-wrap: wrap'), 'cost 行（L124）');
});

test('M12 ACTIVITY_CSS：reduced-motion 降级 animation:none（prototype L185；spec rm 断言依据）', () => {
  assert.ok(ACTIVITY_CSS.includes('prefers-reduced-motion'));
  assert.ok(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation:\s*none/.test(ACTIVITY_CSS), '动画禁用（.it.new rise 也被压掉）');
});

test('M12 ensureStyles：幂等注入 + 无 DOM 环境安全（M06/M07/M10 同款桩）', () => {
  const mkDoc = (tag) => {
    const doc = { _styles: [] };
    doc.querySelector = (sel) => (sel === `style[${tag}]` ? doc._styles[0] ?? null : null);
    doc.createElement = () => ({ _attrs: {}, textContent: '', setAttribute(k, v) { this._attrs[k] = String(v); } });
    doc.head = { appendChild: (n) => doc._styles.push(n) };
    return doc;
  };
  const doc = mkDoc('data-agentic-activity');
  assert.equal(ensureStyles(doc), true);
  assert.equal(doc._styles.length, 1);
  assert.ok(doc._styles[0].textContent.includes('.feed'));
  assert.equal(ensureStyles(doc), false, '已注入不再重复');
  assert.equal(ensureStyles(null), false);
});

// ---------- D. 壳：mount/update（fake-DOM 桩，白盒同 M10 模式） ----------

/** 行桩：dataset.k / className / innerHTML 写计数 / remove */
function mkRow(cls, k, inner, zone) {
  return {
    dataset: { k }, className: cls, _h: undefined, _v: inner, writes: 0, removed: false,
    get innerHTML() { return this._v; },
    set innerHTML(v) { this.writes += 1; this._v = v; },
    remove() { this.removed = true; const i = zone.rows.indexOf(this); if (i >= 0) zone.rows.splice(i, 1); },
  };
}

const UNESC = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const unesc = (s) => String(s).replace(/&(amp|lt|gt|quot|#39);/g, (m) => UNESC[m]);

/** 从一批行 HTML 解析行桩（按 <div 深度配平切行；key 反解 esc） */
function parseRows(html, zone) {
  const rows = [];
  const open = /<div class="(it[^"]*)" data-k="([^"]*)">/g;
  let m;
  while ((m = open.exec(html))) {
    const tag = /<div\b|<\/div>/g;
    tag.lastIndex = open.lastIndex;
    let depth = 1; let end = html.length; let t;
    while ((t = tag.exec(html))) {
      if (t[0] === '</div>') { depth -= 1; if (depth === 0) { end = t.index; break; } } else depth += 1;
    }
    rows.push(mkRow(m[1], unesc(m[2]), html.slice(open.lastIndex, end), zone));
    open.lastIndex = end + '</div>'.length;
  }
  return rows;
}

/** 宿主桩：innerHTML 写即模拟浏览器重解析（.cost/.feed 重建、行清空）；行经 insertAdjacentHTML */
function stubActivityHost() {
  const cost = { _h: undefined, _v: '', writes: 0, get innerHTML() { return this._v; }, set innerHTML(v) { this.writes += 1; this._v = v; } };
  const feed = {
    _h: undefined, idle: '', rows: [], inserts: [],
    get innerHTML() { return this.idle; },
    set innerHTML(v) { this.idle = v; this.rows = []; },
    querySelectorAll(sel) { return sel === '.it' ? this.rows.slice() : []; },
    insertAdjacentHTML(pos, html) {
      this.inserts.push({ pos, html });
      if (pos === 'afterbegin') { this.idle = ''; this.rows = parseRows(html, this).concat(this.rows); }
    },
  };
  const host = {
    _h: undefined, _v: '', writes: 0,
    get innerHTML() { return this._v; },
    set innerHTML(v) {
      this.writes += 1; this._v = v;
      feed.rows = []; feed.idle = ''; feed._h = undefined; // 壳重写 = 子树重建（浏览器语义）
      cost._h = undefined; cost._v = '';
    },
    querySelector(sel) { if (sel === '.cost') return cost; if (sel === '.feed') return feed; return null; },
  };
  return { host, cost, feed };
}

const newCount = (feed) => feed.rows.filter((r) => /(^|\s)new(\s|$)/.test(r.className)).length;

test('M12 mount：未签约 → 只出空态文案（prototype L474），零 cost/feed 使用', () => {
  const { host, cost, feed } = stubActivityHost();
  mount(host, { signed: false, cost: COST, items: ITEMS });
  assert.equal(host.writes, 1, '一次写');
  assert.ok(host.innerHTML.includes('签约后，这里会实时显示'));
  assert.ok(!host.innerHTML.includes('cost') && !host.innerHTML.includes('feed'));
  assert.equal(cost.writes, 0);
  assert.equal(feed.inserts.length, 0);
});

test('M12 mount：签约首绘 = 壳一次 + cost 一次 + 行一批 prepend（倒序、仅首条 new）', () => {
  const { host, cost, feed } = stubActivityHost();
  const handle = mount(host, { signed: true, cost: COST, items: ITEMS });
  assert.equal(host.writes, 1, '壳只写一次（增量基石）');
  assert.ok(host.innerHTML.includes('<div class="cost"></div><div class="feed"></div>'));
  assert.equal(cost.writes, 1);
  assert.ok(cost.innerHTML.includes('模型调用 24 次 · 免费'));
  assert.equal(feed.inserts.length, 1, '首批行一次 prepend');
  assert.equal(feed.rows.length, 3);
  assert.deepEqual(feed.rows.map((r) => r.dataset.k), [itemKey(ITEMS[2]), itemKey(ITEMS[1]), itemKey(ITEMS[0])], '最新在前（L476 反序）');
  assert.equal(newCount(feed), 1, '仅最新一条 new');
  assert.ok(feed.rows[0].className.includes('new'));
  assert.equal(handle.el, host);
  assert.equal(typeof handle.update, 'function');
});

test('M12 mount：签约但条目空 → .feed 出「还没开始。」（prototype L476 空列表分支）', () => {
  const { host, feed } = stubActivityHost();
  mount(host, { signed: true, cost: COST, items: [] });
  assert.equal(feed.innerHTML, '<p class="small muted">还没开始。</p>');
  assert.equal(feed.rows.length, 0);
});

test('M12 追加：旧行节点零重写不重排（spec data-marker 的 node 等价）、.new 转移', () => {
  const { host, cost, feed } = stubActivityHost();
  const handle = mount(host, { signed: true, cost: COST, items: ITEMS });
  feed.rows.forEach((r, i) => { r.marker = `keep-${i}`; });
  handle.update({ items: [...ITEMS, APPEND] });
  assert.equal(feed.rows.length, 4, '4 行');
  assert.equal(feed.rows[0].dataset.k, itemKey(APPEND), '新条目在顶');
  assert.equal(newCount(feed), 1, '.new 唯一');
  assert.ok(feed.rows[0].className.includes('new'), '.new 转移到新最新');
  assert.equal(feed.rows[1].className, 'it', '原最新条退 new');
  assert.equal(cost.writes, 1, 'cost 未变零写');
  assert.equal(host.writes, 1, '壳未重写');
  assert.deepEqual(feed.rows.slice(1).map((r) => r.marker), ['keep-0', 'keep-1', 'keep-2'], '旧行对象身份保留 = 不重排不重建');
  assert.ok(feed.rows.slice(1).every((r) => r.writes === 0), '旧行 innerHTML 零写（展开态/属性全保留）');
  assert.equal(feed.rows[3].dataset.k, itemKey(ITEMS[0]), '最旧仍在最后');
});

test('M12 追加（spec 场景）：旧条目 why 有微调 → 同键补丁同节点，不增行', () => {
  const { host, feed } = stubActivityHost();
  const handle = mount(host, { signed: true, cost: COST, items: ITEMS });
  const before = feed.rows.slice();
  const tweaked = [
    { t: '13:30', icon: '🔎', text: '研究员 ×3 开始检索', why: '合同允许提前 30 分钟准备' },
    { t: '13:44', icon: '🗂', text: '找到 23 个来源，保留 9 个' },
    { t: '14:05', icon: '✍️', text: '写作者开始合成第 1–5 节' },
    APPEND,
  ];
  handle.update({ items: tweaked });
  assert.equal(feed.rows.length, 4, 'spec 断言：4 行（同键不重复建行）');
  assert.equal(feed.rows[3], before[2], '13:30 行节点身份不变（仅内容补丁）');
  assert.equal(feed.rows[3].writes, 1, 'why 变了 → 该行补丁一次');
  assert.ok(feed.rows[3].innerHTML.includes('为什么：合同允许提前 30 分钟准备</div>'), 'why 更新生效');
  assert.equal(feed.rows[2], before[1], '13:44 行节点不变');
  assert.equal(feed.rows[2].writes, 1, 'why 移除 → 补丁一次');
  assert.ok(!feed.rows[2].innerHTML.includes('details'), 'why 空后降级纯文本');
  assert.equal(feed.rows[1], before[0], '14:05 行节点不变');
  assert.equal(feed.rows[1].writes, 0, '内容未变零写');
  assert.equal(host.writes, 1, '壳未重写');
});

test('M12 update({cost})：只打 cost 区；壳/行零写；显式 null 清空', () => {
  const { host, cost, feed } = stubActivityHost();
  const handle = mount(host, { signed: true, cost: COST, items: ITEMS });
  const feedRows = feed.rows.slice();
  handle.update({ cost: { agents: '规划者 · 设计者 · 校对员', calls: 60, status: '待验收' } });
  assert.equal(cost.writes, 2, 'cost 补丁一次');
  assert.ok(cost.innerHTML.includes('规划者 · 设计者 · 校对员') && cost.innerHTML.includes('模型调用 60 次'));
  assert.equal(host.writes, 1, '壳不重写');
  assert.deepEqual(feed.rows, feedRows, '行不动');
  handle.update({ cost: null });
  assert.equal(cost.writes, 3, '显式 null 清空 cost 区');
  assert.equal(cost.innerHTML, '');
});

test('M12 同内容 update 零写；undefined/空对象链式安全', () => {
  const { host, cost, feed } = stubActivityHost();
  const handle = mount(host, { signed: true, cost: COST, items: ITEMS });
  const snapshot = { host: host.writes, cost: cost.writes, rows: feed.rows.map((r) => r.writes) };
  const ret = handle.update({}).update(undefined);
  assert.equal(typeof ret.update, 'function', '链式返回 handle');
  assert.equal(host.writes, snapshot.host);
  assert.equal(cost.writes, snapshot.cost);
  assert.deepEqual(feed.rows.map((r) => r.writes), snapshot.rows, '行零写');
});

test('M12 未传键不动旧值：update({items}) 不动 cost；update({}) 保留 items', () => {
  const { host, cost, feed } = stubActivityHost();
  const handle = mount(host, { signed: true, cost: COST, items: ITEMS });
  handle.update({ items: [...ITEMS, APPEND] });
  assert.equal(cost.writes, 1, 'cost 未传不动');
  handle.update({});
  assert.equal(feed.rows.length, 4, 'items 保留');
  handle.update({ items: 'bogus' });
  assert.equal(feed.rows.length, 0, '非法 items 归空 = 显式清空（同 M10 examples 语义）');
  assert.ok(feed.innerHTML.includes('还没开始'), '清空回 idle');
});

test('M12 条目删除：items 收缩 → 对应行 remove，其余行原序不动', () => {
  const { host, feed } = stubActivityHost();
  const handle = mount(host, { signed: true, cost: COST, items: ITEMS });
  const removedRow = feed.rows[1]; // 13:44
  const kept = feed.rows[2]; // 13:30 最旧
  handle.update({ items: [ITEMS[0], ITEMS[2]] }); // 13:44 被移除
  assert.ok(removedRow.removed, '13:44 行被 remove');
  assert.equal(feed.rows.length, 2);
  assert.deepEqual(feed.rows.map((r) => r.dataset.k), [itemKey(ITEMS[2]), itemKey(ITEMS[0])], '剩余行 DOM 原序不动');
  assert.equal(feed.rows[1], kept, '未涉及行节点不变');
});

test('M12 空列表 → 来条目：idle 文案被清、行进 feed；再清空回 idle', () => {
  const { host, feed } = stubActivityHost();
  const handle = mount(host, { signed: true, cost: COST, items: [] });
  assert.ok(feed.innerHTML.includes('还没开始'));
  handle.update({ items: ITEMS });
  assert.equal(feed.rows.length, 3);
  assert.equal(feed.innerHTML, '', 'idle 清空');
  handle.update({ items: [] });
  assert.ok(feed.innerHTML.includes('还没开始'), '回到 idle');
  assert.equal(feed.rows.length, 0);
});

test('M12 签约态切换：signed→false 出空态并清行缓存；再签约全量重绘', () => {
  const { host, cost, feed } = stubActivityHost();
  const handle = mount(host, { signed: true, cost: COST, items: ITEMS });
  handle.update({ signed: false });
  assert.equal(host.writes, 2, '壳重写为空态');
  assert.ok(host.innerHTML.includes('签约后'));
  handle.update({ signed: true, items: ITEMS });
  assert.equal(host.writes, 3, '重签约壳重绘');
  assert.equal(feed.rows.length, 3);
  assert.equal(cost.writes, 2, 'cost 重绘一次');
  handle.update({}); // 同内容零写
  assert.equal(host.writes, 3);
});

test('M12 宿主缺 querySelector/insertAdjacentHTML 或 el=null：mount/update 不抛', () => {
  const bare = { _h: undefined, _v: '', writes: 0, get innerHTML() { return this._v; }, set innerHTML(v) { this.writes += 1; this._v = v; } };
  const handle = mount(bare, { signed: true, cost: COST, items: ITEMS });
  assert.equal(bare.writes, 1, '壳仍首绘');
  handle.update({ items: [...ITEMS, APPEND] }); // 无子区：安全跳过
  assert.equal(bare.writes, 1, '壳不重写');
  const headless = mount(null, {});
  assert.equal(typeof headless.update, 'function');
  headless.update({ signed: true, items: ITEMS }); // 不抛
});
