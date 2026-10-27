// W12 现场感知 · 视频抽帧：ffprobe 时长/流检测 + ffmpeg 每 2s 或场景切换抽帧（≤15 帧 JPEG）
// + 音轨（若有）提 wav 交语音管线留桩 handoffAudio(captureId, wavPath)（BUILD-PLAN L144、PRD §6.8.2 L497）。
// 子进程一律经可注入 run（单测 mock 命令拼接，BUILD-PLAN §2.3）；真实 ffmpeg 只在冒烟时用（bins 可注绝对路径）。
// 单次 ffmpeg 单遍 select 完成「每 2s ∪ 场景切换」合并去重（一帧只选一次）；>15 帧再均匀采样到全片 ≤15。
'use strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

export const FRAME_INTERVAL_SEC = 2; // PRD L497：每 2 秒或场景切换抽一帧
export const SCENE_THRESHOLD = 0.3; // BUILD-PLAN L144：select=gt(scene,0.3)
export const MAX_FRAMES = 15; // BUILD-PLAN L144：上限 15 帧
const FRAME_PATTERN = 'frame-%03d.jpg';
const FRAME_RE = /^frame-\d{3,}\.jpg$/;

// select 表达式（单引号是 ffmpeg 滤镜图级引号：护住表达式内逗号，不被滤镜图切分器吃掉）：
// 首帧必选（prev_selected_t 初始为 NaN）+ 距上一选中帧 ≥2s + 场景分 >0.3。
const SELECT_EXPR = `select='isnan(prev_selected_t)+gte(t,prev_selected_t+${FRAME_INTERVAL_SEC})+gt(scene,${SCENE_THRESHOLD})'`;

/** 默认 runner：真实子进程（execFile，不经 shell）；非零退出/无法启动统一抛错。 */
export async function runCommand(bin, args) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { maxBuffer: 1 << 20 });
    return { stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    throw new Error(`command failed (${bin}): ${err.message}`);
  }
}

/**
 * ffprobe 时长/流检测（fail closed）。返回 { durationSec, hasAudio }（恰好两键）。
 * 子进程异常 / 非 JSON / 无视频流 / 缺 format.duration 一律抛 probe 错。
 */
export async function probeVideo(videoPath, { run = runCommand, bins } = {}) {
  const ffprobe = (bins && bins.ffprobe) || 'ffprobe';
  let out;
  try {
    out = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', String(videoPath)]);
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
  return { durationSec: duration, hasAudio: streams.some(s => s && s.codec_type === 'audio') };
}

/** 列出 workDir 里 ffmpeg 产物帧并按序号排序。 */
function listFrames(workDir) {
  return readdirSync(workDir).filter(n => FRAME_RE.test(n)).sort();
}

/** >MAX_FRAMES 时均匀采样索引（升序、含首末、不重复），落盘的未选中帧删掉。 */
function capFrames(workDir, names) {
  if (names.length <= MAX_FRAMES) return names;
  const picked = new Set();
  for (let i = 0; i < MAX_FRAMES; i++) picked.add(names[Math.round((i * (names.length - 1)) / (MAX_FRAMES - 1))]);
  for (const name of names) if (!picked.has(name)) { try { unlinkSync(join(workDir, name)); } catch { /* 尽力删 */ } }
  return names.filter(n => picked.has(n));
}

/**
 * 抽帧主入口（pipeline 调用形状对齐 tests/unit/agentic/perception/pipeline.test.mjs:168）：
 * extractFrames({ captureId, videoPath, tmpRoot, run, bins, handoffAudio }) →
 * { durationSec, frames[], audioPath|null, workDir, cleanup }。
 * 流程：probe → 单次 ffmpeg（每 2s ∪ 场景切换）→ ≤15 均匀采样 → 有音轨再提 16kHz 单声道 wav →
 * handoffAudio(captureId, wavPath)（语音管线留桩，BUILD-PLAN L144）。wav 失败优雅降级（帧不陪葬）；
 * 抽帧失败清掉本次临时目录再抛错。
 */
export async function extractFrames({ captureId, videoPath, tmpRoot, run = runCommand, bins, handoffAudio = null } = {}) {
  if (!videoPath) throw new Error('frames: videoPath required');
  if (!tmpRoot) throw new Error('frames: tmpRoot required');
  const ffmpeg = (bins && bins.ffmpeg) || 'ffmpeg';
  const { durationSec, hasAudio } = await probeVideo(videoPath, { run, bins });
  const workDir = mkdtempSync(join(tmpRoot, `frames-${String(captureId).replace(/[^a-zA-Z0-9_-]/g, '_')}-`));
  let frames;
  try {
    await run(ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-i', String(videoPath),
      '-vf', SELECT_EXPR,
      '-fps_mode', 'vfr',
      '-q:v', '2',
      join(workDir, FRAME_PATTERN),
    ]);
    frames = capFrames(workDir, listFrames(workDir)).map(n => join(workDir, n));
  } catch (err) {
    rmSync(workDir, { recursive: true, force: true });
    throw new Error(`frame extraction failed: ${err.message}`);
  }
  let audioPath = null;
  if (hasAudio) {
    const wav = join(workDir, 'audio.wav');
    try {
      await run(ffmpeg, [
        '-hide_banner', '-loglevel', 'error',
        '-i', String(videoPath),
        '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1',
        wav,
      ]);
      if (existsSync(wav)) audioPath = wav; // 成功但没落盘：视同无音轨
    } catch {
      audioPath = null; // 音轨是留桩增强，失败降级不拖垮帧（快慢双路感知照常走）
    }
  }
  if (audioPath && typeof handoffAudio === 'function') await handoffAudio(captureId, audioPath);
  return {
    durationSec,
    frames,
    audioPath,
    workDir,
    cleanup: async () => {
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}
