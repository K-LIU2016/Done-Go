import assert from 'node:assert/strict';
import { test } from 'node:test';

// RV2 L5 我的用法 (passport) line: web/relay/passport.js renders the #/me
// page from SPEC design/relay-v2/SPEC.md §4⑤ and the m-passport.png shot.
//
// Pinned decisions (documented in passport.js):
// - Copy comes verbatim from the prototype (D1 视觉为准): h1 我的用法, lead,
//   stat labels 学会的用法 / 次 AI 接力 / 次自己做到, skill captions
//   接力 N 次 · 自己做到 M 次 (graduated) vs 接力 N 次 · 还没自己试
//   (green), buttons 再做一次 → / 去试一次 →, grad pill 自己做到.
// - AI 接力次数 counts every stored record: SPEC §5.4 keeps failed relays in
//   the store and an attempted relay is still an AI 接力 (invariant from the
//   shot: 4+3+1+1 skill counts sum to the 9 shown in the stats).
// - Skill order: relayCount desc, then most recent record desc (matches the
//   shot: 4,3,1,1 with the 昨天 usage before the 10-21 one among ties).
// - Records migrated from v1 keep usageId:null → they join stats/hist but
//   never form skill cards (contracts.js pin).

import {
  computeStats, usageSummaries, buildPassportModel,
  formatDayLabel, formatFullDay, ratingEmoji,
  buildExportJson, exportFileName, toUsageMap,
  renderPassport, renderRecordDetail, createPassport, passportStrings,
} from '../../web/relay/passport.js';
import { createRecord, sanitizeRecord } from '../../web/relay/contracts.js';

const UUID = (n) => String(n).padStart(8, '0') + '-1111-4111-8111-111111111111';
const NOW = new Date(2026, 9, 24, 12, 0, 0).getTime(); // 2026-10-24 local noon
const iso = (y, mo, d, h = 8) => new Date(y, mo - 1, d, h, 30, 0).toISOString();

function rec(n, fields = {}, at = iso(2026, 10, 24)) {
  return createRecord(Object.assign({ event: '事件' + n, usageId: 'meeting-notes', result: '结果' + n }, fields), { uuid: UUID(n), now: new Date(at).getTime() });
}

// v1-migrated shape: usageId null (createRecord refuses null usageId by design).
function legacyRec(n, at = iso(2026, 10, 24)) {
  return sanitizeRecord({ id: UUID(n), at: at, event: '旧记录' + n, usageId: null, result: '旧结果' + n, rating: null, graduated: false, graduatedApp: null, failed: null });
}

const USAGES = {
  'meeting-notes': { id: 'meeting-notes', title: '整理会议纪要' },
  'long-read': { id: 'long-read', title: '长文 → 5 个要点' },
  'polite-mail': { id: 'polite-mail', title: '口语 → 礼貌邮件' },
};

// ---------------------------------------------------------------------------
// computeStats — SPEC §4⑤ 三个统计
// ---------------------------------------------------------------------------

test('computeStats: empty records → all zeros', () => {
  assert.deepEqual(computeStats([]), { learned: 0, relays: 0, graduations: 0 });
});

test('computeStats: learned counts distinct non-null usageIds', () => {
  const records = [
    rec(1, {}, iso(2026, 10, 24)),
    rec(2, { usageId: 'long-read' }, iso(2026, 10, 23)),
    rec(3, { usageId: 'meeting-notes' }, iso(2026, 10, 22)),
  ];
  assert.equal(computeStats(records).learned, 2);
});

test('computeStats: relays counts every record, failed and legacy included', () => {
  const records = [
    rec(1, {}, iso(2026, 10, 24)),
    rec(2, { failed: 'timeout' }, iso(2026, 10, 23)),
    legacyRec(3, iso(2026, 10, 22)),
  ];
  assert.equal(computeStats(records).relays, 3);
});

test('computeStats: graduations counts graduated records only', () => {
  const records = [
    rec(1, { graduated: true, graduatedApp: 'doubao' }, iso(2026, 10, 24)),
    rec(2, { graduated: true, graduatedApp: 'kimi', usageId: 'long-read' }, iso(2026, 10, 23)),
    rec(3, {}, iso(2026, 10, 22)),
  ];
  assert.equal(computeStats(records).graduations, 2);
});

test('computeStats: shot invariant 4+3+1+1 skill counts sum to the relay total', () => {
  const records = [
    rec(1, {}, iso(2026, 10, 24)), rec(2, {}, iso(2026, 10, 23)),
    rec(3, {}, iso(2026, 10, 22)), rec(4, {}, iso(2026, 10, 21)),
    rec(5, { usageId: 'long-read' }, iso(2026, 10, 22)), rec(6, { usageId: 'long-read' }, iso(2026, 10, 21)),
    rec(7, { usageId: 'long-read' }, iso(2026, 10, 20)),
    rec(8, { usageId: 'polite-mail' }, iso(2026, 10, 23)),
    rec(9, { usageId: 'plan-steps' }, iso(2026, 10, 21)),
  ];
  const stats = computeStats(records);
  const model = buildPassportModel(records, USAGES);
  const sum = model.skills.reduce((acc, s) => acc + s.relayCount, 0);
  assert.equal(stats.relays, 9);
  assert.equal(sum, 9);
  assert.equal(stats.learned, 4);
});

// ---------------------------------------------------------------------------
// usageSummaries — 学会的用法卡片
// ---------------------------------------------------------------------------

test('usageSummaries: gold when any record graduated, counts per usage', () => {
  const records = [
    rec(1, { graduated: true, graduatedApp: 'doubao' }, iso(2026, 10, 24)),
    rec(2, { graduated: true, graduatedApp: 'doubao' }, iso(2026, 10, 23)),
    rec(3, {}, iso(2026, 10, 22)),
    rec(4, { usageId: 'polite-mail' }, iso(2026, 10, 23)),
  ];
  const skills = usageSummaries(records, USAGES);
  const meeting = skills.find((s) => s.usageId === 'meeting-notes');
  assert.equal(meeting.graduated, true);
  assert.equal(meeting.relayCount, 3);
  assert.equal(meeting.gradCount, 2);
  assert.equal(meeting.title, '整理会议纪要');
  const mail = skills.find((s) => s.usageId === 'polite-mail');
  assert.equal(mail.graduated, false);
  assert.equal(mail.gradCount, 0);
});

test('usageSummaries: orders by relayCount desc then most recent desc', () => {
  const records = [
    rec(1, {}, iso(2026, 10, 24)),
    rec(2, { usageId: 'long-read' }, iso(2026, 10, 23)),
    rec(3, { usageId: 'long-read' }, iso(2026, 10, 22)),
    rec(4, { usageId: 'long-read' }, iso(2026, 10, 21)),
    rec(5, { usageId: 'polite-mail' }, iso(2026, 10, 23)),
    rec(6, { usageId: 'plan-steps' }, iso(2026, 10, 21)),
  ];
  const ids = usageSummaries(records, USAGES).map((s) => s.usageId);
  assert.deepEqual(ids, ['long-read', 'meeting-notes', 'polite-mail', 'plan-steps']);
});

test('usageSummaries: null usageId records never form cards; unknown ids get fallback title', () => {
  const records = [
    legacyRec(1, iso(2026, 10, 24)),
    rec(2, { usageId: 'ghost-usage' }, iso(2026, 10, 23)),
  ];
  const skills = usageSummaries(records, USAGES);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].usageId, 'ghost-usage');
  assert.equal(skills[0].known, false);
  assert.ok(skills[0].title.length > 0);
});

// ---------------------------------------------------------------------------
// day labels + rating emoji — prototype 今天/昨天/10-22 + SPEC §1.5 emoji
// ---------------------------------------------------------------------------

test('formatDayLabel: 今天 / 昨天 / MM-DD same year / YYYY-MM-DD other year', () => {
  assert.equal(formatDayLabel(iso(2026, 10, 24), NOW), '今天');
  assert.equal(formatDayLabel(iso(2026, 10, 23), NOW), '昨天');
  assert.equal(formatDayLabel(iso(2026, 10, 2), NOW), '10-02');
  assert.equal(formatDayLabel(iso(2025, 12, 30), NOW), '2025-12-30');
  assert.equal(formatDayLabel(iso(2025, 12, 31), new Date(2026, 0, 1, 9).getTime()), '昨天');
});

test('formatFullDay: zero padded YYYY-MM-DD', () => {
  assert.equal(formatFullDay(iso(2026, 10, 2)), '2026-10-02');
});

test('ratingEmoji: much/little/none map to 😀/🙂/😐, null stays quiet', () => {
  assert.equal(ratingEmoji('much'), '😀');
  assert.equal(ratingEmoji('little'), '🙂');
  assert.equal(ratingEmoji('none'), '😐');
  assert.equal(ratingEmoji(null), '·');
  assert.equal(ratingEmoji('junk'), '·');
});

// ---------------------------------------------------------------------------
// export JSON — SPEC §4⑤ 导出我的记录（JSON）
// ---------------------------------------------------------------------------

test('buildExportJson: pretty 2-space payload with v and records, null on junk', () => {
  const store = { v: 2, records: [rec(1)] };
  const text = buildExportJson(store);
  const parsed = JSON.parse(text);
  assert.equal(parsed.v, 2);
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].event, '事件1');
  assert.ok(text.includes('\n  '));
  assert.equal(buildExportJson(null), null);
  assert.equal(buildExportJson({ v: 2 }), null);
});

test('exportFileName: local date stamped json name', () => {
  assert.equal(exportFileName(new Date(2026, 9, 2, 23)), 'tango-donego-relay-20261002.json');
});

// ---------------------------------------------------------------------------
// buildPassportModel — recent rows
// ---------------------------------------------------------------------------

test('buildPassportModel: recent sorted newest first, sub line 日期 · 用法, capped', () => {
  const records = [
    legacyRec(1, iso(2026, 10, 22)),
    rec(2, { usageId: 'polite-mail', rating: 'little' }, iso(2026, 10, 23)),
    rec(3, { usageId: 'meeting-notes', rating: 'much' }, iso(2026, 10, 24)),
  ];
  const model = buildPassportModel(records, USAGES, { now: NOW });
  assert.deepEqual(model.recent.map((r) => r.id), [UUID(3), UUID(2), UUID(1)]);
  assert.equal(model.recent[0].emoji, '😀');
  assert.equal(model.recent[0].sub, '今天 · 整理会议纪要');
  assert.equal(model.recent[1].sub, '昨天 · 口语 → 礼貌邮件');
  assert.equal(model.recent[2].sub, '10-22');
  const many = [];
  for (let i = 0; i < 30; i += 1) many.push(rec(i + 1, {}, iso(2026, 9, 1, 8)));
  assert.equal(buildPassportModel(many, USAGES).recent.length, 10);
  assert.equal(buildPassportModel(many, USAGES, { recentLimit: 3 }).recent.length, 3);
});

test('buildPassportModel: long events truncated with …, graduation pill flag', () => {
  const long = '读论文 Attention Is All You Need 的方法部分并整理成要点清单给组会讲';
  const records = [
    rec(1, { event: long, graduated: true, graduatedApp: 'doubao' }, iso(2026, 10, 24)),
  ];
  const row = buildPassportModel(records, USAGES).recent[0];
  assert.equal(row.event.length, 25); // 24 chars + …
  assert.ok(row.event.endsWith('…'));
  assert.equal(row.graduated, true);
});

// ---------------------------------------------------------------------------
// renderPassport — markup matches the shot, escapes user text
// ---------------------------------------------------------------------------

test('renderPassport: verbatim copy and structure from m-passport.png', () => {
  const records = [
    rec(1, { rating: 'much', graduated: true, graduatedApp: 'doubao' }, iso(2026, 10, 24)),
    rec(2, { usageId: 'polite-mail', rating: 'little' }, iso(2026, 10, 23)),
  ];
  const html = renderPassport(buildPassportModel(records, USAGES, { now: NOW }));
  assert.ok(html.includes('<h1 style="margin-top:14px">我的用法</h1>'));
  assert.ok(html.includes('你和 AI 一起做过的事，都在这里。'));
  assert.ok(html.includes('<div class="stat"><b>2</b><span>学会的用法</span></div>'));
  assert.ok(html.includes('<div class="stat"><b>2</b><span>次 AI 接力</span></div>'));
  assert.ok(html.includes('<div class="stat g"><b>1</b><span>次自己做到</span></div>'));
  assert.ok(html.includes('<div class="sec"><h3>学会的用法</h3></div>'));
  assert.ok(html.includes('<div class="sec"><h3>最近</h3></div>'));
  assert.ok(html.includes('接力 1 次 · 自己做到 1 次'));
  assert.ok(html.includes('接力 1 次 · 还没自己试'));
  assert.ok(html.includes('再做一次 →'));
  assert.ok(html.includes('去试一次 →'));
  assert.ok(html.includes('整理会议纪要'));
  assert.ok(html.includes('今天 · 整理会议纪要'));
  assert.ok(html.includes('<span class="grad">自己做到</span>'));
  assert.ok(html.includes('导出我的记录（JSON）'));
  assert.ok(html.includes('class="skill"'));
  assert.ok(html.includes('class="m gold"'));
  assert.ok(html.includes('class="m"'));
});

test('renderPassport: rows are keyboard reachable buttons carrying record ids', () => {
  const html = renderPassport(buildPassportModel([rec(1)], USAGES, { now: NOW }));
  assert.ok(html.includes('role="button"'));
  assert.ok(html.includes('tabindex="0"'));
  assert.ok(html.includes('data-record-id="' + UUID(1) + '"'));
  assert.ok(html.includes('data-again="meeting-notes"'));
  assert.ok(html.includes('data-export'));
});

test('renderPassport: escapes event text (XSS)', () => {
  const records = [rec(1, { event: '<script>alert(1)</script>与"引号"' }, iso(2026, 10, 24))];
  const html = renderPassport(buildPassportModel(records, USAGES, { now: NOW }));
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('renderPassport: empty store → zero stats, empty hint, no recent section', () => {
  const html = renderPassport(buildPassportModel([], USAGES));
  assert.ok(html.includes('<b>0</b>'));
  assert.ok(html.includes('完成第一次接力，这里会出现你学会的第一个用法'));
  assert.ok(!html.includes('<div class="hist"'));
  assert.ok(!html.includes('<div class="sec"><h3>最近</h3></div>'));
});

test('renderPassport: highlightUsageId rings the skill card (SPEC §4④ 跳转 #/me 高亮)', () => {
  const records = [rec(1), rec(2, { usageId: 'polite-mail' }, iso(2026, 10, 23))];
  const html = renderPassport(buildPassportModel(records, USAGES), { highlightUsageId: 'polite-mail' });
  const card = html.split('id="relay-skill-polite-mail"')[1].split('</button>')[0];
  assert.ok(card.includes('hl'));
  assert.ok(card.includes('--gold'));
});

// ---------------------------------------------------------------------------
// renderRecordDetail — 只读详情 + 复制 (SPEC §4⑤ 点开可查看当时的结果（只读）并复制)
// ---------------------------------------------------------------------------

test('renderRecordDetail: read-only result, meta, back and copy affordances', () => {
  const record = rec(1, { event: '整理组会纪要', result: '第一行\n第二行', rating: 'much', graduated: true, graduatedApp: 'doubao' }, iso(2026, 10, 24));
  const html = renderRecordDetail(record, USAGES, { now: NOW });
  assert.ok(html.includes('data-back'));
  assert.ok(html.includes('AI 生成 · 请你核对'));
  assert.ok(html.includes('整理会议纪要'));
  assert.ok(html.includes('今天'));
  assert.ok(html.includes('😀 省了不少'));
  assert.ok(html.includes('自己做到'));
  assert.ok(html.includes('第一行<br>第二行'));
  assert.ok(html.includes('data-copy-result="' + UUID(1) + '"'));
  assert.ok(!html.includes('contenteditable'));
});

test('renderRecordDetail: escapes result text and shows a no-result note for failed relays', () => {
  const record = rec(2, { event: 'x', result: '<img src=x onerror=1>', failed: 'timeout' }, iso(2026, 10, 24));
  const html = renderRecordDetail(record, USAGES, { now: NOW });
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img src=x'));
  assert.ok(html.includes('没有保存的结果'));
});

// ---------------------------------------------------------------------------
// toUsageMap / strings
// ---------------------------------------------------------------------------

test('toUsageMap: object keyed by id, prototype-safe', () => {
  const map = toUsageMap([{ id: 'constructor', title: '陷阱' }, { id: 'a', title: 'A' }]);
  assert.equal(map.constructor.title, '陷阱');
  assert.equal(Object.keys(map).length, 2);
});

test('passportStrings: fresh object each call with pinned copy', () => {
  const a = passportStrings();
  a.title = 'mutated';
  assert.equal(passportStrings().title, '我的用法');
});

// ---------------------------------------------------------------------------
// createPassport controller — DOM stubs, no real document needed
// ---------------------------------------------------------------------------

function stubNode() {
  return { innerHTML: '', onclick: null, onkeydown: null };
}

function click(node, target) {
  assert.ok(node.onclick, 'click handler installed');
  node.onclick({ target: target, preventDefault() {} });
}

test('createPassport: mount renders list, row click opens detail, back returns', () => {
  const records = [rec(1, { rating: 'much' }, iso(2026, 10, 24))];
  const node = stubNode();
  const passport = createPassport({ loadStore: () => ({ v: 2, records }), usagesById: USAGES, now: NOW });
  passport.mount(node);
  assert.ok(node.innerHTML.includes('今天 · 整理会议纪要'));
  click(node, { closest: () => null }); // non-interactive click is a no-op
  const row = { closest: (sel) => (sel === '[data-record-id]' ? { getAttribute: () => UUID(1) } : null) };
  click(node, row);
  assert.ok(node.innerHTML.includes('data-back'));
  assert.ok(node.innerHTML.includes('data-copy-result'));
  click(node, { closest: (sel) => (sel === '[data-back]' ? {} : null) });
  assert.ok(node.innerHTML.includes('data-record-id'));
});

test('createPassport: Enter and Space open a row', () => {
  const records = [rec(1)];
  const node = stubNode();
  const passport = createPassport({ loadStore: () => ({ v: 2, records }), usagesById: USAGES, now: NOW });
  passport.mount(node);
  const row = { closest: (sel) => (sel === '[data-record-id]' ? { getAttribute: () => UUID(1) } : null) };
  let prevented = false;
  node.onkeydown({ target: row, key: 'Enter', preventDefault() { prevented = true; } });
  assert.ok(node.innerHTML.includes('data-back'));
  assert.ok(prevented);
  prevented = false;
  node.onkeydown({ target: row, key: ' ', preventDefault() { prevented = true; } });
  assert.ok(prevented);
  node.onkeydown({ target: { closest: () => null }, key: 'Enter', preventDefault() {} });
  assert.ok(node.innerHTML.includes('data-back'));
});

test('createPassport: 再做一次 fires onAgain with the usageId', () => {
  const again = [];
  const node = stubNode();
  const passport = createPassport({
    loadStore: () => ({ v: 2, records: [rec(1)] }),
    usagesById: USAGES,
    onAgain: (usageId) => again.push(usageId),
  });
  passport.mount(node);
  click(node, { closest: (sel) => (sel === '[data-again]' ? { getAttribute: () => 'meeting-notes' } : null) });
  assert.deepEqual(again, ['meeting-notes']);
});

test('createPassport: copy uses clipboard and flashes 已复制', () => {
  const copied = [];
  const node = stubNode();
  const button = {
    closest: (sel) => (sel === '[data-copy-result]' ? button : null),
    getAttribute: () => UUID(1),
    textContent: '复制',
  };
  const passport = createPassport({
    loadStore: () => ({ v: 2, records: [rec(1, { result: 'R1' })] }),
    usagesById: USAGES,
    now: NOW,
    root: { navigator: { clipboard: { writeText: (t) => { copied.push(t); return Promise.resolve(); } } } },
  });
  passport.mount(node);
  click(node, { closest: (sel) => (sel === '[data-record-id]' ? { getAttribute: () => UUID(1) } : null) });
  click(node, button);
  assert.deepEqual(copied, ['R1']);
  assert.equal(button.textContent, '已复制 ✓');
});

test('createPassport: export downloads the store JSON via blob anchor', () => {
  const records = [rec(1)];
  const clicks = [];
  const blobs = [];
  class FakeBlob {
    constructor(parts, opts) { blobs.push({ parts, opts }); }
  }
  const anchor = { click: () => clicks.push(1), href: '', download: '' };
  const body = { children: [], appendChild(el) { this.children.push(el); }, removeChild(el) { this.children = this.children.filter((c) => c !== el); } };
  const node = stubNode();
  const passport = createPassport({
    loadStore: () => ({ v: 2, records }),
    usagesById: USAGES,
    root: {
      Blob: FakeBlob,
      URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} },
      document: { createElement: () => anchor, body },
    },
  });
  passport.mount(node);
  const ok = passport.exportRecords();
  assert.equal(ok, true);
  assert.equal(clicks.length, 1);
  assert.equal(blobs[0].opts.type, 'application/json');
  const json = JSON.parse(blobs[0].parts[0]);
  assert.equal(json.records[0].event, '事件1');
  assert.ok(/^tango-donego-relay-\d{8}\.json$/.test(anchor.download));
  click(node, { closest: (sel) => (sel === '[data-export]' ? {} : null) });
  assert.equal(clicks.length, 2);
});

test('createPassport: export degrades to false without a DOM root', () => {
  const node = stubNode();
  const passport = createPassport({
    loadStore: () => ({ v: 2, records: [rec(1)] }),
    usagesById: USAGES,
    root: {},
  });
  passport.mount(node);
  assert.equal(passport.exportRecords(), false);
});

test('createPassport: highlightUsage re-renders with the ring', () => {
  const records = [rec(1), rec(2, { usageId: 'polite-mail' }, iso(2026, 10, 23))];
  const node = stubNode();
  const passport = createPassport({ loadStore: () => ({ v: 2, records }), usagesById: USAGES, now: NOW });
  passport.mount(node);
  assert.ok(!node.innerHTML.includes('class="skill hl"'));
  passport.highlightUsage('polite-mail');
  assert.ok(node.innerHTML.includes('class="skill hl"'));
});
