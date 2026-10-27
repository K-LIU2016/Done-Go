// sensitive 契约：敏感画面快判（证件/病历/银行卡/屏幕密码 → localOnly+类别，PRD §6.8.4 L516）。
// 类别固定 id：screen-password | identity-document | bank-card | medical-record（命中任一 → 只走本地 minicpm-v 且默认不存原图）。
// 对应实现：scripts/agentic/perception/sensitive.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySensitive, SENSITIVE_CATEGORIES } from '../../../../scripts/agentic/perception/sensitive.mjs';

test('exports the four PRD privacy categories in a stable order', () => {
  assert.deepEqual(SENSITIVE_CATEGORIES, ['screen-password', 'identity-document', 'bank-card', 'medical-record']);
});

test('mundane scenes are not sensitive', () => {
  for (const text of ['白板上写着 Q4 三项目标', '冰箱里有番茄、鸡蛋和半颗洋葱', '车站屏幕显示列车延误 25 分钟', '书架隔板已涂胶']) {
    assert.deepEqual(classifySensitive(text), { sensitive: false, category: null, localOnly: false }, text);
  }
  assert.deepEqual(classifySensitive(''), { sensitive: false, category: null, localOnly: false });
});

test('identity documents trip localOnly', () => {
  for (const text of ['桌上摆着身份证', '拍到了护照资料页', '驾驶证放在最上面']) {
    const out = classifySensitive(text);
    assert.deepEqual(out, { sensitive: true, category: 'identity-document', localOnly: true }, text);
  }
});

test('medical records trip localOnly', () => {
  for (const text of ['挂号单和病历本', '医生开的处方', '体检报告首页']) {
    assert.deepEqual(classifySensitive(text), { sensitive: true, category: 'medical-record', localOnly: true }, text);
  }
});

test('bank cards trip localOnly (中英文)', () => {
  assert.deepEqual(classifySensitive('钱包里露出银行卡卡号'), { sensitive: true, category: 'bank-card', localOnly: true });
  assert.deepEqual(classifySensitive('信用卡账单截图'), { sensitive: true, category: 'bank-card', localOnly: true });
});

test('passwords on screens trip localOnly (中英文)', () => {
  assert.deepEqual(classifySensitive('屏幕上是密码输入框'), { sensitive: true, category: 'screen-password', localOnly: true });
  assert.deepEqual(classifySensitive('login screen asking for password'), { sensitive: true, category: 'screen-password', localOnly: true });
});

test('multiple hits resolve to the first category in SENSITIVE_CATEGORIES priority order', () => {
  const out = classifySensitive('桌上有病历和银行卡');
  assert.equal(out.sensitive, true);
  assert.equal(out.category, 'bank-card', 'bank-card 排在 medical-record 之前');
  const out2 = classifySensitive('身份证旁边是解锁密码便签');
  assert.equal(out2.category, 'screen-password', 'screen-password 优先级最高');
});

test('accepts a fast-perception result object and scans all its string fields', () => {
  const fastResult = { seen: '拍到了一张挂号单', change: null, suggestion: null, actions: [] };
  assert.deepEqual(classifySensitive(fastResult), { sensitive: true, category: 'medical-record', localOnly: true });
  const cleanResult = { seen: '木工进度照', change: '隔板涂胶完成', suggestion: '检查水平', actions: ['夹固 15 分钟'] };
  assert.equal(classifySensitive(cleanResult).sensitive, false);
});
