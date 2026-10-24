import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../web/demo-onboarding.js', import.meta.url), 'utf8');
const context = vm.createContext({ window: {} });
vm.runInContext(source, context);
const onboarding = context.window.TangoDemoOnboarding;

test('renders the newcomer steps and persists a dismissible card per account', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value))
  };
  const card = onboarding.create(storage, 'fixture-user');
  const markup = card.render();

  for (const copy of [
    '选一个今天真实要完成的小任务',
    '打开模型能力卡，复制对应提示词',
    '完成后记录快/差不多/慢和验收结果',
    'AI 建议需逐条采纳，任务级效果未实测。',
    'AI 不可用时，也可按本地规则查看候选与提示词。'
  ]) assert.ok(markup.includes(copy), copy);

  card.setTask('<整理邮件>');
  assert.ok(card.render().includes('&lt;整理邮件&gt;'));
  card.dismiss();
  assert.equal(card.render(), '');
  assert.equal(onboarding.create(storage, 'fixture-user').render(), '');
  assert.notEqual(onboarding.create(storage, 'another-user').render(), '');
});
