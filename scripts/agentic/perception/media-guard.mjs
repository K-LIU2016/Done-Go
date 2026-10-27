// W12 现场感知：上传媒体守门——魔数白名单拒伪装扩展名 + 体积/时长上限。
// BUILD-PLAN §3 W12-1：图 ≤10MB；视频 ≤60MB 且 ffprobe 时长 ≤60s。
// 探测命令可注入（单测一律 mock，BUILD-PLAN §2.3）；真实 ffprobe 只在冒烟时用。
'use strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// 上限按字节计；+4/+12 是魔数/ftyp 盒头的前缀余量（夹具以「魔数+定长填充」构造）。
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024 + 4;
export const VIDEO_MAX_BYTES = 60 * 1024 * 1024 + 12;
export const VIDEO_MAX_SECONDS = 60;

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'tif1']);
const MOV_BRANDS = new Set(['qt  ', 'qt']);
const FORMAT_MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
const FORMAT_KIND = { jpeg: 'image', png: 'image', webp: 'image', heic: 'image', mp4: 'video', webm: 'video', mov: 'video' };
const EXT_FORMAT = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp', heic: 'heic', mp4: 'mp4', webm: 'webm', mov: 'mov' };

const extOf = filename => {
  const name = String(filename ?? '');
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i + 1).toLowerCase();
};

/** 魔数 → 规范格式名（jpeg/png/webp/heic/mp4/webm/mov）；不在白名单或缓冲过短 → null。 */
export function detectKind(data) {
  if (!Buffer.isBuffer(data) || data.length < 4) return null;
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';
  if (data.length >= 8 && data.readUInt32BE(0) === 0x89504e47 && data.readUInt32BE(4) === 0x0d0a1a0a) return 'png';
  if (data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) return 'webm'; // EBML
  if (data.length >= 12 && data.toString('latin1', 4, 8) === 'ftyp') { // ISO BMFF：size + 'ftyp' + brand
    const brand = data.toString('latin1', 8, 12);
    if (HEIC_BRANDS.has(brand)) return 'heic';
    if (MOV_BRANDS.has(brand)) return 'mov';
    if (/^(iso|mp4|avc|av01|dash|m4v |msnv|dby|3gp)/.test(brand)) return 'mp4';
    return null; // 未知 brand：宁拒不错
  }
  return null;
}

/**
 * 上传件检查：魔数 → 扩展名白名单 → 魔数与扩展名一致性 → 体积上限。
 * 通过返回 { ok:true, kind:'image'|'video', mime, format }；任何一步不过抛错（415/413 语义）。
 */
export function checkUpload({ data, filename } = {}) {
  const format = detectKind(data);
  if (!format) throw new Error('rejected: unknown magic bytes (not in image/video whitelist)');
  const ext = extOf(filename);
  const expected = EXT_FORMAT[ext];
  if (!expected) {
    throw new Error(`rejected: extension ".${ext}" not allowed (whitelist: ${Object.keys(EXT_FORMAT).join('/')})`);
  }
  if (expected !== format) {
    throw new Error(`rejected: extension mismatch — ".${ext}" implies ${expected} but magic bytes are ${format}`);
  }
  const kind = FORMAT_KIND[format];
  const cap = kind === 'image' ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES;
  if (data.length > cap) throw new Error(`${kind} too large: ${data.length} bytes exceeds ${cap} byte cap`);
  return { ok: true, kind, mime: FORMAT_MIME[format], format };
}

/** 默认 ffprobe 探测（真实子进程；单测注入 run 替代）。 */
async function runFfprobe(bin, args) {
  const { stdout, stderr } = await execFileAsync(bin, args, { maxBuffer: 1 << 20 });
  return { stdout, stderr };
}

/** 视频时长（秒）：ffprobe 可注入；> maxSeconds（默认 60s）抛错；探测失败统一抛 probe 错。 */
export async function checkVideoDuration(file, { run = runFfprobe, maxSeconds = VIDEO_MAX_SECONDS } = {}) {
  let out;
  try {
    out = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', String(file)]);
  } catch (err) {
    throw new Error(`ffprobe probe failed: ${err.message}`);
  }
  let info;
  try {
    info = JSON.parse(out.stdout);
  } catch {
    throw new Error('ffprobe probe failed: unparsable JSON output');
  }
  const streams = Array.isArray(info.streams) ? info.streams : [];
  if (!streams.some(s => s && s.codec_type === 'video')) {
    throw new Error('ffprobe probe failed: no video stream found');
  }
  const duration = Number(info.format && info.format.duration);
  if (!Number.isFinite(duration) || duration < 0) {
    throw new Error('ffprobe probe failed: missing format.duration');
  }
  if (duration > maxSeconds) throw new Error(`video too long: ${duration}s exceeds ${maxSeconds}s cap`);
  return duration;
}
