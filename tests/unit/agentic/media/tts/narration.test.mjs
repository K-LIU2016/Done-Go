// W11 tts · 逐句旁白合成编排先行单测（RED 契约补全）。
// 依据：DAG 组1b(3)：按句切分逐句合成累计时长 → [{text,startSec,endSec}]，
// composeReel 镜头切分与播放器字幕共用此契约；整段旁白 wav 由逐句 wav 拼接。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { concatWavs, synthesizeNarration } from '../../../../../scripts/agentic/tts/engine.mjs';
import { samplesToWav } from '../../../../../scripts/agentic/tts/engine.mjs';
import { parseWavHeader } from '../../../../../scripts/agentic/tts/engine.mjs';

function fakeEngine(pieces) {
  let i = 0;
  return { synthesize: async () => pieces[i++ % pieces.length] };
}

test('synthesizeNarration splits, synthesizes per sentence and returns cues + full wav', async () => {
  const pieces = [
    { wav: samplesToWav(new Float32Array(16000), 16000), sampleRate: 16000, durationSec: 1 },
    { wav: samplesToWav(new Float32Array(32000), 16000), sampleRate: 16000, durationSec: 2 },
  ];
  const out = await synthesizeNarration('第一句。第二句！', { engine: fakeEngine(pieces) });
  assert.deepEqual(out.cues, [
    { text: '第一句。', startSec: 0, endSec: 1 },
    { text: '第二句！', startSec: 1, endSec: 3 },
  ]);
  assert.equal(out.sampleRate, 16000);
  assert.equal(out.durationSec, 3);
  assert.equal(parseWavHeader(out.wav).dataBytes, (16000 + 32000) * 2, '整段 wav = 逐句拼接');
});

test('synthesizeNarration with no speech yields empty cues and no wav', async () => {
  const out = await synthesizeNarration('  \n ', { engine: fakeEngine([]) });
  assert.deepEqual(out.cues, []);
  assert.equal(out.wav, null);
  assert.equal(out.durationSec, 0);
});

test('concatWavs merges same-rate mono wavs into one; refuses mixed rates', () => {
  const a = samplesToWav(new Float32Array(4), 8000);
  const b = samplesToWav(new Float32Array(6), 8000);
  const merged = concatWavs([a, b]);
  assert.equal(parseWavHeader(merged).dataBytes, 20);
  assert.equal(merged.length, 44 + 20);
  assert.throws(
    () => concatWavs([a, samplesToWav(new Float32Array(4), 16000)]),
    err => err.code === 'WAV_RATE_MISMATCH',
  );
});
