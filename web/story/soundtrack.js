// web/story/soundtrack.js — 数据作曲：这一章的配乐由这一章的数据实时生成
// (SPEC design/story-recap/SPEC.md §4)。
//
// 参考实现 = design/story-recap/prototype.html 顶部的可播放演示：本模块把
// 它工程化，原型中的 Math.random 全部换成 contracts.createRng 的种子化
// PRNG（种子来自章节 songSeed），并补上 SPEC §4 要求的完整结构。
//
// 分层：
//   纯层（node --test 直接可测，无 Web Audio、无 DOM、无 IO）
//     normalizeSongInput / resolveSongParams / planSong
//   会话层（浏览器，真实 AudioContext 只在用户手势里创建）
//     createSoundtrack() → { start, setPage, setMuted, isMuted, unlock, stop }
//
// 映射（口径全部来自 web/story/contracts.js，本模块不自定）：
//   速度 = SONG.BPM_BASE + busyness × SONG.BPM_SPAN（64 + busyness×40）
//   mood ≥ SONG.MOOD_MAJOR_THRESHOLD(0.5) → 大调 I–vi–IV–V，否则小调 i–III–v–iv
//   主旋律基础波形 = contracts.KIND_TIMBRE[dominantKind]；connect 在此之上
//     叠加更柔的低通与更低音量（SPEC §4 柔和 saw 加低通），restore/stillness
//     叠加长混响发送（SPEC §4 sine 加长混响）
//   旋律起伏跟随 weeklyCounts：level = 周数/最大周数，lvl = round(level×5)，
//     音高索引 ∈ [max(0,lvl-2), lvl]（忙的周音更高）；level > 0.7 的周每个
//     半拍都可能发音（更密），否则每 2 个半拍（原型 tick() 语义原样保留）
//   每次毕业在当周加一个钟琴音（voice 'chime'，root+24 起的调式音阶内，
//     与配乐同调）；一段最多 CHIME_MAX_PER_SEGMENT 枚（年章一周毕业很多次
//     时的工程封顶，多出的不叠加）
//
// 结构（SPEC §4）：段号 = 页号（contracts.pageSegmentIndex）。每段
// BARS_PER_SEGMENT=4 小节（一个完整和弦进行循环）。段 0 = 封面 = 前奏
// （SONG.INTRO_BARS=4 小节纯 pad，SPEC §3 ⓪ 轻点「翻开」时音乐 2.5 秒淡
// 入）；段 1..pageCount-2 = 主体（pad + 旋律 + 钟琴）；末段 = 海报页收束
// （contracts.isOutroSegment）：pad 回到主和弦（degree 0）长持，旋律走
// 确定的终止式落到主音，master 在末段内线性淡出到 0。
//
// 种子确定性（SPEC §4 种子固定 / §8 验收「同一种子重复生成的音符序列完全
// 一致」）：所有随机抽取都走 contracts.createRng，且每 (小节, 声部流) 一条
// 独立流 —— 种子 = chapterSeed 与小节号的确定混合（barRng()）。这样无论播
// 放时怎么翻页/回翻/停留（会话层按段惰性调度、循环补位），同一个小节永远
// 抽出同样的音符；「同一章每次播放都是同一首」与导航顺序无关。混响冲激响
// 应的噪声也用同一棵种子树生成，整首完全可复现。
//
// 换页连续（SPEC §4 换页时保持音乐连续，不重启）：一个会话只有一个
// AudioContext / master / 混响，setPage() 只把调度游标重新锚定到新段
// （HANDOFF_SECONDS 后进入），已排上的旧段音符自然衰减，pad 跨段延音。
// 用户在某页停留超过段长时，该段（收束段除外）按原音符确定性循环补位，
// 音乐不断。
//
// node 侧只测纯层；OfflineAudioContext 能量/长度检查、iOS 实机手势出声
// 是浏览器内检查（defer，见 T3 证据 deferred 清单）。移动端 Safari：
// start() 必须在用户手势里调用（内部立即 ctx.resume()，不 await），后续
// 手势可随时调 unlock()。prefers-reduced-motion 不影响音乐（SPEC §4），
// 一键静音经 SOUNDTRACK_MUTE_KEY 记住选择。

import {
  SONG, KINDS,
  tempoBpm, modeFor, timbreFor, scaleFor, chordDegreesFor,
  createRng, normalizeSongSeed, songSeedFromId, pageSegmentIndex,
} from './contracts.js';

// ---------------------------------------------------------------------------
// 常量（作曲口径；映射数值锁自原型，结构常量为本线工程决策）。
// ---------------------------------------------------------------------------

export var SOUNDTRACK = {
  FADE_IN_SECONDS: 2.5,     // SPEC §3 ⓪：轻点「翻开」时音乐淡入 2.5 秒（原型 master 线性斜坡）
  MUTE_RAMP_SECONDS: 0.15,  // 静音/恢复的增益斜坡
  STOP_RAMP_SECONDS: 0.35,  // stop() 的快速淡出
  LOOKAHEAD_SECONDS: 0.6,   // 调度前瞻窗（原型 tick 的 0.6s）
  TICK_MS: 150,             // 调度器间隔（原型 setInterval(tick, 150)）
  HANDOFF_SECONDS: 0.6,     // 换页进入新段前的交接窗：旧音符自然衰减，不重启
  STEPS_PER_BAR: 8,         // 每小节 8 个半拍（原型 step = beat/2）
  BARS_PER_SEGMENT: 4,      // 每段 4 小节 = 一个完整和弦进行循环
  CHIME_MAX_PER_SEGMENT: 8, // 一段内钟琴音封顶（年章一周多次毕业的工程上限）
  MASTER_GAIN: 0.22,        // 原型 master 目标增益；≤ contracts SONG.VOLUME_MAX(0.25)
  PAD_GAIN: 0.05,           // 原型 pad 每振荡器增益
  LEAD_GAIN: 0.09,          // 原型 melody 峰值增益
  LEAD_GAIN_SOFT: 0.07,     // connect（柔和 saw）更低音量
  LEAD_FILTER_HZ: 1800,     // 原型旋律低通
  LEAD_FILTER_HZ_SOFT: 1100,// connect 的更柔低通
  CHIME_GAIN: 0.07,         // 钟琴峰值增益
  REVERB_SECONDS: 2.6,      // 原型混响 IR 长
  REVERB_DECAY: 2.4,        // 原型 IR 衰减幂
  REVERB_WET: 0.55,         // 原型湿增益
  LONG_REVERB_SECONDS: 4.2, // restore/stillness/钟琴的加长混响（SPEC §4）
  LONG_REVERB_DECAY: 2.2,
  LONG_REVERB_WET: 0.8,
  CHIME_RELEASE_BEATS: 2,   // 钟琴音长（拍）
  OUTRO_CADENCE: [5, 3, 2, 0], // 收束旋律终止式：音阶索引级进落回主音（无随机）
};

export var SOUNDTRACK_MUTE_KEY = 'tango-donego.story.soundtrack.muted';

var LONG_REVERB_KINDS = { restore: 1, stillness: 1 };
var PAD_CHORD = [0, 4, 7];            // 原型 pad 和弦（大小调同用，参考实现原样保留）
var IR_BAR_OFFSET = 1000003;          // 混响 IR 噪声流用的虚拟小节号，避开真实小节流

// ---------------------------------------------------------------------------
// 纯层 — 输入规范化（镜像 contracts.sanitizeSongStats 的规则 + 种子）。
// ---------------------------------------------------------------------------

function isNum(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isInt(value, min, max) {
  return isNum(value, min, max) && Math.floor(value) === value;
}

export function normalizeSongInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!isNum(value.busyness, 0, 1)) return null;       // SPEC §4: 0–1 分位
  if (!isNum(value.mood, 0, 1)) return null;           // SPEC §4: 0–1 占比
  var kind = String(value.dominantKind == null ? '' : value.dominantKind);
  if (KINDS.indexOf(kind) < 0) return null;
  var rawWeekly = Array.isArray(value.weeklyCounts) ? value.weeklyCounts : null;
  if (!rawWeekly || !rawWeekly.length || rawWeekly.length > 53) return null; // 年章最多 53 周
  var weeklyCounts = [];
  for (var i = 0; i < rawWeekly.length; i += 1) {
    if (!isInt(rawWeekly[i], 0, 1e5)) return null;
    weeklyCounts.push(rawWeekly[i]);
  }
  var rawGrad = Array.isArray(value.graduations) ? value.graduations : null;
  if (!rawGrad || rawGrad.length !== rawWeekly.length) return null; // 与每周对齐
  var graduations = [];
  for (var j = 0; j < rawGrad.length; j += 1) {
    if (!isInt(rawGrad[j], 0, 1e4)) return null;
    graduations.push(rawGrad[j]);
  }
  var seed;
  if (typeof value.chapterSeed === 'number') {
    seed = normalizeSongSeed(value.chapterSeed);
  } else if (typeof value.chapterSeed === 'string' && value.chapterSeed !== '') {
    seed = songSeedFromId(value.chapterSeed);
  }
  if (seed == null) return null;
  return {
    busyness: value.busyness,
    mood: value.mood,
    dominantKind: kind,
    weeklyCounts: weeklyCounts,
    graduations: graduations,
    chapterSeed: seed,
  };
}

// ---------------------------------------------------------------------------
// 纯层 — SPEC §4 映射（调用的全部是 contracts 的口径函数）。
// ---------------------------------------------------------------------------

export function resolveSongParams(input) {
  var n = normalizeSongInput(input);
  if (!n) return null;
  var bpm = tempoBpm(n.busyness);
  var mode = modeFor(n.mood);
  var soft = n.dominantKind === 'connect';
  var longReverb = !!LONG_REVERB_KINDS[n.dominantKind];
  return {
    bpm: bpm,
    beat: 60 / bpm,
    mode: mode,
    scale: scaleFor(mode),
    degrees: chordDegreesFor(mode),
    leadWave: timbreFor(n.dominantKind),
    leadFilterHz: soft ? SOUNDTRACK.LEAD_FILTER_HZ_SOFT : SOUNDTRACK.LEAD_FILTER_HZ,
    leadGain: soft ? SOUNDTRACK.LEAD_GAIN_SOFT : SOUNDTRACK.LEAD_GAIN,
    leadReverbLong: longReverb,
    masterGain: Math.min(SOUNDTRACK.MASTER_GAIN, SONG.VOLUME_MAX),
    fadeIn: SOUNDTRACK.FADE_IN_SECONDS,
  };
}

// ---------------------------------------------------------------------------
// 纯层 — 种子化小节流。mixBar 把 chapterSeed 与 (小节号, 声部流) 混成新种子，
// 再交给 contracts.createRng（canonical mulberry32）。stream 0 = 旋律,
// stream 1 = 钟琴, stream 2/3 = 两条混响 IR 噪声（虚拟小节号避开真实小节）。
// 跨小节、跨声部互不干扰，与播放导航顺序无关 → 同种子同音符序列。
// ---------------------------------------------------------------------------

function mixBar(seed, bar, stream) {
  return (seed ^ Math.imul(bar * 2 + stream + 1, 0x85ebca6b)) >>> 0;
}

function barRng(seed, bar, stream) {
  return createRng(mixBar(seed, bar, stream));
}

function hz(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12); // 原型 hz()
}

// ---------------------------------------------------------------------------
// 纯层 — planSong：把整章规划成有限一遍的音符时间线。
//   plan = {
//     seed, params, duration, fadeOut: {startAt, duration},
//     segments: [{index, kind:'intro'|'body'|'outro', startBar, barCount,
//                 week, startAt, endAt, notes:[{midi,at,dur,voice}…]}],
//     notes: [...]  // 全曲绝对时间（秒），按时间排序；poster 波形 =
//   }               // contracts.melodyPitches(plan.notes)（SPEC §4 末条）
// 段内 notes 的 at 是段内相对时间（∈ [0, 段长)）；dur 可以跨段延音（pad）。
// ---------------------------------------------------------------------------

export function planSong(input, pageCount) {
  var n = normalizeSongInput(input);
  if (!n) return null;
  if (!isInt(pageCount, 1, 1e4)) return null;
  var params = resolveSongParams(n);
  var beat = params.beat;
  var barLen = 4 * beat;                                   // 4 拍一小节
  var segLen = SOUNDTRACK.BARS_PER_SEGMENT * barLen;
  var max = Math.max.apply(null, n.weeklyCounts);

  var segments = [];
  var notes = [];
  var t = 0;
  var bar = 0; // 绝对小节号（种子维），前奏从 0 起
  for (var i = 0; i < pageCount; i += 1) {
    var kind = i === pageCount - 1 ? 'outro' : (i === 0 ? 'intro' : 'body');
    var week = kind === 'body' ? (i - 1) % n.weeklyCounts.length : -1;
    var seg = {
      index: i,
      kind: kind,
      startBar: bar,
      barCount: SOUNDTRACK.BARS_PER_SEGMENT,
      week: week,
      startAt: t,
      endAt: t + segLen,
      notes: [],
    };
    buildSegment(seg, n, params, { barLen: barLen, segLen: segLen, max: max });
    for (var k = 0; k < seg.notes.length; k += 1) {
      var note = seg.notes[k];
      notes.push({ midi: note.midi, at: seg.startAt + note.at, dur: note.dur, voice: note.voice });
    }
    segments.push(seg);
    t = seg.endAt;
    bar += seg.barCount;
  }
  notes.sort(function (a, b) {
    return a.at - b.at || a.midi - b.midi || (a.voice < b.voice ? -1 : a.voice > b.voice ? 1 : 0);
  });
  var outro = segments[pageCount - 1];
  return {
    seed: n.chapterSeed,
    params: params,
    duration: t,
    fadeOut: { startAt: outro.startAt, duration: segLen },
    segments: segments,
    notes: notes,
  };
}

function buildSegment(seg, input, params, geom) {
  var scale = params.scale;
  var degrees = params.degrees;
  var beat = params.beat;
  var half = beat / 2;
  var barLen = geom.barLen;

  if (seg.kind === 'outro') {
    // 收束段：pad 回主和弦长持整段，旋律走确定终止式落回主音（SPEC §4
    // 「结尾在海报页回到主和弦并淡出」）。无随机 — 每次收束都一样。
    for (var c = 0; c < PAD_CHORD.length; c += 1) {
      seg.notes.push({
        midi: SONG.ROOT_MIDI - 12 + scale[0] + PAD_CHORD[c],
        at: 0,
        dur: geom.segLen,
        voice: 'pad',
      });
    }
    for (var m = 0; m < SOUNDTRACK.OUTRO_CADENCE.length; m += 1) {
      seg.notes.push({
        midi: SONG.ROOT_MIDI + 12 + scale[SOUNDTRACK.OUTRO_CADENCE[m]],
        at: beat * 2 * m,
        dur: beat * 1.5,
        voice: 'lead',
      });
    }
    return;
  }

  // pad：每小节一个和弦（degree 按段内小节走完整进行），3 声部正弦，
  // 8 拍延音可跨段（换页连续的延音来源）。
  for (var p = 0; p < seg.barCount; p += 1) {
    var deg = degrees[p % degrees.length];
    for (var v = 0; v < PAD_CHORD.length; v += 1) {
      seg.notes.push({
        midi: SONG.ROOT_MIDI - 12 + scale[deg % scale.length] + PAD_CHORD[v],
        at: p * barLen,
        dur: beat * 8,
        voice: 'pad',
      });
    }
  }
  if (seg.kind === 'intro') return; // 前奏：纯 pad（SPEC §4 前奏 4 小节 pad）

  // 主体：旋律起伏跟随本周 weeklyCounts（原型 tick() 语义）。
  var count = input.weeklyCounts[seg.week];
  var level = geom.max > 0 ? count / geom.max : 0;
  var lvl = Math.round(level * 5);
  var dense = level > 0.7;
  for (var b = 0; b < seg.barCount; b += 1) {
    var rng = barRng(input.chapterSeed, seg.startBar + b, 0);
    for (var step = 0; step < SOUNDTRACK.STEPS_PER_BAR; step += 1) {
      if (!dense && step % 2 !== 0) continue;
      if (rng() <= 0.25) continue; // 门控（原型 Math.random() > .25）
      var idx = Math.max(0, lvl - 2 + Math.floor(rng() * 3));
      seg.notes.push({
        midi: SONG.ROOT_MIDI + 12 + scale[idx % scale.length],
        at: b * barLen + step * half,
        dur: beat * 1.8,
        voice: 'lead',
      });
    }
  }

  // 钟琴：本周每次毕业一枚，均匀布点，音高同调（SPEC §4）。
  var grads = input.graduations[seg.week] || 0;
  var chimes = Math.min(grads, SOUNDTRACK.CHIME_MAX_PER_SEGMENT);
  if (chimes > 0) {
    var crng = barRng(input.chapterSeed, seg.startBar, 1);
    var slots = SOUNDTRACK.BARS_PER_SEGMENT * SOUNDTRACK.STEPS_PER_BAR;
    for (var g = 0; g < chimes; g += 1) {
      var slot = chimes === 1 ? 0 : Math.round((g * (slots - 1)) / (chimes - 1));
      seg.notes.push({
        midi: SONG.ROOT_MIDI + 24 + scale[Math.floor(crng() * scale.length)],
        at: slot * half,
        dur: beat * SOUNDTRACK.CHIME_RELEASE_BEATS,
        voice: 'chime',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 会话层 — createSoundtrack。node 里也能构造（start() 优雅失败），真实
// AudioContext 只在 start()（用户手势）里创建。
// ---------------------------------------------------------------------------

function safeStorage(override) {
  if (override !== undefined) return override || null;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch (e) {
    return null;
  }
}

function readMuted(storage) {
  try {
    return !!(storage && storage.getItem(SOUNDTRACK_MUTE_KEY) === '1');
  } catch (e) {
    return false;
  }
}

function writeMuted(storage, muted) {
  try {
    if (storage) storage.setItem(SOUNDTRACK_MUTE_KEY, muted ? '1' : '0');
  } catch (e) {
    /* Safari 隐私模式等：记住失败不致命 */
  }
}

// 混响冲激响应生成分片进行：两条 IR（2.6s + 4.2s × 48kHz × 2ch ≈ 65 万次
// rng+pow）同步算完会在「翻开」手势里把主线程阻塞 ~250ms（实测 longtask），
// 正落在封面开启的仪式时刻。改为每片 IR_CHUNK_SAMPLES 个样本让出主线程；
// ConvolverNode.buffer 为 null 时输出无声，混响在几十到几百毫秒内淡入
// （封面本来就有 2.5 秒淡入，听感无差）。种子树不变 → 同种子同 IR（逐片
// 只改调度，不改数值顺序）。
export var IR_CHUNK_SAMPLES = 24000;

function fillImpulseAsync(ctx, convolver, seconds, decayPower, rng, timers) {
  var len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  var ir = ctx.createBuffer(2, len, ctx.sampleRate);
  var left = ir.getChannelData(0);
  var right = ir.getChannelData(1);
  var pos = 0;
  function chunk() {
    var end = Math.min(len, pos + IR_CHUNK_SAMPLES);
    for (; pos < end; pos += 1) {
      var decay = Math.pow(1 - pos / len, decayPower);
      left[pos] = (rng() * 2 - 1) * decay;
      right[pos] = (rng() * 2 - 1) * decay;
    }
    if (pos < len) {
      timers.push(setTimeout(chunk, 0));
    } else if (convolver) {
      convolver.buffer = ir; // 全片填完才挂上：中途无半成品 IR
    }
  }
  chunk();
}

export function createSoundtrack(options) {
  var opts = options || {};
  var plan = planSong(opts.input, opts.pageCount);
  var storage = safeStorage(opts.storage);
  var muted = readMuted(storage);

  var ctx = null;
  var master = null;
  var verb = null;
  var longVerb = null;
  var timer = null;
  var started = false;
  var closed = false;
  var segIdx = 0;
  var cursor = 0;
  var loopCount = 0;
  var anchorCtx = 0;
  var fadeEndCtx = null;

  function resumeQuietly() {
    // iOS：必须在用户手势里调用；这里同步发起 resume，不阻塞手势回调。
    if (ctx && ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      var p = ctx.resume();
      if (p && typeof p.catch === 'function') p.catch(function () {});
    }
  }

  function rampGain(target, when) {
    var now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(target, now + when);
  }

  function scheduleFadeOut(atCtx, durationSec) {
    fadeEndCtx = atCtx + durationSec;
    rampGain(0, fadeEndCtx - ctx.currentTime);
  }

  function enterSegment(i) {
    var seg = plan.segments[i];
    if (!seg) return;
    segIdx = i;
    cursor = 0;
    loopCount = 0;
    anchorCtx = ctx.currentTime + SOUNDTRACK.HANDOFF_SECONDS; // 交接窗内旧音符自然衰减
    if (seg.kind === 'outro') {
      scheduleFadeOut(anchorCtx, plan.fadeOut.duration);
    } else if (fadeEndCtx != null) {
      fadeEndCtx = null; // 从海报页回翻：取消淡出，恢复音量
      rampGain(muted ? 0 : plan.params.masterGain, 0.5);
    }
  }

  function connectVoice(gainNode, longSend) {
    gainNode.connect(master); // 干声
    gainNode.connect(verb);   // 常规混响发送
    if (longSend) gainNode.connect(longVerb);
  }

  function scheduleNote(note, atCtx) {
    var params = plan.params;
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.frequency.value = hz(note.midi);
    if (note.voice === 'pad') {
      osc.type = 'sine';
      var attack = params.beat * 1.5;
      g.gain.setValueAtTime(0, atCtx);
      g.gain.linearRampToValueAtTime(SOUNDTRACK.PAD_GAIN, atCtx + attack);
      g.gain.linearRampToValueAtTime(0, atCtx + note.dur);
      osc.connect(g);
      connectVoice(g, false);
      osc.start(atCtx);
      osc.stop(atCtx + note.dur + 0.05);
      return;
    }
    if (note.voice === 'lead') {
      osc.type = params.leadWave;
      var f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = params.leadFilterHz; // connect 的「柔和 saw 加低通」
      g.gain.setValueAtTime(0, atCtx);
      g.gain.linearRampToValueAtTime(params.leadGain, atCtx + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0005, atCtx + note.dur);
      osc.connect(f);
      f.connect(g);
      connectVoice(g, params.leadReverbLong); // restore/stillness 的长混响发送
      osc.start(atCtx);
      osc.stop(atCtx + note.dur + 0.05);
      return;
    }
    // chime：钟琴音 — 正弦 + 快起慢衰 + 长混响，与配乐同调
    osc.type = 'sine';
    g.gain.setValueAtTime(0, atCtx);
    g.gain.linearRampToValueAtTime(SOUNDTRACK.CHIME_GAIN, atCtx + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0003, atCtx + note.dur);
    osc.connect(g);
    connectVoice(g, true);
    osc.start(atCtx);
    osc.stop(atCtx + note.dur + 0.05);
  }

  function tick() {
    if (!ctx || !started || closed) return;
    var seg = plan.segments[segIdx];
    if (!seg) return;
    var segLen = seg.endAt - seg.startAt;
    var horizon = ctx.currentTime + SOUNDTRACK.LOOKAHEAD_SECONDS;
    while (cursor < seg.notes.length) {
      var note = seg.notes[cursor];
      var atCtx = anchorCtx + loopCount * segLen + note.at;
      if (atCtx > horizon) break;
      if (atCtx >= ctx.currentTime - 0.02) scheduleNote(note, atCtx);
      cursor += 1;
    }
    if (cursor >= seg.notes.length && seg.kind !== 'outro') {
      // 停留超过段长：本段确定性循环补位，音乐不断（收束段靠淡出结束）
      loopCount += 1;
      cursor = 0;
    }
  }

  var irTimers = [];

  function buildGraph(AC) {
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    // 混响冲激响应也走种子树：整首完全可复现；生成按片让出主线程（见
    // fillImpulseAsync 头注——同步生成曾把「翻开」手势阻塞 258ms）。
    verb = ctx.createConvolver();
    fillImpulseAsync(ctx, verb, SOUNDTRACK.REVERB_SECONDS, SOUNDTRACK.REVERB_DECAY,
      createRng(mixBar(plan.seed, IR_BAR_OFFSET, 2)), irTimers);
    var wet = ctx.createGain();
    wet.gain.value = SOUNDTRACK.REVERB_WET;
    verb.connect(wet);
    wet.connect(master);
    longVerb = ctx.createConvolver();
    fillImpulseAsync(ctx, longVerb, SOUNDTRACK.LONG_REVERB_SECONDS, SOUNDTRACK.LONG_REVERB_DECAY,
      createRng(mixBar(plan.seed, IR_BAR_OFFSET, 3)), irTimers);
    var longWet = ctx.createGain();
    wet.gain.value = SOUNDTRACK.LONG_REVERB_WET;
    longVerb.connect(longWet);
    longWet.connect(master);
  }

  function clearIrTimers() {
    for (var i = 0; i < irTimers.length; i += 1) clearTimeout(irTimers[i]);
    irTimers.length = 0;
  }

  function resolveAudioCtor() {
    return opts.audioApi
      || (typeof AudioContext !== 'undefined' && AudioContext)
      || (typeof webkitAudioContext !== 'undefined' && webkitAudioContext)
      || null;
  }

  var session = {
    plan: plan,

    // 预建图（可选）：AudioContext 构造本身有 ~100–200ms 的同步成本，若放在
    // 「翻开」手势里会卡住封面开启（实测 longtask）。宿主可在章节打开后的
    // 空闲时机调用 prepare()：此刻只建 ctx/master/混响（ctx 处于 suspended、
    // 不出声；IR 按片填充），真正的 start()（用户手势）只做 resume + 排音。
    prepare: function () {
      if (closed || started || ctx) return { ok: ctx ? true : false, reason: ctx ? null : 'unavailable' };
      if (!plan) return { ok: false, reason: 'bad-input' };
      var AC = resolveAudioCtor();
      if (!AC) return { ok: false, reason: 'no-web-audio' };
      try {
        buildGraph(AC);
      } catch (e) {
        ctx = null; master = null; verb = null; longVerb = null;
        return { ok: false, reason: 'audio-init' };
      }
      return { ok: true };
    },

    // 必须在用户手势里调用（SPEC §4 移动端 Safari 要在用户手势里 resume）。
    start: function (pageIndex) {
      if (closed) return { ok: false, reason: 'stopped' };
      if (!plan) return { ok: false, reason: 'bad-input' };
      if (!started) {
        if (!ctx) {
          var AC = resolveAudioCtor();
          if (!AC) return { ok: false, reason: 'no-web-audio' }; // 播放器降级 CC0/静音
          try {
            buildGraph(AC);
          } catch (e) {
            ctx = null; master = null; verb = null; longVerb = null;
            return { ok: false, reason: 'audio-init' };
          }
        }
        started = true;
        resumeQuietly();
        master.gain.setValueAtTime(0, ctx.currentTime);
        if (!muted) {
          master.gain.linearRampToValueAtTime(plan.params.masterGain,
            ctx.currentTime + plan.params.fadeIn); // SPEC §3 ⓪ 2.5 秒淡入
        }
        var first = pageSegmentIndex(pageIndex);
        enterSegment(first == null ? 0 : first);
        timer = setInterval(tick, SOUNDTRACK.TICK_MS);
        tick();
      } else {
        resumeQuietly();
        session.setPage(firstPage(pageIndex));
      }
      return { ok: true };
    },

    // 换页：不重启，只把调度锚点移到新段（SPEC §4 换页时保持音乐连续）。
    setPage: function (pageIndex) {
      if (!started || !plan) return;
      resumeQuietly(); // 换页轻点也是手势，顺手兜住 iOS 休眠
      var i = pageSegmentIndex(pageIndex);
      if (i == null) return;
      if (i >= plan.segments.length) i = plan.segments.length - 1;
      if (i === segIdx) return;
      enterSegment(i);
    },

    // 一键静音并记住（SPEC §4）；静音不停止调度。
    setMuted: function (value) {
      muted = !!value;
      writeMuted(storage, muted);
      if (!ctx || !master) return;
      resumeQuietly();
      if (muted) {
        rampGain(0, SOUNDTRACK.MUTE_RAMP_SECONDS);
      } else if (fadeEndCtx != null && fadeEndCtx > ctx.currentTime) {
        // 海报页淡出进行中恢复：先回音量，再把剩余淡出重新排上
        var now = ctx.currentTime;
        master.gain.cancelScheduledValues(now);
        master.gain.setValueAtTime(master.gain.value, now);
        master.gain.linearRampToValueAtTime(plan.params.masterGain, now + SOUNDTRACK.MUTE_RAMP_SECONDS);
        master.gain.linearRampToValueAtTime(0, fadeEndCtx);
      } else {
        fadeEndCtx = null;
        rampGain(plan.params.masterGain, SOUNDTRACK.MUTE_RAMP_SECONDS);
      }
    },

    isMuted: function () {
      return muted;
    },

    // 任何后续用户手势都可调用：iOS 后台回来 / 中断后恢复出声。
    unlock: function () {
      resumeQuietly();
    },

    // 奖章「每枚一声叮，和配乐同调」（SPEC §3 ④）：index 参与选音高（调式
    // 音阶内轮转），音色/包络与毕业钟琴一致（正弦 + 快起慢衰 + 长混响）。
    // 未启动（用户还没在封面手势里 start 过）时静默跳过，不自动起音频——
    // 浏览器自动播放限制下凭空出声反而违规。
    ding: function (index) {
      if (!ctx || !started || closed || !master) return { ok: false, reason: 'not-started' };
      resumeQuietly();
      var scale = plan.params.scale;
      var step = Math.abs(Math.floor(Number(index) || 0)) % scale.length;
      var note = {
        midi: SONG.ROOT_MIDI + 24 + scale[step],
        dur: plan.params.beat * SOUNDTRACK.CHIME_RELEASE_BEATS,
      };
      var at = ctx.currentTime + 0.003;
      var osc = ctx.createOscillator();
      var g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = hz(note.midi);
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(SOUNDTRACK.CHIME_GAIN, at + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0003, at + note.dur);
      osc.connect(g);
      g.connect(master);
      if (longVerb) g.connect(longVerb);
      osc.start(at);
      osc.stop(at + note.dur + 0.05);
      return { ok: true, midi: note.midi };
    },

    stop: function () {
      if (timer) { clearInterval(timer); timer = null; }
      clearIrTimers();
      var ctxToClose = ctx;
      if (!closed && ctxToClose && master) {
        closed = true;
        try {
          rampGain(0, SOUNDTRACK.STOP_RAMP_SECONDS);
        } catch (e) { /* 尽力而为 */ }
        setTimeout(function () {
          try {
            if (ctxToClose && typeof ctxToClose.close === 'function') ctxToClose.close();
          } catch (e) {}
        }, (SOUNDTRACK.STOP_RAMP_SECONDS + 0.05) * 1000);
      }
      closed = true;
      started = false;
      ctx = null;
      master = null;
      verb = null;
      longVerb = null;
      fadeEndCtx = null;
    },
  };
  return session;
}

function firstPage(pageIndex) {
  var i = pageSegmentIndex(pageIndex);
  return i == null ? 0 : i;
}

// ---------------------------------------------------------------------------
// player 适配器 — player.js 的音频契约是 {start(input), setSegment(i),
// setMuted(b), stop()}，会话层是 {start(pageIndex), setPage, ...}。本工厂把
// 两侧接上：start(input) 才惰性建会话（页数在工厂参数给定——player 的
// start(input) 不携带 pageCount，song input 里也没有），换页 setSegment →
// setPage（SPEC §4 换页只换段不重启），destroy stop。之前两侧名不符、全仓
// 无胶水：二期若把裸会话直接当 options.audio 传入，setSegment 会经 typeof
// 守卫静默 no-op，音乐永远停在段 0。
// ---------------------------------------------------------------------------
export function createAudioAdapter(options) {
  var opts = options || {};
  var pageCount = Math.max(1, Math.floor(Number(opts.pageCount) || 1));
  var session = opts.session || null; // 可注入（单测/预览）；缺省在 start 惰性创建
  return {
    start: function (input) {
      if (!session) session = createSoundtrack({
        input: input,
        pageCount: pageCount,
        storage: opts.storage,
        audioApi: opts.audioApi,
      });
      return session.start(0);
    },
    setSegment: function (i) {
      if (session) session.setPage(i);
    },
    setMuted: function (value) {
      if (session) session.setMuted(value);
    },
    isMuted: function () {
      return session ? session.isMuted() : false;
    },
    unlock: function () {
      if (session) session.unlock();
    },
    stop: function () {
      if (session) session.stop();
      session = null;
    },
    session: function () { return session; },
  };
}
