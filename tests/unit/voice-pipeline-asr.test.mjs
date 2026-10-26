// 回放真实测试音频验证 ASR 引擎（流式实时字、VAD 断句、双路定稿）。本机没有模型时跳过。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { createAsrEngine, modelsAvailable } from '../../scripts/voice-pipeline/asr.mjs';

const MODELS = process.env.TANGO_VOICE_MODELS || '/Users/chillbit/Proj/Done & Go/asr-lab/models';
const AUDIO = process.env.TANGO_VOICE_TEST_AUDIO || '/Users/chillbit/Proj/Done & Go/asr-lab/audio';
const ready = modelsAvailable(MODELS) && existsSync(AUDIO);

function pcmOf(file) { // 取 WAV 的 data 块（16k/16bit/mono）
  const buf = readFileSync(file);
  for (let off = 12; off + 8 <= buf.length;) { const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4); if (id === 'data') return buf.subarray(off + 8, off + 8 + size); off += 8 + size + (size % 2); }
  throw new Error('no data chunk');
}

test('replays a multi-clause recording: live partials, VAD segments and both finals arrive', { skip: !ready && 'no local voice models' }, async () => {
  const engine = await createAsrEngine({ modelsDir: MODELS, threads: 2 });
  try {
    const partials = [], finals = [], alts = [];
    const session = engine.createSession({
      onPartial: (seg, text) => partials.push({ seg, text }),
      onFinal: (seg, x) => finals.push({ seg, ...x }),
      onAlt: (seg, x) => alts.push({ seg, ...x }),
    });
    const pcm = pcmOf(`${AUDIO}/f-multi-event.wav`);
    for (let o = 0; o < pcm.length; o += 3200) session.accept(pcm.subarray(o, o + 3200)); // 100ms 一包
    session.accept(Buffer.alloc(16000)); // 0.5s 尾静音
    await session.finish();
    assert.ok(partials.length > 3, 'live partial text streams while speaking');
    assert.ok(finals.length >= 1 && finals.length === alts.length, 'every segment gets both finals');
    const a = finals.map(f => f.a).join('');
    const b = alts.map(f => f.b).join('');
    assert.match(a, /三点/);
    assert.match(a + b, /课程报告/);
    assert.ok(finals.every(f => f.msA < 1000), 'A finals are fast');
  } finally {
    await engine.close();
  }
});
