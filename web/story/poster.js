// web/story/poster.js — 收尾海报（SPEC design/story-recap/SPEC.md §3 ⑨ / §4 / §8）。
//
// 页 ⑨：标题、4 个数字、流派、时间之歌波形、二维码；导出 1080×1920 PNG
// canvas；分享走系统 share，不支持时下载。视觉基准 =
// design/story-recap/prototype.html p9（品牌橙 radial 卡片 + 2×2 数字格 +
// 白色波形条 + 「♪ 十月 · 时间之歌」）。
//
// 结构：
//   纯函数（node --test 直接测）——期间/标题/指标文案、波形条（SPEC §4:
//   海报波形 = melodyPitches 主旋律音高序列，契约导出）、QR 字节编码器
//   （EC M、版本 1–5、结构 + RS 代数均有 unit）、纯几何布局、纯排版助手。
//   浏览器函数——paintPoster / renderPosterCanvas（导出前 await
//   document.fonts.ready，SPEC §8）/ posterBlob / sharePoster。
//   本模块顶层零 DOM/零 Web Audio，node 可直接 import。
//
// 契约（web/story/contracts.js，commit fa41b18）是唯一数据形状来源：
//   - metricKeys 用 poster 页 params.metricKeys（契约校验恰好 4 个）；
//   - 指标 key 的命名对齐 definitions.js 的 dot 风格（totals.events 等）。
//     本线自带 label 兜底；若 definitions.js 落地后 key/口径有出入，
//     待 CTO 裁决对齐（specConflicts 见线报告）。
//   - QR 默认载荷 = location.origin（本应用无对外固定域名，绝不编造 URL）；
//     node / 无 origin 时不画二维码，可由调用方 options.qr 覆盖。

import {
  CHAPTER_TYPES, CAPTION_MAX, validateChapter, validatePeriod, melodyPitches,
} from './contracts.js';

export var POSTER_SIZE = { width: 1080, height: 1920 }; // SPEC §8: 导出 PNG 尺寸准确
export var POSTER_MIME = 'image/png';

// 原型 p9 的 2×2 数字格：件事 / AI 接力 / 新用法 / 流派。
export var DEFAULT_METRIC_KEYS = [
  'totals.events', 'totals.aiRelays', 'lessons.learned', 'rhythm.genre',
];

// ---------------------------------------------------------------------------
// 期间文案 — 原型 p0「2026.10.01 — 10.31」与标题里的「十月」。
// ---------------------------------------------------------------------------
var MONTH_CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];

function pad2(n) { return n < 10 ? '0' + n : String(n); }

export function periodLabel(period, type) {
  var p = validatePeriod(period);
  if (!p) return null;
  if (CHAPTER_TYPES.indexOf(type) < 0) return null;
  var from = new Date(p.from + 'T00:00:00');
  var to = new Date(p.to + 'T00:00:00');
  if (type === 'month') return MONTH_CN[from.getMonth()] + '月';
  if (type === 'year') return String(from.getFullYear()) + ' 年';
  return from.getMonth() + 1 + '.' + pad2(from.getDate()) + '–'
    + (to.getMonth() + 1) + '.' + pad2(to.getDate());
}

export function formatPeriodRange(period) {
  var p = validatePeriod(period);
  if (!p) return null;
  var from = p.from.split('-');
  var to = p.to.split('-');
  var head = from[0] + '.' + from[1] + '.' + from[2];
  if (p.from === p.to) return head;
  var tail = (to[0] === from[0] ? '' : to[0] + '.') + to[1] + '.' + to[2];
  return head + ' — ' + tail;
}

// ---------------------------------------------------------------------------
// 指标 — SPEC §3 ⑨「4 个数字」；口径卡与数据一一对应（红线：只呈现事实）。
// ---------------------------------------------------------------------------
export function resolveMetric(key, stats) {
  if (typeof key !== 'string' || !stats || typeof stats !== 'object') return null;
  if (key === 'totals.events') {
    if (!stats.totals || typeof stats.totals.events !== 'number') return null;
    return { value: String(stats.totals.events), label: '件事' };
  }
  if (key === 'totals.aiRelays') {
    if (!stats.totals || typeof stats.totals.aiRelays !== 'number') return null;
    return { value: String(stats.totals.aiRelays), label: '次 AI 接力' };
  }
  if (key === 'lessons.learned') {
    if (!stats.lessons || !Array.isArray(stats.lessons.learned)) return null;
    return { value: String(stats.lessons.learned.length), label: '个新用法' };
  }
  if (key === 'rhythm.genre') {
    var g = stats.rhythm && stats.rhythm.genre;
    return { value: g && g.title ? g.title : '—', label: '时间流派' };
  }
  if (key === 'savedTime.confirmed') {
    // 只统计本人确认过的省时（红线 4）；小数小时如实保留一位。
    var saved = stats.savedTime;
    if (!saved || typeof saved.confirmedMinutes !== 'number') return null;
    var hours = saved.confirmedMinutes / 60;
    return {
      value: Number.isInteger(hours) ? String(hours) : hours.toFixed(1),
      label: '小时 · 已确认省下',
    };
  }
  return null;
}

export function metricKeysFor(chapter) {
  var c = validateChapter(chapter);
  if (!c) return null;
  for (var i = c.pages.length - 1; i >= 0; i -= 1) {
    var page = c.pages[i];
    if (page.type === 'poster') {
      return page.params && page.params.metricKeys
        ? page.params.metricKeys.slice()
        : DEFAULT_METRIC_KEYS.slice();
    }
  }
  return DEFAULT_METRIC_KEYS.slice();
}

// ---------------------------------------------------------------------------
// 标题 — 原型 p0 第二人称「你」、p9 第一人称「我」；规则模板，不鸡汤。
// ---------------------------------------------------------------------------
function fmtHours(minutes) {
  var h = minutes / 60;
  return Number.isInteger(h) ? String(h) : h.toFixed(1);
}

export function posterTitle(chapter, options) {
  var c = validateChapter(chapter);
  if (!c) return null;
  var o = options || {};
  var override = o.override == null ? '' : String(o.override).trim();
  if (override) return override.slice(0, CAPTION_MAX);
  var label = periodLabel(c.period, c.type);
  var person = o.person === 'second' ? '你' : '我';
  var minutes = c.stats.savedTime ? c.stats.savedTime.confirmedMinutes : 0;
  var events = c.stats.totals ? c.stats.totals.events : 0;
  if (minutes >= 60) return label + '，' + person + '把 ' + fmtHours(minutes) + ' 小时还给了自己';
  if (events >= 1) return label + '，' + person + '记下了 ' + events + ' 件事';
  return label;
}

// ---------------------------------------------------------------------------
// 时间之歌波形 — SPEC §4: 海报波形 = 主旋律音高序列（契约 melodyPitches）。
//   pitches → 恰好 count 根条（线性重采样，保持轮廓），值归一到 [0,1]。
//   空/无序列 → 0.35 平线（静音降级时海报仍成立）；全部同音 → 0.5。
// ---------------------------------------------------------------------------
export function waveformBars(pitches, options) {
  var count = options && options.count != null ? options.count : 48;
  if (typeof count !== 'number' || !Number.isFinite(count)
    || Math.floor(count) !== count || count < 2 || count > 4096) return null;
  var src = null;
  if (Array.isArray(pitches)) {
    src = [];
    for (var i = 0; i < pitches.length; i += 1) {
      var p = pitches[i];
      if (typeof p !== 'number' || !Number.isFinite(p)) return null;
      src.push(p);
    }
  } else if (pitches != null) {
    return null;
  }
  var bars = new Array(count);
  var b;
  if (!src || !src.length) {
    for (b = 0; b < count; b += 1) bars[b] = 0.35;
    return bars;
  }
  for (b = 0; b < count; b += 1) {
    var t = src.length === 1 ? 0 : (b * (src.length - 1)) / (count - 1);
    var i0 = Math.floor(t);
    var i1 = Math.min(i0 + 1, src.length - 1);
    var f = t - i0;
    bars[b] = src[i0] + (src[i1] - src[i0]) * f;
  }
  var min = Infinity;
  var max = -Infinity;
  for (b = 0; b < count; b += 1) {
    if (bars[b] < min) min = bars[b];
    if (bars[b] > max) max = bars[b];
  }
  var span = max - min;
  if (span < 1e-9) {
    for (b = 0; b < count; b += 1) bars[b] = 0.5;
    return bars;
  }
  for (b = 0; b < count; b += 1) bars[b] = (bars[b] - min) / span;
  return bars;
}

// ---------------------------------------------------------------------------
// QR 编码器 — 字节模式、EC 级 M、版本 1–5（短 URL 足够；更长载荷 → null，
// 海报不画二维码，绝不截断载荷生成错误码）。不引入依赖（红线 3）。
// ---------------------------------------------------------------------------
var GF_EXP = new Array(512);
var GF_LOG = new Array(256);
(function initGf() {
  var x = 1;
  for (var i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (var j = 255; j < 512; j += 1) GF_EXP[j] = GF_EXP[j - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

var QR_GEN_CACHE = {};
function qrGenerator(ecLen) {
  if (QR_GEN_CACHE[ecLen]) return QR_GEN_CACHE[ecLen];
  var g = [1];
  for (var n = 0; n < ecLen; n += 1) {
    var a = GF_EXP[n % 255];
    var next = new Array(g.length + 1);
    for (var k = 0; k < next.length; k += 1) next[k] = 0;
    for (var i = 0; i < g.length; i += 1) {
      next[i] ^= g[i];               // ×x
      next[i + 1] ^= gfMul(a, g[i]); // + α^n·g
    }
    g = next;
  }
  QR_GEN_CACHE[ecLen] = g;
  return g;
}

function rsEncode(data, ecLen) {
  var gen = qrGenerator(ecLen);
  var rem = new Array(ecLen);
  for (var z = 0; z < ecLen; z += 1) rem[z] = 0;
  for (var i = 0; i < data.length; i += 1) {
    var factor = data[i] ^ rem[0];
    for (var j = 1; j < ecLen; j += 1) rem[j - 1] = rem[j] ^ gfMul(gen[j], factor);
    rem[ecLen - 1] = gfMul(gen[ecLen], factor);
  }
  return rem;
}

// 各版本 EC-M 的数据码字分块与每块纠错码字数（ISO/IEC 18004 表）。
var QR_VERSIONS = [null,
  { blocks: [16], ecPerBlock: 10 },
  { blocks: [28], ecPerBlock: 16 },
  { blocks: [44], ecPerBlock: 26 },
  { blocks: [32, 32], ecPerBlock: 18 },
  { blocks: [43, 43], ecPerBlock: 24 },
];
var QR_ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30]];

function utf8Bytes(text) {
  var TE = typeof TextEncoder !== 'undefined' ? TextEncoder : null;
  if (TE) return new TE().encode(String(text));
  // 老环境兜底（不影响 node ≥ 12 / 现代浏览器）
  var esc = unescape(encodeURIComponent(String(text)));
  var out = [];
  for (var i = 0; i < esc.length; i += 1) out.push(esc.charCodeAt(i) & 0xff);
  return out;
}

export function qrCodewords(text) {
  if (typeof text !== 'string' || !text.length) return null;
  var bytes = utf8Bytes(text);
  var version = 0;
  var dataTotal = 0;
  for (var v = 1; v < QR_VERSIONS.length; v += 1) {
    var spec = QR_VERSIONS[v];
    var sum = 0;
    for (var bi = 0; bi < spec.blocks.length; bi += 1) sum += spec.blocks[bi];
    if (4 + 8 + bytes.length * 8 <= sum * 8) { version = v; dataTotal = sum; break; }
  }
  if (!version) return null;

  // 位流：mode 0100 + 8 位长度 + 数据 + 终止符 + 0 填充到字节 + 交替填充码字。
  var bits = [];
  function push(value, n) {
    for (var i = n - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  }
  push(0b0100, 4);
  push(bytes.length, 8);
  for (var d = 0; d < bytes.length; d += 1) push(bytes[d], 8);
  var capacityBits = dataTotal * 8;
  var terminator = Math.min(4, capacityBits - bits.length);
  if (terminator > 0) push(0, terminator);
  while (bits.length % 8 !== 0) bits.push(0);
  var dataCw = [];
  for (var c = 0; c < bits.length; c += 8) {
    var b = 0;
    for (var k = 0; k < 8; k += 1) b = (b << 1) | bits[c + k];
    dataCw.push(b);
  }
  var padToggle = true;
  while (dataCw.length < dataTotal) {
    dataCw.push(padToggle ? 0xec : 0x11);
    padToggle = !padToggle;
  }

  // 分块 + RS + 交错（v4/v5 两块等长，轮转交错即标准交错）。
  var spec2 = QR_VERSIONS[version];
  var dataBlocks = [];
  var offset = 0;
  for (var b2 = 0; b2 < spec2.blocks.length; b2 += 1) {
    dataBlocks.push(dataCw.slice(offset, offset + spec2.blocks[b2]));
    offset += spec2.blocks[b2];
  }
  var ecBlocks = [];
  for (var b3 = 0; b3 < dataBlocks.length; b3 += 1) {
    ecBlocks.push(rsEncode(dataBlocks[b3], spec2.ecPerBlock));
  }
  var interleavedData = [];
  var interleavedEc = [];
  var maxLen = 0;
  for (var b4 = 0; b4 < dataBlocks.length; b4 += 1) maxLen = Math.max(maxLen, dataBlocks[b4].length);
  for (var p2 = 0; p2 < maxLen; p2 += 1) {
    for (var b5 = 0; b5 < dataBlocks.length; b5 += 1) {
      if (p2 < dataBlocks[b5].length) interleavedData.push(dataBlocks[b5][p2]);
    }
  }
  for (var p3 = 0; p3 < spec2.ecPerBlock; p3 += 1) {
    for (var b6 = 0; b6 < ecBlocks.length; b6 += 1) interleavedEc.push(ecBlocks[b6][p3]);
  }
  return { version: version, data: interleavedData, ec: interleavedEc };
}

var FINDER = [
  [1, 1, 1, 1, 1, 1, 1],
  [1, 0, 0, 0, 0, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 0, 0, 0, 0, 1],
  [1, 1, 1, 1, 1, 1, 1],
];
var ALIGN = [
  [1, 1, 1, 1, 1],
  [1, 0, 0, 0, 1],
  [1, 0, 1, 0, 1],
  [1, 0, 0, 0, 1],
  [1, 1, 1, 1, 1],
];

function maskBit(mask, r, c) {
  switch (mask) {
    case 0: return (r + c) % 2 === 0 ? 1 : 0;
    case 1: return r % 2 === 0 ? 1 : 0;
    case 2: return c % 3 === 0 ? 1 : 0;
    case 3: return (r + c) % 3 === 0 ? 1 : 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0 ? 1 : 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0 ? 1 : 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0 ? 1 : 0;
    default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0 ? 1 : 0;
  }
}

function formatBits(mask) {
  // EC 级 M = 00（2 位）+ mask（3 位）→ BCH(15,5)，生成元 0x537，异或 0x5412。
  var data = (0 << 3) | mask; // M
  var d = data << 10;
  for (var i = 14; i >= 10; i -= 1) {
    if ((d >>> i) & 1) d ^= 0x537 << (i - 10);
  }
  return ((data << 10) | (d & 0x3ff)) ^ 0x5412;
}

function penalty(m) {
  var size = m.length;
  var score = 0;
  var r;
  var c;
  var run;
  var v;
  // N1 行/列同色连跑
  for (r = 0; r < size; r += 1) {
    run = 1;
    for (c = 1; c < size; c += 1) {
      if (m[r][c] === m[r][c - 1]) {
        run += 1;
        if (c === size - 1 && run >= 5) score += 3 + (run - 5);
      } else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
  }
  for (c = 0; c < size; c += 1) {
    run = 1;
    for (r = 1; r < size; r += 1) {
      if (m[r][c] === m[r - 1][c]) {
        run += 1;
        if (r === size - 1 && run >= 5) score += 3 + (run - 5);
      } else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
  }
  // N2 2×2 同色块
  for (r = 0; r < size - 1; r += 1) {
    for (c = 0; c < size - 1; c += 1) {
      v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }
  // N3 1011101 与四连空白的组合模式
  var pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  var pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (r = 0; r < size; r += 1) {
    for (c = 0; c + 11 <= size; c += 1) {
      var okA = true;
      var okB = true;
      for (var wA = 0; wA < 11; wA += 1) {
        if (m[r][c + wA] !== pat1[wA]) okA = false;
        if (m[r][c + wA] !== pat2[wA]) okB = false;
      }
      if (okA || okB) score += 40;
    }
  }
  for (c = 0; c < size; c += 1) {
    for (r = 0; r + 11 <= size; r += 1) {
      var okC = true;
      var okD = true;
      for (var wB = 0; wB < 11; wB += 1) {
        if (m[r + wB][c] !== pat1[wB]) okC = false;
        if (m[r + wB][c] !== pat2[wB]) okD = false;
      }
      if (okC || okD) score += 40;
    }
  }
  // N4 暗模块占比
  var dark = 0;
  for (r = 0; r < size; r += 1) {
    for (c = 0; c < size; c += 1) if (m[r][c]) dark += 1;
  }
  var percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

export function qrMatrix(text) {
  var cw = qrCodewords(text);
  if (!cw) return null;
  var size = 17 + 4 * cw.version;
  var m = [];
  var fn = [];
  var r;
  var c;
  for (r = 0; r < size; r += 1) {
    m.push(new Array(size).fill(0));
    fn.push(new Array(size).fill(0));
  }
  function set(r0, c0, v) { m[r0][c0] = v; fn[r0][c0] = 1; }
  // 三个 finder + 分离环
  function finder(r0, c0) {
    for (var i = 0; i < 7; i += 1) {
      for (var j = 0; j < 7; j += 1) set(r0 + i, c0 + j, FINDER[i][j]);
    }
    var rr;
    var cc;
    for (rr = -1; rr <= 7; rr += 1) {
      for (cc = -1; cc <= 7; cc += 1) {
        var ar = r0 + rr;
        var ac = c0 + cc;
        if (ar < 0 || ac < 0 || ar >= size || ac >= size) continue;
        if (rr >= 0 && rr <= 6 && cc >= 0 && cc <= 6) continue;
        set(ar, ac, 0);
      }
    }
  }
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);
  // timing
  for (c = 8; c < size - 8; c += 1) set(6, c, c % 2 === 0 ? 1 : 0);
  for (r = 8; r < size - 8; r += 1) set(r, 6, r % 2 === 0 ? 1 : 0);
  // alignment
  var centers = QR_ALIGN[cw.version];
  for (var ai = 0; ai < centers.length; ai += 1) {
    for (var aj = 0; aj < centers.length; aj += 1) {
      var ar2 = centers[ai];
      var ac2 = centers[aj];
      if ((ar2 === 6 && ac2 === 6) || (ar2 === 6 && ac2 === size - 7) || (ar2 === size - 7 && ac2 === 6)) continue;
      for (var i3 = -2; i3 <= 2; i3 += 1) {
        for (var j3 = -2; j3 <= 2; j3 += 1) {
          set(ar2 + i3, ac2 + j3, ALIGN[i3 + 2][j3 + 2]);
        }
      }
    }
  }
  // 暗模块 + format 预留
  set(size - 8, 8, 1);
  for (var f = 0; f <= 8; f += 1) {
    if (f !== 6) { if (!fn[8][f]) set(8, f, 0); if (!fn[f][8]) set(f, 8, 0); }
  }
  for (var f2 = 0; f2 < 8; f2 += 1) {
    if (!fn[8][size - 1 - f2]) set(8, size - 1 - f2, 0);
    if (!fn[size - 1 - f2][8]) set(size - 1 - f2, 8, 0);
  }
  // 数据：右下起两列一组的之字
  var all = cw.data.concat(cw.ec);
  var bitIndex = 0;
  var totalBits = all.length * 8;
  var col = size - 1;
  var upward = true;
  while (col > 0) {
    if (col === 6) col -= 1;
    for (var step = 0; step < size; step += 1) {
      r = upward ? size - 1 - step : step;
      for (var cc2 = 0; cc2 < 2; cc2 += 1) {
        var c2 = col - cc2;
        if (fn[r][c2]) continue;
        var bit = 0;
        if (bitIndex < totalBits) bit = (all[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1;
        m[r][c2] = bit;
        bitIndex += 1;
      }
    }
    upward = !upward;
    col -= 2;
  }
  // 掩码：8 个掩码罚分，取最小（只异或非功能区）
  var best = null;
  var bestScore = Infinity;
  for (var mask = 0; mask < 8; mask += 1) {
    var cand = m.map(function (row) { return row.slice(); });
    for (r = 0; r < size; r += 1) {
      for (c = 0; c < size; c += 1) {
        if (!fn[r][c] && maskBit(mask, r, c)) cand[r][c] ^= 1;
      }
    }
    var sc = penalty(cand);
    if (sc < bestScore) { bestScore = sc; best = cand; best.mask = mask; }
  }
  m = best;
  var chosenMask = best.mask;
  // format 信息（选定 mask 后写入功能区）
  var fmt = formatBits(chosenMask);
  function fmtBit(i) { return (fmt >> i) & 1; }
  for (var fi = 0; fi < 15; fi += 1) {
    var bitv = fmtBit(fi);
    // copy 1
    if (fi < 6) m[8][fi] = bitv;
    else if (fi === 6) m[8][7] = bitv;
    else if (fi === 7) m[8][8] = bitv;
    else if (fi === 8) m[7][8] = bitv;
    else m[5 - (fi - 9)][8] = bitv;
    // copy 2: bit0–6 → (size-1..size-7, 8)；bit7–14 → (8, size-8..size-1)
    if (fi <= 6) m[size - 1 - fi][8] = bitv;
    else m[8][size - 8 + (fi - 7)] = bitv;
  }
  return { size: size, rows: m };
}

// ---------------------------------------------------------------------------
// 纯排版助手 — canvas 前的换行/缩字（measure 注入，node 可测）。
// ---------------------------------------------------------------------------
export function wrapTitleLines(text, measure, maxWidth, maxLines) {
  if (typeof text !== 'string' || !text.trim()) return [];
  if (typeof measure !== 'function' || !(maxWidth > 0) || !(maxLines >= 1)) return null;
  var lines = [];
  var paras = text.split('\n');
  for (var pi = 0; pi < paras.length; pi += 1) {
    // 分词：CJK 单字可断；ASCII 词（含数字）整体；空格可断
    var tokens = [];
    var para = paras[pi];
    var i = 0;
    while (i < para.length) {
      var ch = para[i];
      if (/[\s]/.test(ch)) { tokens.push(ch); i += 1; continue; }
      if (ch.charCodeAt(0) > 0x2e7f) { tokens.push(ch); i += 1; continue; } // CJK
      var word = '';
      while (i < para.length && para[i].charCodeAt(0) <= 0x2e7f && !/[\s]/.test(para[i])) {
        word += para[i];
        i += 1;
      }
      tokens.push(word);
    }
    var cur = '';
    for (var t = 0; t < tokens.length; t += 1) {
      var attempt = cur + tokens[t];
      if (measure(attempt) <= maxWidth) { cur = attempt; continue; }
      if (cur) { lines.push(cur.replace(/\s+$/, '')); cur = ''; }
      if (measure(tokens[t]) <= maxWidth) { cur = tokens[t]; continue; }
      // 单 token 超宽：按字符硬切（渲染端 fitText 还会缩字号）
      var hard = '';
      for (var h = 0; h < tokens[t].length; h += 1) {
        if (measure(hard + tokens[t][h]) > maxWidth) { lines.push(hard); hard = ''; }
        hard += tokens[t][h];
      }
      cur = hard;
    }
    if (cur) lines.push(cur.replace(/\s+$/, ''));
  }
  if (lines.length > maxLines) {
    var kept = lines.slice(0, maxLines - 1);
    var rest = lines.slice(maxLines - 1).join('').replace(/\s+$/, '');
    var last = '';
    for (var r2 = 0; r2 < rest.length; r2 += 1) {
      if (measure(last + rest[r2] + '…') <= maxWidth) last += rest[r2];
      else break;
    }
    if (!last) last = rest[0] || '';
    kept.push(last + '…');
    return kept;
  }
  return lines;
}

export function fitText(text, baseSize, measure, maxWidth, minSize) {
  if (typeof text !== 'string' || typeof measure !== 'function') return null;
  var size = baseSize;
  while (size > minSize) {
    if (measure(text, size) <= maxWidth) return { size: size, text: text };
    size -= 4;
  }
  if (measure(text, minSize) <= maxWidth) return { size: minSize, text: text };
  var t = text;
  while (t.length > 1) {
    t = t.slice(0, -1);
    if (measure(t + '…', minSize) <= maxWidth) return { size: minSize, text: t + '…' };
  }
  return { size: minSize, text: t + '…' };
}

// ---------------------------------------------------------------------------
// 布局（纯几何）— 1080×1920；所有块不越界、自上而下有序。
// ---------------------------------------------------------------------------
export function posterLayout(options) {
  var o = options || {};
  var titleLines = o.titleLines != null ? o.titleLines : 3;
  if (!(titleLines >= 1 && titleLines <= 4)) titleLines = 3;
  var W = POSTER_SIZE.width;
  var H = POSTER_SIZE.height;
  var margin = 72;
  var card = { x: margin, y: 204, w: W - margin * 2, pad: 56, r: 76 };
  var title = { x: card.x + card.pad, y: card.y + card.pad, w: card.w - card.pad * 2, size: 96, lineH: 124, lines: titleLines };
  var metrics = {
    x: card.x + card.pad, y: title.y + titleLines * title.lineH + 28,
    w: card.w - card.pad * 2,
    cellW: (card.w - card.pad * 2 - 26) / 2, cellH: 188, cols: 2, rows: 2, gap: 26, r: 44,
    valueSize: 88, labelSize: 34,
  };
  metrics.h = metrics.rows * metrics.cellH + metrics.gap;
  var song = {
    x: card.x + card.pad, y: metrics.y + metrics.h + 28, w: card.w - card.pad * 2,
    barW: 12, barGap: 10, barCount: 37, areaH: 72, labelSize: 32,
  };
  song.h = song.areaH + 18 + song.labelSize;
  card.h = card.pad + titleLines * title.lineH + 28 + metrics.h + 28 + song.h + card.pad;
  var eyebrow = { x: margin, y: 108, w: W - margin * 2, h: 44, size: 34 };
  var qr = { x: margin, y: card.y + card.h + 56, w: 264, h: 264, quietPad: 12, inner: 240 };
  var footer = { x: margin, y: H - 84, w: W - margin * 2, h: 40, size: 30 };
  return { canvas: { width: W, height: H }, margin: margin, eyebrow: eyebrow, card: card, title: title, metrics: metrics, song: song, qr: qr, footer: footer };
}

// ---------------------------------------------------------------------------
// 模型 — 渲染与导出的唯一输入；纯函数、确定性。
// ---------------------------------------------------------------------------
export function posterModel(chapter, options) {
  var c = validateChapter(chapter);
  if (!c) return null;
  var o = options || {};
  var keys = metricKeysFor(c) || DEFAULT_METRIC_KEYS.slice();
  var metrics = [];
  for (var i = 0; i < keys.length; i += 1) {
    var m = resolveMetric(keys[i], c.stats);
    metrics.push(m || { key: keys[i], value: '—', label: '—' });
  }
  var layout = posterLayout({ titleLines: 3 });
  var count = o.waveformCount != null ? o.waveformCount : layout.song.barCount;
  var pitches = o.pitches != null ? o.pitches
    : (o.notes != null ? melodyPitches(o.notes) : null);
  var bars = waveformBars(pitches, { count: count });
  if (!bars) bars = waveformBars(null, { count: count });
  var qrText = o.qr != null ? String(o.qr)
    : (typeof location !== 'undefined' && location && location.origin ? location.origin : null);
  var qr = null;
  if (qrText) {
    var matrix = qrMatrix(qrText);
    if (matrix) qr = { text: qrText, matrix: matrix };
  }
  return {
    chapterNo: c.no,
    eyebrow: '探戈 Done&Go · 第 ' + c.no + ' 章',
    typeLabel: c.type === 'week' ? '周记' : c.type === 'year' ? '年书' : '月章',
    periodLabel: periodLabel(c.period, c.type),
    periodRange: formatPeriodRange(c.period),
    title: posterTitle(c, { person: o.person, override: o.title }),
    metrics: metrics,
    songLabel: '♪ ' + periodLabel(c.period, c.type) + ' · 时间之歌（由我的数据生成）',
    waveform: bars,
    qr: qr,
    footer: formatPeriodRange(c.period) + ' · 由 Done&Go 生成',
  };
}

export function posterFilename(chapter) {
  var c = validateChapter(chapter);
  if (!c) return null;
  return 'donego-ch' + c.no + '-' + c.period.from + '.png';
}

// ---------------------------------------------------------------------------
// 浏览器渲染 — 导出前 await document.fonts.ready（SPEC §8）；系统字体栈，
// 中文不缺字。paintPoster 只读 model + layout，不碰数据。
// ---------------------------------------------------------------------------
var FONT_SANS = '"PingFang SC","Hiragino Sans GB","Noto Sans SC",system-ui,sans-serif';
var FONT_SERIF = '"Songti SC","Noto Serif SC",STSong,serif';
var FONT_NUM = '"Avenir Next","Helvetica Neue",Helvetica,Arial,sans-serif';

function roundRectPath(ctx, x, y, w, h, r) {
  var rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function paintPoster(ctx, model, options) {
  if (!ctx || !model) throw new Error('poster: paintPoster needs ctx and model');
  var o = options || {};
  var L = o.layout || posterLayout({ titleLines: 3 });
  var W = L.canvas.width;
  var H = L.canvas.height;
  // 背景：radial-gradient(110% 70% at 80% 0%) — 用缩放把圆拉成对应椭圆
  ctx.save();
  ctx.scale(1, (H * 0.7) / (W * 1.1));
  var g = ctx.createRadialGradient(W * 0.8, 0, 0, W * 0.8, 0, W * 1.1);
  g.addColorStop(0, '#E9826A');
  g.addColorStop(0.45, '#B8401F');
  g.addColorStop(1, '#5A1E10');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H * (W * 1.1) / (H * 0.7));
  ctx.restore();

  // eyebrow
  ctx.fillStyle = 'rgba(255,255,255,.82)';
  ctx.font = '500 ' + L.eyebrow.size + 'px ' + FONT_SANS;
  if ('letterSpacing' in ctx) ctx.letterSpacing = '8px';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(model.eyebrow, L.eyebrow.x, L.eyebrow.y + L.eyebrow.h - 8);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';

  // 卡片
  roundRectPath(ctx, L.card.x, L.card.y, L.card.w, L.card.h, L.card.r);
  ctx.fillStyle = 'rgba(255,255,255,.12)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.16)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // 标题（serif 900，最多 titleLines 行，块内垂直居中）
  var titleFont = '900 ' + L.title.size + 'px ' + FONT_SERIF;
  ctx.font = titleFont;
  var measure = function (t) { return ctx.measureText(t).width; };
  var lines = wrapTitleLines(String(model.title || ''), measure, L.title.w, L.title.lines) || [];
  var reserved = L.title.lines * L.title.lineH;
  var used = lines.length * L.title.lineH;
  var titleTop = L.title.y + Math.max(0, (reserved - used) / 2);
  ctx.fillStyle = '#FFFFFF';
  ctx.textBaseline = 'top';
  for (var i = 0; i < lines.length; i += 1) {
    ctx.fillText(lines[i], L.title.x, titleTop + i * L.title.lineH);
  }

  // 2×2 数字格
  for (var mi = 0; mi < model.metrics.length && mi < 4; mi += 1) {
    var col = mi % L.metrics.cols;
    var row = Math.floor(mi / L.metrics.cols);
    var cx = L.metrics.x + col * (L.metrics.cellW + L.metrics.gap);
    var cy = L.metrics.y + row * (L.metrics.cellH + L.metrics.gap);
    roundRectPath(ctx, cx, cy, L.metrics.cellW, L.metrics.cellH, L.metrics.r);
    ctx.fillStyle = 'rgba(0,0,0,.18)';
    ctx.fill();
    var metric = model.metrics[mi];
    var fit = fitText(String(metric.value), L.metrics.valueSize, function (t, s) {
      ctx.font = '700 ' + s + 'px ' + FONT_NUM;
      return ctx.measureText(t).width;
    }, L.metrics.cellW - 48, 44);
    ctx.font = '700 ' + fit.size + 'px ' + FONT_NUM;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(fit.text, cx + 24, cy + 26);
    ctx.font = '500 ' + L.metrics.labelSize + 'px ' + FONT_SANS;
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    ctx.fillText(metric.label, cx + 24, cy + 26 + fit.size + 16);
  }

  // 时间之歌波形（白条，圆角，随音高起伏）
  var barStep = L.song.barW + L.song.barGap;
  var centerY = L.song.y + L.song.areaH / 2;
  ctx.fillStyle = 'rgba(255,255,255,.95)';
  for (var wi = 0; wi < L.song.barCount && wi < model.waveform.length; wi += 1) {
    var v = model.waveform[wi];
    var bh = 8 + v * (L.song.areaH - 8);
    roundRectPath(ctx, L.song.x + wi * barStep, centerY - bh / 2, L.song.barW, bh, 6);
    ctx.fill();
  }
  ctx.font = '500 ' + L.song.labelSize + 'px ' + FONT_SANS;
  ctx.fillStyle = 'rgba(255,255,255,.9)';
  ctx.fillText(model.songLabel, L.song.x, L.song.y + L.song.areaH + 18);

  // 二维码（白卡 + 深棕模块；model.qr 为 null 时整块留空，绝不编造链接）
  if (model.qr && model.qr.matrix) {
    var qx = L.qr.x;
    var qy = L.qr.y;
    roundRectPath(ctx, qx, qy, L.qr.w, L.qr.h, 32);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    var matrix = model.qr.matrix;
    var mod = L.qr.inner / matrix.size;
    ctx.fillStyle = '#5A1E10';
    for (var qr = 0; qr < matrix.size; qr += 1) {
      for (var qc = 0; qc < matrix.size; qc += 1) {
        if (matrix.rows[qr][qc]) {
          ctx.fillRect(qx + L.qr.quietPad + qc * mod, qy + L.qr.quietPad + qr * mod,
            Math.ceil(mod), Math.ceil(mod));
        }
      }
    }
    // 二维码旁的说明（事实性文案）
    ctx.textBaseline = 'top';
    ctx.font = '600 34px ' + FONT_SANS;
    ctx.fillStyle = 'rgba(255,255,255,.95)';
    ctx.fillText('Done&Go · 时光故事书', qx + L.qr.w + 28, qy + 28);
    ctx.font = '400 30px ' + FONT_SANS;
    ctx.fillStyle = 'rgba(255,255,255,.8)';
    ctx.fillText(model.periodRange, qx + L.qr.w + 28, qy + 84);
    ctx.fillStyle = 'rgba(255,255,255,.65)';
    ctx.fillText('第 ' + model.chapterNo + ' 章 · ' + model.typeLabel, qx + L.qr.w + 28, qy + 130);
  }

  // 页脚
  ctx.font = '400 ' + L.footer.size + 'px ' + FONT_SANS;
  ctx.fillStyle = 'rgba(255,255,255,.6)';
  ctx.textAlign = 'center';
  ctx.fillText(model.footer, W / 2, L.footer.y);
  ctx.textAlign = 'left';
}

export async function renderPosterCanvas(chapter, options) {
  var model = posterModel(chapter, options);
  if (!model) throw new Error('poster: invalid chapter');
  var doc = typeof document !== 'undefined' ? document : null;
  if (!doc) throw new Error('poster: canvas export requires a browser DOM');
  // SPEC §8: 导出前等 document.fonts.ready（系统字体栈保证中文不缺字）
  if (doc.fonts && doc.fonts.ready) {
    try { await doc.fonts.ready; } catch (e) { /* 字体 API 不可用时用系统字体照样渲染 */ }
  }
  var canvas = doc.createElement('canvas');
  canvas.width = POSTER_SIZE.width;
  canvas.height = POSTER_SIZE.height;
  var ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('poster: 2d context unavailable');
  paintPoster(ctx, model, options);
  return canvas;
}

export async function posterBlob(chapter, options) {
  var canvas = options && options.canvas ? options.canvas : await renderPosterCanvas(chapter, options);
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type: POSTER_MIME });
  return new Promise(function (resolve, reject) {
    canvas.toBlob(function (blob) {
      if (blob) resolve(blob);
      else reject(new Error('poster: toBlob failed'));
    }, POSTER_MIME);
  });
}

export async function sharePoster(chapter, options) {
  var blob = await posterBlob(chapter, options);
  var name = posterFilename(chapter) || 'donego-poster.png';
  var nav = typeof navigator !== 'undefined' ? navigator : null;
  var doc = typeof document !== 'undefined' ? document : null;
  if (nav && typeof File === 'function') {
    var file = new File([blob], name, { type: POSTER_MIME });
    if (nav.canShare && nav.canShare({ files: [file] })) {
      await nav.share({ files: [file], title: 'Done&Go 时光故事书' });
      return { mode: 'share' };
    }
  }
  if (!doc) throw new Error('poster: download fallback requires a browser DOM');
  var url = URL.createObjectURL(blob);
  var a = doc.createElement('a');
  a.href = url;
  a.download = name;
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  return { mode: 'download' };
}
