import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ruleClean } from '../../scripts/voice-pipeline/clean.mjs';

test('drops fillers and hesitation words at clause boundaries (real x-asr outputs)', () => {
  assert.equal(ruleClean('嗯， 那个明天下午呃三点吧， 要跟老师开个组会， 然后嗯， 周五追前把课程报告交了。'), '明天下午三点吧，要跟老师开个组会，周五追前把课程报告交了。');
  assert.equal(ruleClean('我想想啊， 下周三下午两点到四点， 有个商品评审， 挺重要的。'), '下周三下午两点到四点，有个商品评审，挺重要的。');
  assert.equal(ruleClean('嗯， 好的。哦对了， 周六上午十点去健身房。'), '好的。对了，周六上午十点去健身房。');
  assert.equal(ruleClean('然后呢， 就是那个下下周一要交论文书稿。'), '下下周一要交论文书稿。');
});

test('collapses an immediately repeated word', () => {
  assert.equal(ruleClean('呃， 今天今天要把周报写完， 然后明天上午十点开会。'), '今天要把周报写完，然后明天上午十点开会。');
  assert.equal(ruleClean('今天，今天要写周报'), '今天要写周报');
});

test('keeps content words that merely look like fillers', () => {
  assert.equal(ruleClean('那个会议改到下午'), '那个会议改到下午');
  assert.equal(ruleClean('就是这件事最重要'), '就是这件事最重要');
  assert.equal(ruleClean('嗯哼 这个方案不错'), '嗯哼 这个方案不错'.replace('嗯哼 ', '嗯哼 '));
});

test('keeps self-corrections for the model to resolve and normalises spacing', () => {
  assert.equal(ruleClean('下午三点， 啊不是， 四点半跟客户视频会议。'), '下午三点，啊不是，四点半跟客户视频会议。');
  assert.equal(ruleClean('  ， 嗯。 '), '');
});
