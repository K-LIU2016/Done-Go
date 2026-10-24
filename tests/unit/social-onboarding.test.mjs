import assert from 'node:assert/strict';
import { test } from 'node:test';

// SO·S8分享引导 line: web/social/onboarding.js — 首次 3 屏引导
// （PRD design/social-sync/PRD.md §5 "开启前一屏讲清楚会分享什么"、§6
// "新用户首次进入的引导（3 屏）：同频是什么、会分享什么、开启"）。
//
// Hard gates proven here:
// - 第 2 屏白名单可视化的数据全部来自 web/social/contracts.js 的枚举
//   （FEATURES_UPLOAD_FIELDS / FORBIDDEN_UPLOAD_FIELDS / KUDOS_EVENT_KINDS），
//   本模块绝不重新定义键名；"永不分享"清单覆盖 PRD 点名的
//   标题/材料/AI 结果/具体时间/地点 五类。
// - 引导状态机：3 步 what→shares→enable；optIn 只能在最后一屏（或完成过
//   引导后从设置再开启）触发 —— 没看过"会分享什么"就开不了。
// - storage 注入、读不写、坏 JSON 不炸、写失败不丢内存态（relay store 惯例）。

import {
  FEATURES_UPLOAD_FIELDS, FORBIDDEN_UPLOAD_FIELDS,
  KUDOS_EVENT_KINDS, KUDOS_EVENT_LABELS,
} from '../../web/social/contracts.js';
import {
  SOCIAL_ONBOARDING_KEY, ONBOARDING_STEPS,
  shareWhitelistView, sanitizeOnboardingState, onboardingView, createOnboarding,
} from '../../web/social/onboarding.js';

// ---------------------------------------------------------------------------
// Storage fakes（relay store 测试同款注入约定）。
// ---------------------------------------------------------------------------
function mapStorage(initial = new Map()) {
  const map = initial instanceof Map ? initial : new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    dump: () => map,
  };
}

function failingStorage() {
  return {
    getItem: () => null,
    setItem: () => { throw new Error('quota'); },
    removeItem: () => {},
  };
}

// ---------------------------------------------------------------------------
// 1. 常量与 3 屏结构。
// ---------------------------------------------------------------------------
test('onboarding key sits in the tango-donego namespace and steps are what/shares/enable', () => {
  assert.ok(SOCIAL_ONBOARDING_KEY.startsWith('tango-donego.social.'));
  assert.deepEqual(ONBOARDING_STEPS, ['what', 'shares', 'enable']);
});

test('every step has complete copy (kicker/title/body/bullets/primary/secondary)', () => {
  for (let i = 0; i < ONBOARDING_STEPS.length; i += 1) {
    const view = onboardingView({ step: i, seen: false, optedIn: false });
    assert.equal(view.stepId, ONBOARDING_STEPS[i]);
    assert.ok(view.kicker.includes((i + 1) + '/3'), 'kicker must show progress: ' + view.kicker);
    for (const field of ['kicker', 'title', 'body', 'primary', 'secondary']) {
      assert.equal(typeof view[field], 'string', field + ' missing on step ' + view.stepId);
      assert.ok(view[field].length > 0);
    }
    assert.ok(Array.isArray(view.bullets) && view.bullets.length >= 3, 'each screen needs >=3 bullets');
  }
  assert.equal(onboardingView({ step: 9, seen: false, optedIn: false }), null); // out of range → null
  assert.equal(onboardingView(null), null);
});

// ---------------------------------------------------------------------------
// 2. 第 2 屏白名单可视化 — 一切键名来自 contracts，绝不本地重定义。
// ---------------------------------------------------------------------------
test('shareWhitelistView: shared fields are EXACTLY contracts FEATURES_UPLOAD_FIELDS', () => {
  const view = shareWhitelistView();
  assert.deepEqual(view.shared.map((s) => s.field), FEATURES_UPLOAD_FIELDS);
  for (const entry of view.shared) {
    assert.equal(typeof entry.label, 'string');
    assert.ok(entry.label.length > 0, entry.field + ' needs a zh label');
  }
});

test('shareWhitelistView: shared events are EXACTLY contracts KUDOS kinds/labels', () => {
  const view = shareWhitelistView();
  assert.deepEqual(view.sharedEvents.map((e) => e.kind), KUDOS_EVENT_KINDS);
  assert.deepEqual(view.sharedEvents.map((e) => e.label), KUDOS_EVENT_KINDS.map((k) => KUDOS_EVENT_LABELS[k]));
});

test('shareWhitelistView: never list covers ALL FORBIDDEN_UPLOAD_FIELDS with zh labels', () => {
  const view = shareWhitelistView();
  assert.deepEqual(view.never.map((n) => n.field), FORBIDDEN_UPLOAD_FIELDS);
  for (const entry of view.never) assert.ok(entry.label && entry.label.length > 0, entry.field);
});

test('shareWhitelistView: shared and never are disjoint — no field is both', () => {
  const view = shareWhitelistView();
  const shared = new Set(view.shared.map((s) => s.field));
  for (const n of view.never) assert.equal(shared.has(n.field), false, n.field + ' appears on both sides');
});

test('shareWhitelistView: neverSummary names the five PRD categories and stays pure', () => {
  const a = shareWhitelistView();
  const b = shareWhitelistView();
  assert.deepEqual(a, b);
  for (const word of ['事项标题', '材料', 'AI 结果', '具体时间', '地点']) {
    assert.ok(a.neverSummary.includes(word), 'neverSummary missing ' + word);
  }
});

test('screen 2 view visualizes the whitelist: aggregates shared, raw content never', () => {
  const view = onboardingView({ step: 1, seen: false, optedIn: false });
  const joined = [view.body, ...view.bullets].join('\n');
  assert.ok(joined.includes('聚合'), 'must say only aggregates are shared');
  for (const word of ['事项标题', '材料', 'AI 结果', '具体时间', '地点']) {
    assert.ok(joined.includes(word), 'screen-2 copy must name the never-category: ' + word);
  }
});

// ---------------------------------------------------------------------------
// 3. 引导状态机（storage 注入）。
// ---------------------------------------------------------------------------
test('fresh onboarding: step 0, not seen, not opted in, opt-in not yet allowed', () => {
  const ob = createOnboarding({ storage: mapStorage() });
  assert.equal(ob.status, 'empty');
  const s = ob.state();
  assert.equal(s.step, 0);
  assert.equal(s.stepId, 'what');
  assert.equal(s.totalSteps, 3);
  assert.equal(s.firstVisit, true);
  assert.equal(s.seen, false);
  assert.equal(s.optedIn, false);
  assert.equal(s.canOptIn, false);
});

test('walk the 3 screens forward and back; edges are sticky', () => {
  const ob = createOnboarding({ storage: mapStorage() });
  assert.equal(ob.next(), true);
  assert.equal(ob.state().stepId, 'shares');
  assert.equal(ob.next(), true);
  assert.equal(ob.state().stepId, 'enable');
  assert.equal(ob.state().canOptIn, true);
  assert.equal(ob.next(), false); // last screen: no further step
  assert.equal(ob.state().step, 2);
  assert.equal(ob.back(), true);
  assert.equal(ob.state().stepId, 'shares');
  assert.equal(ob.back(), true);
  assert.equal(ob.state().stepId, 'what');
  assert.equal(ob.back(), false);
  assert.equal(ob.state().step, 0);
});

test('D2/PRD §5: optIn is REFUSED before the user has seen the "会分享什么" screen', () => {
  const ob = createOnboarding({ storage: mapStorage() });
  assert.equal(ob.optIn(), false);
  assert.equal(ob.state().optedIn, false);
  assert.equal(ob.next(), true);
  assert.equal(ob.optIn(), false); // still on screen 2
  assert.equal(ob.state().optedIn, false);
});

test('optIn on the last screen opts in, marks seen and persists', () => {
  const storage = mapStorage();
  const ob = createOnboarding({ storage });
  ob.next(); ob.next();
  assert.equal(ob.optIn(), true);
  const s = ob.state();
  assert.equal(s.optedIn, true);
  assert.equal(s.seen, true);
  assert.equal(s.firstVisit, false);
  // persisted shape: exactly {v, step, seen, optedIn}
  const raw = JSON.parse(storage.getItem(SOCIAL_ONBOARDING_KEY));
  assert.deepEqual(Object.keys(raw).sort(), ['optedIn', 'seen', 'step', 'v']);
  assert.equal(raw.optedIn, true);
  // a second controller over the same storage restores the state
  const again = createOnboarding({ storage });
  assert.equal(again.status, 'ok');
  assert.equal(again.state().optedIn, true);
  assert.equal(again.state().step, 2);
});

test('complete() after the shares screen marks seen (暂不开启) and persists', () => {
  const storage = mapStorage();
  const ob = createOnboarding({ storage });
  ob.next(); // 到「会分享什么」屏
  assert.equal(ob.complete(), true);
  assert.equal(ob.state().seen, true);
  assert.equal(ob.state().optedIn, false);
  const again = createOnboarding({ storage });
  assert.equal(again.state().seen, true);
  assert.equal(again.state().firstVisit, false);
});

test('PRD §5 gate: bailing out on screen 1 does NOT mark seen — no opt-in credit without the shares screen', () => {
  const storage = mapStorage();
  const ob = createOnboarding({ storage });
  assert.equal(ob.complete(), false); // 第 1 屏就退出：没有被讲清楚会分享什么
  assert.equal(ob.state().seen, false);
  assert.equal(ob.state().canOptIn, false);
  assert.equal(ob.optIn(), false, 'step 0 且未 seen —— 不能开启');
  const again = createOnboarding({ storage });
  assert.equal(again.state().seen, false);
});

test('after completing once, optIn can be re-enabled later (settings re-toggle) and opted out again', () => {
  const storage = mapStorage();
  const ob = createOnboarding({ storage });
  ob.next();
  ob.complete();
  assert.equal(ob.state().canOptIn, true); // seen → may opt in from settings
  assert.equal(ob.optIn(), true);
  assert.equal(ob.state().optedIn, true);
  assert.equal(ob.optOut(), true);
  assert.equal(ob.state().optedIn, false);
  const again = createOnboarding({ storage });
  assert.equal(again.state().optedIn, false);
  assert.equal(again.state().seen, true);
});

test('reset() replays the guide from screen 1 as a fresh visit', () => {
  const storage = mapStorage();
  const ob = createOnboarding({ storage });
  ob.next(); ob.next(); ob.optIn();
  assert.equal(ob.reset(), true);
  const s = ob.state();
  assert.equal(s.step, 0);
  assert.equal(s.seen, false);
  assert.equal(s.optedIn, false);
  assert.equal(s.firstVisit, true);
  assert.deepEqual(
    JSON.parse(storage.getItem(SOCIAL_ONBOARDING_KEY)),
    { v: 1, step: 0, seen: false, optedIn: false },
  );
});

test('reads never write; corrupt or unknown-shape state degrades to a fresh guide', () => {
  const storage = mapStorage(new Map([[SOCIAL_ONBOARDING_KEY, '{bad json']]));
  const ob = createOnboarding({ storage });
  assert.equal(ob.status, 'corrupt');
  assert.equal(ob.state().step, 0);
  assert.equal(storage.dump().get(SOCIAL_ONBOARDING_KEY), '{bad json', 'read must not repair/overwrite');
  // unknown keys / wrong types in stored JSON are ignored → fresh
  for (const raw of [
    '{"v":1,"step":1,"seen":true,"optedIn":false,"title":"x"}',
    '{"v":1,"step":7,"seen":true,"optedIn":false}',
    '{"v":2,"step":0,"seen":false,"optedIn":false}',
    '{"step":0}',
    'null',
  ]) {
    const st = mapStorage(new Map([[SOCIAL_ONBOARDING_KEY, raw]]));
    const o = createOnboarding({ storage: st });
    assert.equal(o.status, 'corrupt', raw);
    assert.equal(o.state().step, 0);
  }
});

test('sanitizeOnboardingState accepts exactly the canonical shape', () => {
  assert.deepEqual(
    sanitizeOnboardingState({ v: 1, step: 2, seen: true, optedIn: false }),
    { v: 1, step: 2, seen: true, optedIn: false },
  );
  assert.equal(sanitizeOnboardingState({ v: 1, step: 2, seen: 1, optedIn: false }), null);
  assert.equal(sanitizeOnboardingState({ v: 1, step: 2, seen: true, optedIn: 'yes' }), null);
  assert.equal(sanitizeOnboardingState('nope'), null);
  assert.equal(sanitizeOnboardingState(null), null);
});

test('without storage the guide still works in memory; write failures never throw', () => {
  const ob = createOnboarding({ storage: null });
  assert.equal(ob.status, 'memory');
  assert.equal(ob.next(), true);
  assert.equal(ob.state().step, 1);

  const failing = createOnboarding({ storage: failingStorage() });
  assert.equal(failing.next(), true);
  assert.equal(failing.state().step, 1);
  assert.equal(failing.state().saved, false, 'saved flag must reflect the failed persist');
  failing.next();
  assert.equal(failing.optIn(), true);
  assert.equal(failing.state().optedIn, true, 'memory state survives persist failure');
  assert.equal(failing.state().saved, false);
});

// ---------------------------------------------------------------------------
// 4. mount(el) — 最小 element stub 上的事件接线（rv2-home 同款约定）。
// ---------------------------------------------------------------------------
function stubEl() {
  const el = {
    html: '',
    handlers: {},
    nodes: {},
    addEventListener(type, handler) { (el.handlers[type] ||= []).push(handler); },
    set innerHTML(v) { el.html = v; },
    get innerHTML() { return el.html; },
    querySelector(sel) {
      const m = /^#([\w-]+)$/.exec(sel);
      if (!m) return null;
      if (!el.html.includes('id="' + m[1] + '"')) return null;
      if (!el.nodes[m[1]]) {
        el.nodes[m[1]] = {
          id: m[1], handlers: {},
          addEventListener(type, handler) { el.nodes[m[1]].handlers[type] ||= []; el.nodes[m[1]].handlers[type].push(handler); },
        };
      }
      return el.nodes[m[1]];
    },
  };
  return el;
}

// 事件委托接线：handler 挂在宿主 el 上（relay home 同款），fire 在 el 上
// 触发并携带 target 节点（其 id 决定路由到哪个按钮）。
function fire(el, type, node) {
  const event = { target: node, preventDefault() {}, stopPropagation() {} };
  for (const handler of el.handlers[type] || []) handler(event);
}

test('mount renders screen 1, advances via primary, and opts in on the last screen', () => {
  const events = { optIn: 0, done: 0 };
  const ob = createOnboarding({
    storage: mapStorage(),
    onOptIn: () => { events.optIn += 1; },
    onDone: () => { events.done += 1; },
  });
  const el = stubEl();
  ob.mount(el);
  assert.match(el.html, /同频是什么/);
  assert.match(el.html, /1\/3/);

  fire(el, 'click', el.querySelector('#soc-onb-primary')); // what → shares
  assert.match(el.html, /会分享什么/);
  assert.match(el.html, /事项标题/, 'screen 2 must visualize the never-list');

  fire(el, 'click', el.querySelector('#soc-onb-primary')); // shares → enable
  assert.match(el.html, /开启同频/);

  fire(el, 'click', el.querySelector('#soc-onb-primary')); // opt in
  assert.equal(ob.state().optedIn, true);
  assert.equal(events.optIn, 1);
  assert.equal(events.done, 0);
  ob.unmount();
});

test('mount secondary button completes without opt-in (after shares screen); unmount clears', () => {
  const events = { done: 0 };
  const ob = createOnboarding({ storage: mapStorage(), onDone: () => { events.done += 1; } });
  const el = stubEl();
  ob.mount(el);
  // 第 1 屏点「暂不开启」：关卡片（onDone）但不记 seen（没看过会分享什么）
  fire(el, 'click', el.querySelector('#soc-onb-secondary'));
  assert.equal(events.done, 1);
  assert.equal(ob.state().seen, false);
  // 走到「会分享什么」屏再退出：seen 成立
  fire(el, 'click', el.querySelector('#soc-onb-primary')); // what → shares
  fire(el, 'click', el.querySelector('#soc-onb-secondary'));
  assert.equal(ob.state().seen, true);
  assert.equal(ob.state().optedIn, false);
  assert.equal(events.done, 2);
  ob.unmount();
  assert.equal(el.html, '');
});
