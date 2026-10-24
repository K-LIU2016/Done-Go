// tests/unit/rv2-integration.test.mjs — AI 接力 v2 集成线（boot.js 纯函数 + 模块安全性）。
//
// 被测对象 web/relay/boot.js 是挂载器：浏览器侧接 L1 shell 路由与 L2–L10 模块，
// 本文件只测它的纯函数层（SPEC 红线 6：纯函数与渲染函数都要可测）：
//   · parseRelayQuery / relayHandoffUrl — #/relay 交接参数约定（集成线裁决：
//     #/relay?event=<原话> 与 #/relay?usage=<id>&event=<场景标题>）
//   · nextRecordAction — flow.js record 副作用 → store.js add/setRating/
//     graduate/replaceResult 的落盘路由（一次 #/relay 访问 = 一行记录）
//   · discoverViewHtml — §4⑥ 发现页 markup（类名对照 prototype #s-discover）
//   · flowStringsFor / passportStringsFor — i18n 组 → FLOW_STRINGS/passportStrings
//     键位映射（en 覆盖；缺键回退模块内置 zh，不虚构文案）
//   · 模块在 node 里 import 无副作用（自动启动仅在浏览器环境执行）
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('importing the relay boot module has no DOM side effects in node', async () => {
  assert.equal(globalThis.TangoRelayV2, undefined);
  const boot = await import('../../web/relay/boot.js');
  assert.equal(typeof boot.parseRelayQuery, 'function');
  assert.equal(typeof boot.relayHandoffUrl, 'function');
  assert.equal(typeof boot.nextRecordAction, 'function');
  assert.equal(typeof boot.discoverViewHtml, 'function');
  assert.equal(typeof boot.flowStringsFor, 'function');
  assert.equal(typeof boot.passportStringsFor, 'function');
  assert.equal(globalThis.TangoRelayV2, undefined);
});

test('parseRelayQuery decodes the handoff params and caps the event text', async () => {
  const { parseRelayQuery } = await import('../../web/relay/boot.js');
  // 集成约定：usage=<场景库 id>、event=<urlencoded 原话/场景标题>
  const q1 = parseRelayQuery('event=' + encodeURIComponent('整理组会纪要'));
  assert.equal(q1.usage, '');
  assert.equal(q1.event, '整理组会纪要');
  const q2 = parseRelayQuery('usage=meeting-notes&event=' + encodeURIComponent('刚开完周会'));
  assert.equal(q2.usage, 'meeting-notes');
  assert.equal(q2.event, '刚开完周会');
  assert.deepEqual(parseRelayQuery(''), { usage: '', event: '' });
  assert.deepEqual(parseRelayQuery(undefined), { usage: '', event: '' });
  // 非法百分号编码不抛异常：按原样保留
  const q3 = parseRelayQuery('event=%zz');
  assert.equal(q3.event, '%zz');
  // event 截断到 contracts.EVENT_MAX（600）——镜像常量，见 boot.js 头注
  const long = 'a'.repeat(700);
  assert.equal(parseRelayQuery('event=' + long).event.length, 600);
  // usage 只取第一段且剥空白
  assert.equal(parseRelayQuery('usage=+x&event=1').usage, 'x');
  assert.equal(parseRelayQuery('usage=a&usage=b&event=1').usage, 'a');
});

test('relayHandoffUrl builds the two handoff shapes the lines emit', async () => {
  const { relayHandoffUrl } = await import('../../web/relay/boot.js');
  assert.equal(relayHandoffUrl('写周报'), '#/relay?event=' + encodeURIComponent('写周报'));
  assert.equal(
    relayHandoffUrl('写 30 条学生评语', 'teacher-comments'),
    '#/relay?usage=teacher-comments&event=' + encodeURIComponent('写 30 条学生评语'),
  );
  assert.equal(relayHandoffUrl('', 'meeting-notes'), '#/relay?usage=meeting-notes&event=');
  assert.equal(relayHandoffUrl(''), '#/relay?event=');
});

test('nextRecordAction adds once per relay visit, then mutates the same record', async () => {
  const { nextRecordAction } = await import('../../web/relay/boot.js');
  // 第一次终态（relay_ok 或 relay_fail）→ add
  assert.deepEqual(nextRecordAction({ event: 'e', rating: null, graduatedApp: null, result: 'r' }, { id: null }), { op: 'add' });
  assert.deepEqual(nextRecordAction({ event: 'e', rating: null, graduatedApp: null, result: '', failed: 'timeout' }, { id: null }), { op: 'add' });
  // 自评/毕业/再来一版 → update：携带全部非空字段（幂等全量更新，
  // rate 副作用里 fields.result 也是当前结果文本，重复 replaceResult 无害）
  assert.deepEqual(
    nextRecordAction({ rating: 'much', graduatedApp: null, result: 'r' }, { id: 'r1' }),
    { op: 'update', id: 'r1', rating: 'much', graduatedApp: null, result: 'r' },
  );
  assert.deepEqual(
    nextRecordAction({ rating: null, graduatedApp: 'doubao', result: 'r' }, { id: 'r1' }),
    { op: 'update', id: 'r1', rating: null, graduatedApp: 'doubao', result: 'r' },
  );
  assert.deepEqual(
    nextRecordAction({ rating: null, graduatedApp: null, result: 'new draft' }, { id: 'r1' }),
    { op: 'update', id: 'r1', rating: null, graduatedApp: null, result: 'new draft' },
  );
  // 空字段/无 run → 不动作
  assert.equal(nextRecordAction(null, { id: 'r1' }), null);
  assert.equal(nextRecordAction({}, null), null);
});

test('discoverViewHtml mirrors prototype #s-discover markup with escaping', async () => {
  const { discoverViewHtml } = await import('../../web/relay/boot.js');
  const html = discoverViewHtml(
    {
      title: '发现',
      lead: '挑一件跟你有关的事，点一下就开始。',
      persona: 'student',
      personaLabels: { student: '学生', teacher: '老师', worker: '上班族', elder: '长辈' },
      segLabel: '我是',
      groups: [
        {
          label: '写',
          cards: [
            { usageId: 'a<b', title: '写 30 条学生评语', hint: '给要点，AI 先起草' },
            { usageId: 'b', title: '家长群通知', hint: '说清事项，语气温和' },
          ],
        },
        { label: '整理', cards: [{ usageId: 'c', title: '整理会议纪要', hint: '重点、待办' }] },
      ],
    },
    {
      iconHref: (category, title) => (title.indexOf('通知') >= 0 ? '#i-mail' : '#i-pen'),
      cardClass: (index) => 'c' + ((index % 3) + 1),
    },
  );
  assert.match(html, /<h1[^>]*>发现<\/h1>/);
  assert.match(html, /<p class="lead">/);
  // 人群 seg：四个 data-persona，当前人群 on + aria-selected
  assert.equal((html.match(/data-persona="/g) || []).length, 4);
  assert.match(html, /role="tab"[^>]*aria-selected="true"[^>]*class="on"[^>]*data-persona="student"/);
  assert.match(html, /data-persona="student"[^>]*>学生</);
  // 分组标题 + 网格 + 场景卡（类名对照原型 .cat/.grid/.scene c1-c3）
  assert.match(html, /<p class="cat">写<\/p>/);
  assert.match(html, /<p class="cat">整理<\/p>/);
  assert.equal((html.match(/class="grid"/g) || []).length, 2);
  assert.match(html, /class="scene c1"[^>]*data-scene="a&lt;b"/);
  assert.match(html, /data-event="写 30 条学生评语"/);
  assert.match(html, /<use href="#i-mail"\/>/);
  assert.match(html, /<use href="#i-pen"\/>/);
  // 转义：标题中的 < 不裸露
  assert.ok(html.indexOf('a<b"') < 0);
});

test('flowStringsFor maps present i18n groups and omits absent keys', async () => {
  const { flowStringsFor } = await import('../../web/relay/boot.js');
  const out = flowStringsFor({
    match: { back: 'Change', send: 'Go', youSaid: 'You said:', lowConfidenceTitle: 'Which one?', materialNote: 'Paste or say', toolsSpeak: 'Speak', toolsPaste: 'Paste', privacy: 'Privacy line', tooLong: 'Too long', altPrefix: 'Not right?', altJoin: 'or', kicker: 'K' },
    running: { title: 'Working…', stop: 'Stop', note: 'Usually 5–15s.', slowHint: 'Slow hint' },
    result: { title: 'Draft', aiTag: 'AI draft', copy: 'Copy', edit: 'Edit', redo: 'Redo', rateTitle: 'Helped?', learnedKicker: 'Learned' },
    ratings: { much: 'A lot', little: 'A bit', none: 'Not really' },
    baton: { resultKicker: 'Baton', resultTitle: 'Do it yourself', resultBody: 'Copy this', moreApps: 'More', copyAndOpen: 'Copy & open', doneLink: '✓ Did it myself', failKicker: 'No wait?', failTitle: 'Take it to Doubao', failBody: 'Copy below' },
    fail: { title: 'Missed', notYourFault: 'Not your fault.', kept: 'Still here.', retry: 'Retry', reasons: { timeout: 'too slow' } },
  });
  assert.equal(out.back, 'Change');
  assert.equal(out.submit, 'Go');            // match.send → flow.submit
  assert.equal(out.runningTitle, 'Working…'); // running.title → flow.runningTitle
  assert.equal(out.kicker, 'K');
  assert.equal(out.ratings.much, 'A lot');
  assert.equal(out.batonKicker, 'Baton');     // baton.resultKicker → flow.batonKicker
  assert.equal(out.failBatonTitle, 'Take it to Doubao');
  assert.equal(out.failReasons.timeout, 'too slow');
  // 没有来源的键不得虚构
  assert.ok(!('clipboardFallback' in out));
  assert.ok(!('nudgeBefore' in out));
  // 空输入 → 空对象（调用方据此不覆盖，模块内置 zh 生效）
  assert.deepEqual(flowStringsFor(null), {});
  assert.deepEqual(flowStringsFor({}), {});
});

test('passportStringsFor maps present i18n keys and omits absent keys', async () => {
  const { passportStringsFor } = await import('../../web/relay/boot.js');
  const out = passportStringsFor({
    title: 'My usages',
    lead: 'Everything you did with AI.',
    statLearned: 'Learned',
    statRelay: 'relays',
    statGraduated: 'solo runs',
    skillsTitle: 'Skills',
    recentTitle: 'Recent',
    doAgain: 'Again →',
    tryOnce: 'Try →',
    gradBadge: 'Solo',
    today: 'Today',
    yesterday: 'Yesterday',
    exportJson: 'Export',
  });
  assert.equal(out.title, 'My usages');
  assert.equal(out.statRelays, 'relays');   // i18n statRelay → passport statRelays
  assert.equal(out.statGraduations, 'solo runs');
  assert.equal(out.secSkills, 'Skills'); // i18n skillsTitle → passport secSkills
  assert.equal(out.secRecent, 'Recent');
  assert.equal(out.skillAgain, 'Again →');
  assert.equal(out.skillTry, 'Try →');
  assert.ok(!('ratingLabels' in out)); // 缺来源的嵌套键不虚构
  assert.deepEqual(passportStringsFor(null), {});
});
