import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { readFile, mkdtemp, unlink, rmdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validSpeechWave, speechCapabilities, transcribeSpeech, MAX_AUDIO_BYTES } from '../../scripts/tango-speech.mjs';

const context = vm.createContext({});
vm.runInContext(await readFile(new URL('../../web/speech-capture.js', import.meta.url), 'utf8'), context);
const speech = context.TangoSpeech;

test('captured PCM is mono 16kHz WAV with signed, clamped samples', () => {
  const wave = Buffer.from(speech.encodeWave([new Float32Array([2, -2, .5, 0])], 16000));
  assert.equal(wave.readUInt32LE(24), 16000);
  assert.equal(wave.readUInt32LE(40), 8);
  assert.equal(wave.readInt16LE(44), 32767);
  assert.equal(wave.readInt16LE(46), -32768);
  assert.equal(wave.readInt16LE(48), 16384);
  assert.equal(validSpeechWave(wave), true);
});

test('invalid, truncated and oversized audio never reaches the native recognizer', async () => {
  const wave = Buffer.from(speech.encodeWave([new Float32Array([0, .3, 0])], 16000));
  assert.equal(validSpeechWave(wave.subarray(0, 43)), false);
  const stereo = Buffer.from(wave); stereo.writeUInt16LE(2, 22);
  assert.equal(validSpeechWave(stereo), false);
  const length = Buffer.from(wave); length.writeUInt32LE(10000, 40);
  assert.equal(validSpeechWave(length), false);
  assert.equal(validSpeechWave(Buffer.alloc(MAX_AUDIO_BYTES + 1)), false);
  await assert.rejects(transcribeSpeech(stereo, 'zh-CN'), error => error.status === 400);
});

test('native AM and PM output retains its period for task-time parsing', () => {
  assert.equal(speech.normalizeTranscript('2:00PM到三点开会'), '下午2:00到三点开会');
  assert.equal(speech.normalizeTranscript('12:00AM / 12:00PM / 9:15 AM'), '上午0:00 / 下午12:00 / 上午9:15');
});

for (const [label, phrase, repeats] of [
  ['short speech', '下午两点到三点开会', 1],
  ['multiple sentences through end of audio', '下午两点到三点开会。然后四点到五点读书。', 4],
]) test(`installed Windows dictation transcribes ${label} locally`, async t => {
  const config = await speechCapabilities();
  if (!config.available || !config.languages.includes('zh-CN')) { t.skip('Chinese Windows recognizer not installed'); return; }
  const directory = await mkdtemp(join(tmpdir(), 'tango-speech-test-'));
  const file = join(directory, 'fixture.wav');
  try {
    const synthesize = 'Add-Type -AssemblyName System.Speech; $s=[System.Speech.Synthesis.SpeechSynthesizer]::new(); try { $v=$s.GetInstalledVoices() | Where-Object {$_.VoiceInfo.Culture.Name -eq "zh-CN"} | Select-Object -First 1; $s.SelectVoice($v.VoiceInfo.Name); $f=[System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono); $s.SetOutputToWaveFile($env:TANGO_TEST_AUDIO,$f); $s.Speak($env:TANGO_TEST_PHRASE) } finally { $s.Dispose() }';
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', synthesize], { windowsHide: true, timeout: 10000, env: { ...process.env, TANGO_TEST_AUDIO: file, TANGO_TEST_PHRASE: phrase.repeat(repeats) } });
    const result = await transcribeSpeech(await readFile(file), 'zh-CN');
    assert.match(result.text, /开会/);
    assert.match(speech.normalizeTranscript(result.text), /下午|PM/i);
    assert.equal((result.text.match(/开会/g) || []).length, repeats);
    if (repeats > 1) assert.equal((result.text.match(/读书/g) || []).length, repeats);
  } finally {
    await unlink(file).catch(() => {}); await rmdir(directory).catch(() => {});
  }
});
