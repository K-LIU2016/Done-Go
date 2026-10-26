// ①②③ ASR 引擎：流式实时字（x-asr 480ms）+ silero VAD 断句 + 逐句双路定稿（A x-asr 离线 ∥ B Fun-ASR-Nano）。
// 选型依据见 design/voice-pipeline/SPEC.md §1.1（Mac M5 实测）。模型目录由 TANGO_VOICE_MODELS 指定。
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const SAMPLE_RATE = 16000;
const VAD_WINDOW = 512;

export const MODEL_DIRS = Object.freeze({
  stream: 'sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05',
  offlineA: 'sherpa-onnx-x-asr-zipformer-transducer-zh-en-punct-int8-2026-06-03',
  offlineB: 'sherpa-onnx-funasr-nano-int8-2025-12-30',
  vad: 'silero_vad_v5.onnx',
});

export function modelsAvailable(dir) {
  return !!dir && Object.values(MODEL_DIRS).every(name => existsSync(join(dir, name)));
}

function decoderWorker(modelConfig, threads) {
  const worker = new Worker(new URL('./asr-worker.mjs', import.meta.url), { workerData: { modelConfig, threads }, execArgv: [] }); // 不继承父进程的 --input-type 等参数
  const pending = new Map();
  let seq = 0;
  const ready = new Promise((resolve, reject) => {
    worker.once('message', m => (m.type === 'ready' ? resolve() : reject(new Error('worker-init'))));
    worker.once('error', reject);
  });
  worker.on('message', m => {
    if (m.type === 'ready') return;
    const done = pending.get(m.id);
    if (done) { pending.delete(m.id); done(m); }
  });
  return {
    ready,
    decode(samples) {
      const id = ++seq;
      return new Promise(resolve => {
        pending.set(id, resolve);
        worker.postMessage({ id, samples });
      });
    },
    close: () => worker.terminate(),
  };
}

// 进程内单例：模型只加载一次，所有会话共用（在线识别器无状态，状态在各自的 stream 里）。
export async function createAsrEngine({ modelsDir, threads = 2, minSilence = 0.3 } = {}) {
  if (!modelsAvailable(modelsDir)) throw new Error('VOICE_MODELS_MISSING');
  const sherpa = require('sherpa-onnx-node');
  const d = name => join(modelsDir, name);
  const s = d(MODEL_DIRS.stream), a = d(MODEL_DIRS.offlineA), b = d(MODEL_DIRS.offlineB);
  const online = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: { transducer: { encoder: join(s, 'encoder.int8.onnx'), decoder: join(s, 'decoder.onnx'), joiner: join(s, 'joiner.int8.onnx') }, tokens: join(s, 'tokens.txt'), numThreads: threads, provider: 'cpu', debug: 0 },
    decodingMethod: 'greedy_search',
    enableEndpoint: 0,
  });
  const workerA = decoderWorker({ transducer: { encoder: join(a, 'encoder-epoch-99-avg-1.int8.onnx'), decoder: join(a, 'decoder-epoch-99-avg-1.onnx'), joiner: join(a, 'joiner-epoch-99-avg-1.int8.onnx') }, tokens: join(a, 'tokens.txt') }, threads);
  const workerB = decoderWorker({ funasrNano: { encoderAdaptor: join(b, 'encoder_adaptor.int8.onnx'), llm: join(b, 'llm.int8.onnx'), embedding: join(b, 'embedding.int8.onnx'), tokenizer: join(b, 'Qwen3-0.6B') } }, threads);
  await Promise.all([workerA.ready, workerB.ready]);
  const vadConfig = { sileroVad: { model: d(MODEL_DIRS.vad), threshold: 0.5, minSilenceDuration: minSilence, minSpeechDuration: 0.2, windowSize: VAD_WINDOW, maxSpeechDuration: 20 }, sampleRate: SAMPLE_RATE, numThreads: 1, provider: 'cpu', debug: 0 };

  /**
   * 一次说话一个会话。回调：
   *   onPartial(seg, text)            当前句的实时字（灰字）
   *   onFinal(seg, { a, msA, startMs }) A 路定稿（黑字，最快上屏）
   *   onAlt(seg, { b, msB })          B 路定稿（供对照纠错）
   */
  function createSession({ onPartial = () => {}, onFinal = () => {}, onAlt = () => {} } = {}) {
    const vad = new sherpa.Vad(vadConfig, 30);
    let stream = online.createStream();
    let seg = 0, lastPartial = '', pendingWindow = new Float32Array(0), receivedSamples = 0;
    const inflight = [];

    function finalize(segment) {
      const id = seg++;
      const samples = segment.samples;
      lastPartial = '';
      online.reset(stream); // 下一句的实时字从头开始
      const startMs = Math.round((segment.start / SAMPLE_RATE) * 1000);
      inflight.push(
        workerA.decode(samples).then(r => onFinal(id, { a: r.text || '', msA: r.ms, startMs, error: r.error })),
        workerB.decode(samples).then(r => onAlt(id, { b: r.text || '', msB: r.ms, error: r.error })),
      );
    }

    function drainVad() {
      while (!vad.isEmpty()) { const segment = vad.front(false); vad.pop(); finalize(segment); }
    }

    return {
      get segments() { return seg; },
      get receivedMs() { return Math.round((receivedSamples / SAMPLE_RATE) * 1000); },
      /** pcm: Int16 小端 16k 单声道 */
      accept(pcm) {
        const n = Math.floor(pcm.byteLength / 2);
        const view = new DataView(pcm.buffer, pcm.byteOffset, n * 2);
        const f = new Float32Array(n);
        for (let i = 0; i < n; i++) f[i] = view.getInt16(i * 2, true) / 32768;
        receivedSamples += n;
        stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: f });
        while (online.isReady(stream)) online.decode(stream);
        const text = online.getResult(stream).text.trim();
        if (text && text !== lastPartial) { lastPartial = text; onPartial(seg, text); }
        // VAD 要求整窗喂入
        const merged = new Float32Array(pendingWindow.length + f.length);
        merged.set(pendingWindow); merged.set(f, pendingWindow.length);
        let off = 0;
        for (; off + VAD_WINDOW <= merged.length; off += VAD_WINDOW) vad.acceptWaveform(merged.subarray(off, off + VAD_WINDOW));
        pendingWindow = merged.slice(off);
        drainVad();
      },
      /** 说完：冲刷 VAD，等所有句子的两路定稿都回来 */
      async finish() {
        vad.flush();
        drainVad();
        await Promise.all(inflight);
      },
    };
  }

  return { createSession, close: () => Promise.all([workerA.close(), workerB.close()]) };
}
