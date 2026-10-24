// web/voice/pcm-worklet.js — AudioWorklet 采集处理器（VI·V1采集）。
// 运行在 AudioWorkletGlobalScope：零 import / 零 export / 零依赖
// （AudioWorklet 模块保持自包含，浏览器兼容最稳），由
// web/voice/capture.js 以 PCM_WORKLET_NAME（'pcm-capture-16k'）经
// audioWorklet.addModule() 加载，targetRate/frameMs 经 processorOptions 注入。
//
// 职责（design/voice-intent/SPEC.md §2、§3 capture.js 条目）：
//   * 任意 context.sampleRate → 16kHz 线性插值重采样（相位跨块连续）
//   * Float32 → 16bit PCM（超界 clamp ±1，round ×32767）
//   * 每 60ms（16k 下 960 样本）聚合一帧：
//       postMessage({type:'frame', samples:Int16Array, rms, peak}, [buffer])
//   * 主线程发 {type:'flush'}：不足一帧的尾部补零出最后一帧，并回 {type:'flushed'}
//
// 音频只经消息队列交给主线程（capture.js → stream-client → WS），不落盘。

'use strict';

const DEFAULT_TARGET_RATE = 16000;
const DEFAULT_FRAME_MS = 60;

function concatFloat32(a, b) {
  if (a.length === 0) return Float32Array.from(b);
  if (b.length === 0) return a;
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

// —— 线性插值重采样器（相位跨块连续）——
// 状态：_hist = 未消费的输入样本；_frac = 下一个输出点相对 _hist[0] 的位置。
// 每个输出点 p = _hist[floor(p)] 与 _hist[floor(p)+1] 的线性插值；
// 块结束后丢弃 floor 后已消费前缀（至少保留 1 个锚点样本），
// 因此 _frac 可以 >= 1，跨块无样本重复、无丢失。
class LinearResampler {
  constructor(srcRate, dstRate) {
    this._step = srcRate / dstRate; // 每产出一个输出样本，读指针前进的输入步长
    this._hist = new Float32Array(0);
    this._frac = 0;
  }

  push(input) {
    if (!input || input.length === 0) return new Float32Array(0);
    const hist = concatFloat32(this._hist, input);
    const out = [];
    let f = this._frac;
    for (;;) {
      const i = Math.floor(f);
      if (i + 1 >= hist.length) break; // 需要下一个输入样本才能插值
      const a = hist[i];
      out.push(a + (hist[i + 1] - a) * (f - i));
      f += this._step;
      if (out.length > 1 << 20) break; // 安全阀（正常每块 ≤ 数百）
    }
    const drop = Math.max(0, Math.min(Math.floor(f), hist.length - 1));
    this._hist = hist.slice(drop); // 拷贝尾部，释放前缀内存
    this._frac = f - drop;
    return Float32Array.from(out);
  }
}

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    const opts = (options && options.processorOptions) || {};
    this._targetRate = opts.targetRate || DEFAULT_TARGET_RATE;
    this._frameMs = opts.frameMs || DEFAULT_FRAME_MS;
    this._frameSamples = Math.max(1, Math.round((this._targetRate * this._frameMs) / 1000));
    this._resampler = new LinearResampler(sampleRate, this._targetRate);
    this._pending = new Float32Array(0);
    this.port.onmessage = (e) => {
      if (e && e.data && e.data.type === 'flush') this._flush();
    };
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) this._ingest(channel);
    return true; // 保持处理器存活（SPEC §2 采集不间断）
  }

  _ingest(input) {
    const resampled = this._resampler.push(input);
    const merged = concatFloat32(this._pending, resampled);
    let offset = 0;
    while (offset + this._frameSamples <= merged.length) {
      this._emit(merged.subarray(offset, offset + this._frameSamples));
      offset += this._frameSamples;
    }
    this._pending = offset === 0 ? merged : merged.slice(offset);
  }

  _emit(chunk) {
    const pcm = new Int16Array(chunk.length);
    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < chunk.length; i++) {
      let v = chunk[i];
      if (v > 1) v = 1;
      else if (v < -1) v = -1;
      pcm[i] = Math.round(v * 32767);
      sumSq += v * v;
      const mag = v < 0 ? -v : v;
      if (mag > peak) peak = mag;
    }
    const rms = Math.sqrt(sumSq / chunk.length);
    this.port.postMessage({ type: 'frame', samples: pcm, rms, peak }, [pcm.buffer]);
  }

  _flush() {
    if (this._pending.length > 0) {
      const tail = new Float32Array(this._frameSamples);
      tail.set(this._pending.subarray(0, Math.min(this._pending.length, this._frameSamples)));
      this._pending = new Float32Array(0);
      this._emit(tail);
    }
    this.port.postMessage({ type: 'flushed' });
  }
}

// 处理器名与 web/voice/capture.js 的 PCM_WORKLET_NAME 常量约定一致
// （tests/unit/voice-capture.test.mjs 钉住该一致性）。
if (typeof registerProcessor === 'function') {
  registerProcessor('pcm-capture-16k', PcmCaptureProcessor);
}
