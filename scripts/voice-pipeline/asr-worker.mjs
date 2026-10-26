// 定稿解码线程：sherpa-onnx 只有同步 decode（Fun-ASR-Nano 一段 ~360ms），放到 worker 里不阻塞服务主线程。
// 一个 worker 只持有一个离线识别器（A 路 x-asr 或 B 路 Fun-ASR-Nano），按消息顺序解码。
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');
const recognizer = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: { ...workerData.modelConfig, numThreads: workerData.threads, provider: 'cpu', debug: 0 },
  decodingMethod: 'greedy_search',
});
parentPort.postMessage({ type: 'ready' });

parentPort.on('message', ({ id, samples }) => {
  const t0 = performance.now();
  try {
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate: 16000, samples });
    recognizer.decode(stream);
    parentPort.postMessage({ id, text: recognizer.getResult(stream).text.trim(), ms: Math.round(performance.now() - t0) });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.message || error), ms: Math.round(performance.now() - t0) });
  }
});
