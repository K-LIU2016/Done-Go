#!/usr/bin/env node
// scripts/intent-eval.mjs — 意图理解评测（SPEC §6）。
// 用法：
//   node scripts/intent-eval.mjs [--set tests/voice/intent-eval.jsonl] [--mode rule|llm] [--verbose] [--json]
//     --mode rule（默认）只跑规则草稿（无网络，本线已完成基线评测）
//     --mode llm 走 analyzeIntent（需 TANGO_AI_* 环境变量；真实快速模型评测在夜窗屏障后执行）
// 指标（与 SPEC §6 阈值对应，阈值针对真实快速模型；规则基线仅作对照）：
//   事项数量准确率 ≥95% / 日期和时间准确率 ≥92% / 优先级准确率 ≥90% / 无编造率 100%（模糊时间不给具体时刻）
//   规则草稿延迟 p95 < 50ms
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ruleDraft, applyRuleEdit, analyzeIntent } from './intent.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const SET = flag('set', 'tests/voice/intent-eval.jsonl');
const MODE = flag('mode', 'rule');
const VERBOSE = args.includes('--verbose');
const JSON_OUT = args.includes('--json');

const lines = readFileSync(resolve(here, '..', SET), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
const cases = lines.map((l, idx) => {
  const c = JSON.parse(l);
  if (!c.id || !c.transcript || !c.now || !c.tz || !c.expect) throw new Error(`第 ${idx + 1} 行缺字段: ${l.slice(0, 60)}`);
  return c;
});
if (cases.length < 80) {
  console.error(`评测集只有 ${cases.length} 条，不满足 SPEC §6 的 ≥80 条`);
  process.exit(1);
}

// 类别覆盖检查：SPEC §2.3 九类难例每类 ≥6 条
const CATEGORY_MIN = {
  'multi-event': 6, 'relative-date': 6, 'time-expr': 6, 'retraction': 6, 'filler-asr': 6,
  'deadline-recurrence': 6, 'priority': 6, 'no-fabrication': 6, 'anti-injection': 6,
};
const byCat = {};
for (const c of cases) byCat[c.category] = (byCat[c.category] || 0) + 1;
const catGaps = Object.entries(CATEGORY_MIN).filter(([k, min]) => (byCat[k] || 0) < min);
if (catGaps.length) {
  console.error('九类难例覆盖不足: ' + catGaps.map(([k, min]) => `${k}=${byCat[k] || 0}<${min}`).join(', '));
  process.exit(1);
}

const TIME_FIELDS = ['date', 'start', 'end', 'durationMin', 'deadline'];
const tagList = (items, fields) => items.flatMap((it) => fields.filter((f) => it[f] != null).map((f) => `${f}=${it[f]}`)).sort();
const hasAny = (items, fields) => items.some((it) => fields.some((f) => it[f] != null));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function runCase(c) {
  const input = { transcript: c.transcript, now: c.now, tz: c.tz, ...(Array.isArray(c.edit) ? { edit: c.edit } : {}) };
  const t0 = performance.now();
  let r;
  if (MODE === 'llm') r = await analyzeIntent(input, {});
  else r = Array.isArray(c.edit) ? applyRuleEdit(input) : ruleDraft(input);
  const ms = performance.now() - t0;
  // analyzeIntent 的契约输出在 .final（{draft, final, llm}）；规则引擎（ruleDraft/applyRuleEdit）才是 .value
  return { got: r.ok ? (MODE === 'llm' ? r.final : r.value) : null, error: r.ok ? null : `${r.code || r.field}: ${r.message || ''}`, ms };
}

function score(c, got) {
  const exp = c.expect;
  const gotItems = got ? got.items : [];
  const expItems = exp.items || [];
  const s = {};
  s.count = !!got && gotItems.length === exp.count &&
    (exp.nonEvent ? got.nonEvent != null : got.nonEvent == null);
  // 日期（date+deadline 合并多重集）
  const dateEligible = hasAny(expItems, ['date', 'deadline']);
  if (dateEligible) s.date = eq(tagList(gotItems, ['date', 'deadline']), tagList(expItems, ['date', 'deadline']));
  // 时间（start/end/durationMin）
  const timeEligible = hasAny(expItems, ['start', 'end', 'durationMin']);
  if (timeEligible) s.time = eq(tagList(gotItems, ['start', 'end', 'durationMin']), tagList(expItems, ['start', 'end', 'durationMin']));
  // 优先级（多重集）
  const prioEligible = exp.count > 0 && expItems.some((it) => Number.isInteger(it.priority));
  if (prioEligible) {
    const gp = gotItems.map((i) => i.priority).sort();
    const ep = expItems.filter((it) => Number.isInteger(it.priority)).map((it) => it.priority).sort();
    s.priority = eq(gp, ep);
  }
  // 无编造：got 的非空时间字段值必须都在期望值域内（含模糊时间不给具体时刻）
  if (exp.count > 0) {
    s.noFabrication = TIME_FIELDS.every((f) => {
      const allowed = new Set(expItems.filter((it) => it[f] != null).map((it) => `${f}=${it[f]}`));
      return gotItems.every((it) => it[f] == null || allowed.has(`${f}=${it[f]}`));
    });
  }
  // recurrence（对照指标）
  const recEligible = expItems.some((it) => it.recurrence);
  if (recEligible) s.recurrence = eq(tagList(gotItems, ['recurrence']), tagList(expItems, ['recurrence']));
  // 标题关键词（对照指标，乱序贪心匹配）
  const wants = expItems.filter((it) => it.titleIncludes).map((it) => it.titleIncludes);
  if (wants.length) {
    const pool = gotItems.map((i) => i.title);
    let ok = wants.length <= pool.length;
    for (const w of wants) {
      const i = pool.findIndex((t) => t && t.includes(w));
      if (i < 0) { ok = false; break; }
      pool.splice(i, 1);
    }
    s.title = ok;
  }
  return { s, dateEligible, timeEligible, prioEligible, recEligible };
}

const results = [];
for (const c of cases) {
  const { got, error, ms } = await runCase(c);
  const { s, dateEligible, timeEligible, prioEligible, recEligible } = score(c, got);
  results.push({ id: c.id, category: c.category, s, got, error, ms, dateEligible, timeEligible, prioEligible, recEligible });
}

const pct = (a, b) => (b === 0 ? null : Math.round((a / b) * 1000) / 10);
const acc = (key) => {
  const el = results.filter((r) => r.s[key] !== undefined);
  return { pass: el.filter((r) => r.s[key]).length, total: el.length, rate: pct(el.filter((r) => r.s[key]).length, el.length) };
};
const lat = results.map((r) => r.ms).sort((a, b) => a - b);
const p = (q) => lat[Math.min(lat.length - 1, Math.floor(lat.length * q))];
const dateTimeEl = results.filter((r) => r.dateEligible || r.timeEligible);
const dateTimePass = dateTimeEl.filter((r) => (r.s.date ?? true) && (r.s.time ?? true));

const summary = {
  set: SET,
  mode: MODE,
  cases: cases.length,
  countAccuracy: acc('count'),
  dateAccuracy: acc('date'),
  timeAccuracy: acc('time'),
  dateTimeAccuracy: { pass: dateTimePass.length, total: dateTimeEl.length, rate: pct(dateTimePass.length, dateTimeEl.length) },
  priorityAccuracy: acc('priority'),
  noFabricationRate: acc('noFabrication'),
  recurrenceAccuracy: acc('recurrence'),
  titleKeywordAccuracy: acc('title'),
  latencyMs: { p50: Math.round(p(0.5) * 100) / 100, p95: Math.round(p(0.95) * 100) / 100, max: Math.round(lat[lat.length - 1] * 100) / 100 },
  specThresholds: { countAccuracy: 95, dateTimeAccuracy: 92, priorityAccuracy: 90, noFabricationRate: 100, ruleDraftP95Ms: 50, note: '阈值针对真实快速模型（SPEC §6）；规则基线仅对照' },
};

if (JSON_OUT) {
  console.log(JSON.stringify({ summary, failures: results.filter((r) => Object.entries(r.s).some(([, v]) => v === false)).map((r) => ({ id: r.id, category: r.category, s: r.s, error: r.error, got: r.got })), byCategory: Object.fromEntries(Object.entries(byCat)) }, null, 2));
} else {
  const line = (name, m) => console.log(`  ${name.padEnd(18)} ${m.rate == null ? '  n/a' : String(m.rate).padStart(6) + '%'}  (${m.pass}/${m.total})`);
  console.log(`意图评测 · 集=${SET} · 模式=${MODE} · ${cases.length} 条`);
  line('事项数量准确率', summary.countAccuracy);
  line('日期准确率', summary.dateAccuracy);
  line('时间准确率', summary.timeAccuracy);
  line('日期和时间准确率', summary.dateTimeAccuracy);
  line('优先级准确率', summary.priorityAccuracy);
  line('无编造率', summary.noFabricationRate);
  line('recurrence(对照)', summary.recurrenceAccuracy);
  line('标题关键词(对照)', summary.titleKeywordAccuracy);
  console.log(`  延迟 p50/p95/max     ${summary.latencyMs.p50}/${summary.latencyMs.p95}/${summary.latencyMs.max} ms（SPEC：规则草稿 p95<50ms）`);
  console.log(`  SPEC 阈值（真实模型）: 数量≥95% 日期时间≥92% 优先级≥90% 无编造=100%`);
  // 分类别主指标
  const cats = [...new Set(results.map((r) => r.category))];
  console.log('\n  分类别（数量/日期/时间/优先级/无编造 通过数）:');
  for (const cat of cats) {
    const rs = results.filter((r) => r.category === cat);
    const f = (k) => rs.filter((r) => r.s[k] === true).length + '/' + rs.filter((r) => r.s[k] !== undefined).length;
    console.log(`    ${cat.padEnd(20)} ${f('count').padStart(5)} ${f('date').padStart(5)} ${f('time').padStart(5)} ${f('priority').padStart(5)} ${f('noFabrication').padStart(5)}`);
  }
  const fails = results.filter((r) => Object.values(r.s).includes(false));
  console.log(`\n  失败 ${fails.length} 条${VERBOSE ? '：' : '（--verbose 看明细）'}`);
  if (VERBOSE) {
    for (const r of fails.slice(0, 30)) {
      console.log(`    ✖ ${r.id} [${r.category}] ${JSON.stringify(r.s)}${r.error ? ' error=' + r.error : ''}`);
      const c = cases.find((x) => x.id === r.id);
      console.log(`      转写: ${c.transcript}`);
      console.log(`      got : ${JSON.stringify(r.got && (r.got.items.length ? r.got.items : r.got.nonEvent))}`);
      console.log(`      exp : ${JSON.stringify(c.expect)}`);
    }
  }
}

// 引擎报错（analyzeIntent/ruleDraft ok:false）＝评测器或接线损坏：必须非零退出，绝不静默给全 0% 的“通过”
const errored = results.filter((r) => r.error);
if (errored.length) {
  console.error(`\n✗ ${errored.length}/${results.length} 条引擎报错，评测结果无效（--verbose 看明细）`);
  process.exit(1);
}
