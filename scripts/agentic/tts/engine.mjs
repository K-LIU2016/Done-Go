// W11 tts · sherpa-onnx 离线中文 TTS 引擎（PRD §2.4/§10.3 旁白）。
// sherpa-onnx-node 经可注入 loader 动态引入（单测 mock 不真加载；惯例见 scripts/serve-tango.mjs:244-250），
// 引擎创建时只做 modelsAvailable 预检（缺失抛 TTS_MODELS_MISSING，绝不触发 loader）；
// 模型与模块在首次 synthesize 时惰性加载且进程内只加载一次。
// wav 头解析/封装与句切分累计（subtitles.mjs）均为纯函数，供播放器与 composeReel 复用。
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { buildSubtitles, splitSentences } from './subtitles.mjs';

/** modelsDir 下至少有一个 .onnx 才算模型就位（目录缺失/为空都返回 false）。 */
export function modelsAvailable(modelsDir) {
  if (!modelsDir) return false;
  try { return readdirSync(modelsDir).some(f => f.endsWith('.onnx')); } catch { return false; }
}

// rule fsts 的应用次序沿用 sherpa-onnx 官方示例：phone → date → number，其余按文件名。
const FST_ORDER = ['phone', 'date', 'number'];

/** 从模型目录文件名推断 sherpa OfflineTts 配置（vits / matcha 两族，int8 优先）。纯函数。 */
export function discoverTtsConfig(modelsDir, { threads = 2 } = {}) {
  const files = readdirSync(modelsDir);
  const onnx = files.filter(f => f.endsWith('.onnx'));
  const byName = name => name && join(modelsDir, name);
  const fsts = files.filter(f => f.endsWith('.fst')).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const vocoder = onnx.find(f => /hifigan|hfg|vocoder/i.test(f));
  const matcha = vocoder && onnx.some(f => f !== vocoder && /model|steps|acoustic/i.test(f) && !/vits|piper/i.test(f));
  const sub = matcha
    ? { acousticModel: byName(onnx.find(f => f !== vocoder && /model|steps|acoustic/i.test(f))), vocoder: byName(vocoder) }
    : { model: byName(onnx.find(f => /int8/i.test(f)) ?? onnx.find(f => /model/i.test(f)) ?? onnx[0]) };
  const tokens = byName(files.find(f => f === 'tokens.txt')), lexicon = byName(files.find(f => f === 'lexicon.txt'));
  if (tokens) sub.tokens = tokens;
  if (lexicon) sub.lexicon = lexicon;
  const dict = byName(files.find(f => f === 'dict' || f === 'espeak-ng-data')); // matcha 用 dict/；piper-espeak 用 espeak-ng-data/
  if (dict) sub.dataDir = dict;
  if (fsts.length) sub.ruleFsts = fsts.map(byName).join(',');
  return { model: { [matcha ? 'matcha' : 'vits']: sub }, numThreads: threads, provider: 'cpu', debug: 0 };
}

const rank = name => { const i = FST_ORDER.findIndex(k => name.startsWith(k)); return i < 0 ? FST_ORDER.length : i; };

const defaultLoader = async () => {
  const mod = await import('sherpa-onnx-node');
  return mod.OfflineTts ? mod : mod.default; // CJS 互操作：ESM namespace 上只有 default
};

/**
 * 创建离线 TTS 引擎。loader 可注入（单测用；默认动态 import sherpa-onnx-node）。
 * synthesize(text, {speed}) → { wav: Buffer(16bit 单声道 PCM), sampleRate, durationSec }。
 */
export function createTtsEngine({ modelsDir, loader = defaultLoader, threads = 2 } = {}) {
  if (!modelsAvailable(modelsDir)) {
    const err = new Error('TTS_MODELS_MISSING: ' + (modelsDir ?? '<empty>') + ' 下没有 .onnx 模型；先用 node scripts/agentic/tts/download-model.mjs 安装');
    err.code = 'TTS_MODELS_MISSING';
    throw err;
  }
  let ready = null; // 惰性单例：首次 synthesize 才加载模块与模型，之后复用
  const instance = () => ready ??= (async () => {
    const sherpa = await loader();
    return new sherpa.OfflineTts(discoverTtsConfig(modelsDir, { threads }));
  })();
  return {
    modelsDir,
    async synthesize(text, { speed = 1 } = {}) {
      const tts = await instance();
      const audio = tts.generate({ text, sid: 0, speed }); // sherpa-onnx-node 2.0.0 TtsRequest 对象 → GeneratedAudio { samples, sampleRate }
      return { wav: samplesToWav(audio.samples, audio.sampleRate), sampleRate: audio.sampleRate, durationSec: audio.samples.length / audio.sampleRate };
    },
  };
}

/**
 * 逐句旁白：splitSentences 切句 → 逐句 synthesize → buildSubtitles 累计时间戳；
 * 返回 { cues, wav(整段拼接|null), sampleRate, durationSec }，cues 即共享字幕契约。
 */
export async function synthesizeNarration(text, { engine }) {
  const sentences = splitSentences(text);
  const pieces = [];
  for (const s of sentences) pieces.push(await engine.synthesize(s));
  const cues = buildSubtitles(sentences.map((s, i) => ({ text: s, durationSec: pieces[i].durationSec })));
  const durationSec = pieces.reduce((sum, p) => sum + p.durationSec, 0);
  return { cues, wav: pieces.length ? concatWavs(pieces.map(p => p.wav)) : null, sampleRate: pieces[0]?.sampleRate ?? null, durationSec };
}

/** Float32 样本 → 16bit 单声道 PCM wav Buffer（44 字节标准头）。纯函数。 */
export function samplesToWav(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + dataBytes, 4); buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii'); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii'); buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i] || 0)) * 32767), 44 + i * 2);
  return buf;
}

/** 解析 wav 头 → { sampleRate, channels, bitsPerSample, dataBytes }；不是 wav/太短 → null。纯函数。 */
export function parseWavHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  const out = { sampleRate: 0, channels: 0, bitsPerSample: 0, dataBytes: 0 };
  for (let off = 12; off + 8 <= buf.length;) {
    const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') { out.channels = buf.readUInt16LE(off + 10); out.sampleRate = buf.readUInt32LE(off + 12); out.bitsPerSample = buf.readUInt16LE(off + 22); }
    else if (id === 'data') { out.dataBytes = size; break; }
    off += 8 + size + (size % 2); // chunk 按 2 字节对齐
  }
  return out.sampleRate ? out : null;
}

/** 拼接同采样率 16bit 单声道 wav 为整段；采样率不一致抛 WAV_RATE_MISMATCH。纯函数。 */
export function concatWavs(wavs) {
  if (!wavs.length) return null;
  const heads = wavs.map(parseWavHeader);
  if (heads.some(h => !h || h.sampleRate !== heads[0].sampleRate)) {
    const err = new Error('WAV_RATE_MISMATCH: 逐句 wav 采样率必须一致才能拼接'); err.code = 'WAV_RATE_MISMATCH'; throw err;
  }
  return samplesToWav(concatSamples(wavs, heads), heads[0].sampleRate);
}

function concatSamples(wavs, heads) {
  const total = heads.reduce((n, h) => n + h.dataBytes / 2, 0);
  const out = new Float32Array(total);
  let at = 0;
  wavs.forEach((wav, i) => { for (let j = 0; j < heads[i].dataBytes / 2; j++) out[at++] = wav.readInt16LE(44 + j * 2) / 32767; });
  return out;
}
