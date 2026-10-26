// W11 tts · sherpa-onnx 离线中文 TTS 引擎先行单测（RED 契约）。
// 依据：DAG 组1b：sherpa-onnx 经可注入 loader 引入（单测 mock，不真加载模型，
// 动态 import 惯例见 scripts/serve-tango.mjs:244-250）；createTtsEngine({modelsDir})：
// modelsAvailable 预检、缺失抛 TTS_MODELS_MISSING；synthesize(text)→wav Buffer
// （含采样率元数据）；wav 头解析为纯函数。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  modelsAvailable,
  createTtsEngine,
  samplesToWav,
  parseWavHeader,
} from '../../../../../scripts/agentic/tts/engine.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'w11-tts-'));

function fakeSherpa({ samples, sampleRate }) {
  const calls = { configs: [], texts: [] };
  const loader = async () => ({
    OfflineTts: class {
      constructor(config) { calls.configs.push(config); }
      generate(text) { calls.texts.push(text); return { samples, sampleRate }; }
    },
  });
  return { loader, calls };
}

test('modelsAvailable is true only when the models dir holds at least one .onnx file', () => {
  const empty = tmp();
  assert.equal(modelsAvailable(empty), false);
  const withModel = tmp();
  writeFileSync(join(withModel, 'vits-zh-int8.onnx'), 'fake');
  writeFileSync(join(withModel, 'tokens.txt'), 'fake');
  assert.equal(modelsAvailable(withModel), true);
  assert.equal(modelsAvailable(join(tmpdir(), 'w11-no-such-dir')), false);
  rmSync(empty, { recursive: true, force: true });
  rmSync(withModel, { recursive: true, force: true });
});

test('createTtsEngine refuses to start without models (TTS_MODELS_MISSING, loader untouched)', async () => {
  const { loader, calls } = fakeSherpa({ samples: new Float32Array(3), sampleRate: 16000 });
  const empty = tmp();
  assert.throws(
    () => createTtsEngine({ modelsDir: empty, loader }),
    err => err.code === 'TTS_MODELS_MISSING',
  );
  assert.equal(calls.configs.length, 0, '模型缺失时绝不加载 sherpa-onnx');
  rmSync(empty, { recursive: true, force: true });
});

test('synthesize returns a playable wav buffer with sample-rate metadata', async () => {
  const samples = new Float32Array([0, 0.5, -0.5, 0.25]);
  const sampleRate = 16000;
  const { loader, calls } = fakeSherpa({ samples, sampleRate });
  const modelsDir = tmp();
  writeFileSync(join(modelsDir, 'vits-zh-int8.onnx'), 'fake');
  const engine = createTtsEngine({ modelsDir, loader });

  const out = await engine.synthesize('下午三点，课程设计开始。');
  assert.ok(Buffer.isBuffer(out.wav));
  assert.equal(out.sampleRate, sampleRate);
  assert.equal(out.durationSec, samples.length / sampleRate);
  const head = parseWavHeader(out.wav);
  assert.equal(head.sampleRate, sampleRate);
  assert.equal(head.channels, 1);
  assert.equal(head.bitsPerSample, 16);
  assert.equal(head.dataBytes, samples.length * 2, '16-bit 单声道 PCM');
  assert.deepEqual(calls.texts, ['下午三点，课程设计开始。']);
  assert.ok(JSON.stringify(calls.configs[0]).includes(modelsDir), '引擎必须把 modelsDir 传给 sherpa 配置');
  rmSync(modelsDir, { recursive: true, force: true });
});

test('the sherpa module is loaded lazily and at most once across synthesize calls', async () => {
  let loads = 0;
  const samples = new Float32Array(2);
  const loader = async () => { loads += 1; return { OfflineTts: class { constructor() {} generate() { return { samples, sampleRate: 22050 }; } } }; };
  const modelsDir = tmp();
  mkdirSync(modelsDir, { recursive: true });
  writeFileSync(join(modelsDir, 'm.onnx'), 'x');
  const engine = createTtsEngine({ modelsDir, loader });
  assert.equal(loads, 0, '创建引擎不加载模型');
  await engine.synthesize('第一句。');
  await engine.synthesize('第二句。');
  assert.equal(loads, 1, '模块与模型只加载一次并复用');
  rmSync(modelsDir, { recursive: true, force: true });
});

test('samplesToWav writes a canonical RIFF/WAVE header (pure function)', () => {
  const wav = samplesToWav(new Float32Array([0, 1, -1]), 8000);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(parseWavHeader(wav).dataBytes, 6);
});

test('parseWavHeader returns null for buffers too short to be a wav', () => {
  assert.equal(parseWavHeader(Buffer.alloc(8)), null);
  assert.equal(parseWavHeader(Buffer.from('not a wav file at all, really')), null);
});
