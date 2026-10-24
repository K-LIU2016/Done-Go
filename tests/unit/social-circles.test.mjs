import assert from 'node:assert/strict';
import { test } from 'node:test';

// SO·S7搭档圈挑战 line (circles half): web/social/circles.js — 同频圈
// (PRD design/social-sync/PRD.md §4.6)。
//
// 硬门槛在本文件证明：
// - 邀请码加入：错码/缺码一律拒绝 —— 圈【只能】通过邀请码进入，结构性
//   保证「未成年人只能进有邀请码的圈」（D2）；规模 3–50 人（contracts）。
// - 用法墙：只聚合 {usageId, count}，绝无成员身份；未知字段 entry 拒绝。
// - 省时去向汇总：按 freedMinutesConfirmed 加权、只输出占比（过
//   contracts.validateFreedToSummary），无个人明细。
// - D5：圈内排名只按传棒与毕业（CIRCLE_RANK_METRICS）——输入带任何
//   工时/分钟字段直接拒绝 null；输出过 validateCircleRankView 且序列化
//   后不含 minute/hour/工时 字样；只显示前 3 名和「你」。

import {
  CIRCLE_MIN_MEMBERS, CIRCLE_MAX_MEMBERS, CIRCLE_RANK_SHOWN,
  validateCircle, validateCircleRankView, validateFreedToSummary,
} from '../../web/social/contracts.js';
import {
  generateInviteCode, isInviteCode, createCircle, joinCircle,
  circleUsageWall, circleFreedToSummary, circleRanking, circleStats,
} from '../../web/social/circles.js';

const W43 = '2026-W43';
const CODE = 'TANGO43';

function mkCircle() {
  return { circle: { id: 'cir-1', name: '王老师课题组', inviteCode: CODE }, members: ['alice'] };
}

// 全部 sum=1 的合法占比表
const M_BASE = { family: 0.3, exercise: 0.2, study: 0.2, rest: 0.15, hobby: 0.1, other: 0.05 };
const M_FAMILY = { family: 0.8, exercise: 0.1, study: 0.03, rest: 0.03, hobby: 0.02, other: 0.02 };
const M_SPORT = { family: 0.2, exercise: 0.8, study: 0, rest: 0, hobby: 0, other: 0 };
const M_STUDY = { family: 0, exercise: 0, study: 1, rest: 0, hobby: 0, other: 0 };

test('generateInviteCode：8 位、无混淆字符、能过 contracts 的 INVITE_CODE_RE；注入 rand 确定性', () => {
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const a = generateInviteCode(rand);
  const b = generateInviteCode(rand);
  assert.match(a, /^[A-Z2-9]{8}$/, '默认 8 位，去掉 0/O/1/I 混淆字符');
  assert.notEqual(a, b, '随机性');
  assert.ok(isInviteCode(a), '通过契约邀请码规则（validateCircle 探针）');
  assert.equal(generateInviteCode(() => 0.5), generateInviteCode(() => 0.5), '注入相同 rand 结果一致（确定性）');
  assert.ok(!isInviteCode('abc'), '小写拒绝');
  assert.ok(!isInviteCode('ABC'), '太短拒绝');
  assert.ok(!isInviteCode('ABCDEFGHIJKLM'), '太长拒绝');
  assert.ok(isInviteCode(CODE));
});

test('createCircle：过 validateCircle，创建者即首位成员', () => {
  const state = createCircle({ id: 'cir-1', name: '王老师课题组', inviteCode: CODE, creator: 'alice' });
  assert.ok(validateCircle(state.circle));
  assert.deepEqual(state.members, ['alice']);
  assert.equal(createCircle({ id: 'cir-1', name: '', inviteCode: CODE, creator: 'alice' }), null, '空名拒绝');
  assert.equal(createCircle({ id: 'cir-1', name: 'x', inviteCode: 'bad code!', creator: 'alice' }), null, '非法邀请码拒绝');
});

test('joinCircle：错码/缺码/已是成员/超员 一律拒绝；正确码加入', () => {
  let state = mkCircle();
  assert.equal(joinCircle(state, { accountId: 'bob', inviteCode: 'WRONG99' }).ok, false, '错码拒绝');
  assert.equal(joinCircle(state, { accountId: 'bob' }).ok, false, '缺码拒绝 —— 圈只能经邀请码进入（未成年人保护的结构性保证）');
  const ok = joinCircle(state, { accountId: 'bob', inviteCode: CODE });
  assert.equal(ok.ok, true);
  state = ok.state;
  assert.ok(state.members.includes('bob'));
  assert.equal(joinCircle(state, { accountId: 'bob', inviteCode: CODE }).ok, false, '重复加入拒绝');
  while (state.members.length < CIRCLE_MAX_MEMBERS) {
    const r = joinCircle(state, { accountId: 'm' + state.members.length, inviteCode: CODE });
    assert.equal(r.ok, true);
    state = r.state;
  }
  assert.equal(state.members.length, CIRCLE_MAX_MEMBERS);
  const over = joinCircle(state, { accountId: 'overflow', inviteCode: CODE });
  assert.equal(over.ok, false, '第 51 人拒绝');
  assert.match(over.reason, /50/);
});

test('circleUsageWall：按次数降序、并列按 usageId 升序；只含 {usageId,count}；过滤他周；未知字段拒绝', () => {
  const entries = [
    { accountId: 'alice', usageId: 'paper-5points', week: W43, count: 4 },
    { accountId: 'bob', usageId: 'paper-5points', week: W43, count: 2 },
    { accountId: 'carol', usageId: 'meeting-notes', week: W43, count: 6 },
    { accountId: 'dave', usageId: 'review-reply', week: W43, count: 6 },
    { accountId: 'alice', usageId: 'old-usage', week: '2026-W42', count: 9 }, // 他周
  ];
  const wall = circleUsageWall(entries, { week: W43 });
  assert.ok(Array.isArray(wall));
  assert.deepEqual(wall.slice(0, 3).map((w) => w.usageId), ['meeting-notes', 'paper-5points', 'review-reply'],
    'count 并列时按 usageId 字典序');
  assert.equal(wall[1].count, 6, 'paper-5points 合计 4+2');
  for (const entry of wall) {
    assert.deepEqual(Object.keys(entry).sort(), ['count', 'usageId'], '墙条目只有 usageId + count，无任何成员身份');
  }
  assert.ok(!JSON.stringify(wall).includes('alice'), '序列化后不含任何 accountId');
  assert.equal(circleUsageWall(null, { week: W43 }), null, '非数组输入拒绝');
  assert.equal(circleUsageWall([{ accountId: 'alice', usageId: 'x', week: W43, count: 1, secretTitle: '我的会议' }], { week: W43 }), null,
    'entry 带未知字段（如标题）整体拒绝 —— 不是剥离');
});

test('circleFreedToSummary：按确认分钟加权；输出只含占比并过 validateFreedToSummary；全 0 分钟 → null', () => {
  const members = [
    { freedTo: M_FAMILY, freedMinutesConfirmed: 180 },
    { freedTo: M_SPORT, freedMinutesConfirmed: 60 },
    { freedTo: M_BASE, freedMinutesConfirmed: 0 }, // 0 分钟不参与
  ];
  const summary = circleFreedToSummary(members);
  assert.ok(summary, '应产出汇总');
  // family = (0.8*180 + 0.2*60)/240 = 0.65；exercise = (0.1*180 + 0.8*60)/240 = 0.275
  assert.ok(Math.abs(summary.family - 0.65) < 1e-9);
  assert.ok(Math.abs(summary.exercise - 0.275) < 1e-9);
  assert.ok(validateFreedToSummary(summary), '过契约校验：只允许占比、总和 1');
  assert.equal(circleFreedToSummary([{ freedTo: M_BASE, freedMinutesConfirmed: 0 }]), null, '无人确认分钟 → null，不造假数据');
  assert.equal(circleFreedToSummary('nope'), null);
  assert.equal(circleFreedToSummary([{ freedTo: { family: 1 }, freedMinutesConfirmed: 30 }]), null, '残缺占比表整体拒绝');
  const single = circleFreedToSummary([{ freedTo: M_STUDY, freedMinutesConfirmed: 30 }]);
  assert.ok(Math.abs(single.study - 1) < 1e-9);
});

test('circleRanking：只按传棒+毕业排序；工时字段在输入里直接拒绝 null（D5）', () => {
  const members = [
    { accountId: 'song', alias: '远山的松', avatarColor: '#615CED', batons: 7, graduations: 2 },
    { accountId: 'lu', alias: '晨跑的鹿', avatarColor: '#E8B04B', batons: 5, graduations: 4 },
    { accountId: 'hu', alias: '安静的湖', avatarColor: '#4C7A93', batons: 4, graduations: 6 },
    { accountId: 'me', alias: '你', avatarColor: '#E95432', batons: 2, graduations: 1 },
  ];
  const withMinutes = members.map((m) => Object.assign({ workMinutes: 999 }, m));
  assert.equal(circleRanking(withMinutes, 'me'), null, '输入携带工时字段 → 整体拒绝');
  assert.equal(circleRanking(members.map((m) => Object.assign({ hours: 1 }, m)), 'me'), null);

  const view = circleRanking(members, 'me');
  assert.ok(validateCircleRankView(view), '输出过契约 rank view');
  assert.deepEqual(view.top.map((t) => t.alias), ['远山的松', '晨跑的鹿', '安静的湖']);
  assert.equal(view.top.length, CIRCLE_RANK_SHOWN);
  assert.ok(view.you, '排名第 4 的「你」单独展示');
  assert.equal(view.you.rank, 4);
  assert.equal(view.you.batons, 2);
  const json = JSON.stringify(view);
  for (const banned of ['minute', 'hour', '工时', '时长', '分钟']) {
    assert.ok(!json.includes(banned), `排名视图不得含「${banned}」(D5)`);
  }
});

test('circleRanking：并列同名次（competition ranking）；你在前 3 时 you=null', () => {
  const members = [
    { accountId: 'a1', alias: '甲', avatarColor: '#111111', batons: 5, graduations: 2 },
    { accountId: 'a2', alias: '乙', avatarColor: '#222222', batons: 5, graduations: 2 },
    { accountId: 'a3', alias: '丙', avatarColor: '#333333', batons: 5, graduations: 1 },
  ];
  const view = circleRanking(members, 'a1');
  assert.equal(view.top[0].rank, 1);
  assert.equal(view.top[1].rank, 1, '甲乙同分同名次');
  assert.equal(view.top[2].rank, 3, '丙跳到第 3');
  assert.equal(view.you, null, '你在前 3 时不重复展示「你」');
});

test('circleRanking：毕业数作为并列时的次级排序；成员不足 3 也如实返回', () => {
  const two = [
    { accountId: 'a1', alias: '甲', avatarColor: '#111111', batons: 3, graduations: 9 },
    { accountId: 'a2', alias: '乙', avatarColor: '#222222', batons: 3, graduations: 1 },
  ];
  const view = circleRanking(two, 'a2');
  assert.deepEqual(view.top.map((t) => t.alias), ['甲', '乙'], 'batons 并列按 graduations 降序');
  assert.equal(view.you, null);
});

test('circleStats：成员计数与成圈下限 3 人', () => {
  assert.equal(circleStats(['a', 'b']).viable, false, '不足 3 人不成圈');
  assert.equal(circleStats(['a', 'b', 'c']).viable, true);
  assert.equal(circleStats(['a', 'b', 'c']).memberCount, CIRCLE_MIN_MEMBERS);
  assert.equal(circleStats(null).viable, false);
});
