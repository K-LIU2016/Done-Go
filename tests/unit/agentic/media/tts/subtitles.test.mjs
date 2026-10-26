// W11 tts · 字幕时间戳先行单测（RED 契约）。
// 依据：DAG 组1b(3)(4)：按句切分逐句合成累计时长 → [{text,startSec,endSec}]
// （composeReel 镜头切分与播放器字幕共用此契约）；wav 头解析/句切分/时间累计为纯函数。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { splitSentences, buildSubtitles } from '../../../../../scripts/agentic/tts/subtitles.mjs';

test('splitSentences cuts on 。！？； and newlines, keeps punctuation, drops empties', () => {
  const out = splitSentences('下午一点半，我先去找资料。两点你确认学员画像！三点半课程设计接力；五点交付。');
  assert.deepEqual(out, [
    '下午一点半，我先去找资料。',
    '两点你确认学员画像！',
    '三点半课程设计接力；',
    '五点交付。',
  ]);
  assert.deepEqual(splitSentences('  \n\n '), []);
  assert.deepEqual(splitSentences(''), []);
});

test('splitSentences keeps trailing text without end punctuation as its own sentence', () => {
  assert.deepEqual(splitSentences('第一句。第二句还没说完'), ['第一句。', '第二句还没说完']);
});

test('buildSubtitles accumulates sentence durations into contiguous [startSec, endSec] cues', () => {
  const cues = buildSubtitles([
    { text: '第一句。', durationSec: 2.5 },
    { text: '第二句。', durationSec: 3 },
    { text: '第三句。', durationSec: 1.5 },
  ]);
  assert.deepEqual(cues, [
    { text: '第一句。', startSec: 0, endSec: 2.5 },
    { text: '第二句。', startSec: 2.5, endSec: 5.5 },
    { text: '第三句。', startSec: 5.5, endSec: 7 },
  ]);
  // 逐句衔接：下一句 start 恰等于上一句 end，首句从 0 开始
  for (let i = 1; i < cues.length; i += 1) assert.equal(cues[i].startSec, cues[i - 1].endSec);
});

test('buildSubtitles returns [] for empty narration and tolerates zero-length sentences', () => {
  assert.deepEqual(buildSubtitles([]), []);
  const cues = buildSubtitles([{ text: '静音', durationSec: 0 }]);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].startSec, cues[0].endSec);
});

test('every cue satisfies the shared subtitle contract (numbers, non-negative, ordered)', () => {
  const cues = buildSubtitles([
    { text: 'a', durationSec: 1.2 },
    { text: 'b', durationSec: 0.8 },
  ]);
  for (const c of cues) {
    assert.equal(typeof c.text, 'string');
    assert.equal(typeof c.startSec, 'number');
    assert.equal(typeof c.endSec, 'number');
    assert.ok(c.startSec >= 0 && c.endSec >= c.startSec);
  }
});

test('defensive inputs: undefined/null narration behaves as empty', () => {
  assert.deepEqual(splitSentences(), []);
  assert.deepEqual(splitSentences(null), []);
  assert.deepEqual(buildSubtitles(), []);
  assert.deepEqual(buildSubtitles(null), []);
});
