import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pcmFromWave } from '../../scripts/tango-speech.mjs';

function wave(samples) {
  const data = Buffer.alloc(samples * 2, 7);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii'); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test('pcmFromWave returns exactly the data chunk of a 16k mono wave', () => {
  const pcm = pcmFromWave(wave(160));
  assert.equal(pcm.length, 320);
  assert.equal(pcm[0], 7);
});

test('speech is available on non-Windows hosts only when a FunASR endpoint is configured', async () => {
  const before = process.env.TANGO_SPEECH_FUNASR_URL;
  process.env.TANGO_SPEECH_FUNASR_URL = 'ws://127.0.0.1:1';
  const fresh = await import('../../scripts/tango-speech.mjs?funasr=' + Date.now());
  const caps = await fresh.speechCapabilities();
  if (before === undefined) delete process.env.TANGO_SPEECH_FUNASR_URL; else process.env.TANGO_SPEECH_FUNASR_URL = before;
  if (process.platform === 'win32') return;
  assert.equal(caps.available, true);
  assert.ok(caps.languages.includes('zh-CN'));
});
