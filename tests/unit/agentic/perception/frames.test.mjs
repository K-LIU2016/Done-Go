// frames 契约：ffprobe 时长/流检测；每 2s 或场景切换抽帧（select=gt(scene,0.3)）合并去重 ≤15 帧 JPEG；
// 音轨提 wav 交语音管线留桩 handoffAudio(captureId, wavPath)（BUILD-PLAN L144）；spawn 可注入假 runner；
// 临时目录清理。真实 ffmpeg 只在冒烟跑。对应实现：scripts/agentic/perception/frames.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { probeVideo, extractFrames, runCommand, MAX_FRAMES } from '../../../../scripts/agentic/perception/frames.mjs';

const probeStdout = (duration, audio) => JSON.stringify({ streams: [{ codec_type: 'video' }, ...(audio ? [{ codec_type: 'audio' }] : [])], format: { duration: String(duration) } });

function makeRunner({ duration = 10, audio = false, frameCount = 20 } = {}) {
  const calls = [];
  const run = async (bin, args) => {
    calls.push({ bin, args });
    if (bin === 'ffprobe') return { stdout: probeStdout(duration, audio), stderr: '' };
    const wav = args.find(a => typeof a === 'string' && a.endsWith('.wav'));
    if (wav !== undefined) { writeFileSync(wav, Buffer.alloc(32, 0x01)); return { stdout: '', stderr: '' }; }
    const pattern = args.find(a => typeof a === 'string' && a.includes('%') && a.endsWith('.jpg'));
    if (pattern !== undefined) {
      const dir = dirname(pattern);
      for (let i = 1; i <= frameCount; i++) writeFileSync(join(dir, `frame-${String(i).padStart(3, '0')}.jpg`), Buffer.alloc(8, i));
    }
    return { stdout: '', stderr: '' };
  };
  return { calls, run };
}

test('probeVideo returns duration and audio presence, invoking ffprobe on the file', async () => {
  const { calls, run } = makeRunner({ duration: 12.5, audio: true });
  const info = await probeVideo('/tmp/clip.mp4', { run });
  assert.deepEqual(info, { durationSec: 12.5, hasAudio: true });
  assert.equal(calls[0].bin, 'ffprobe');
  assert.ok(calls[0].args.includes('/tmp/clip.mp4'), 'ffprobe 必须探测该文件');
  const silent = await probeVideo('/tmp/clip.mp4', { run: makeRunner({ duration: 5, audio: false }).run });
  assert.equal(silent.hasAudio, false);
});

test('probeVideo fails closed on garbage output or a crashing ffprobe', async () => {
  await assert.rejects(probeVideo('/tmp/v.mp4', { run: async () => ({ stdout: 'not json', stderr: '' }) }), /probe/i);
  await assert.rejects(probeVideo('/tmp/v.mp4', { run: async () => { throw new Error('ffprobe not found'); } }), /probe|ffprobe/i);
});

test('extractFrames caps the merged frame set at 15, sorted, all inside the work dir', async t => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'w12-frames-'));
  t.after(() => { try { readdirSync(tmpRoot); } catch { /* 已被 cleanup 清掉就算过 */ } });
  const { calls, run } = makeRunner({ duration: 40, frameCount: 20 });
  const out = await extractFrames({ captureId: 'cap-1', videoPath: '/tmp/clip.mp4', tmpRoot, run });
  assert.ok(out.workDir.startsWith(tmpRoot), '临时目录建在 tmpRoot 下');
  assert.equal(out.frames.length, 15, '20 帧产物截到 15');
  const names = out.frames.map(f => f.split('/').pop());
  assert.deepEqual([...names].sort(), names, '帧路径有序（去重合并后按序号）');
  assert.ok(out.frames.every(f => f.startsWith(out.workDir) && f.endsWith('.jpg')));
  const ffmpeg = calls.filter(c => c.bin === 'ffmpeg');
  assert.equal(ffmpeg.length, 1, '抽帧只跑一次 ffmpeg');
  assert.ok(ffmpeg[0].args.includes('/tmp/clip.mp4'), '以原视频为输入');
  assert.ok(ffmpeg[0].args.some(a => String(a).includes('gt(scene,0.3)')), '按场景切换抽帧（select=gt(scene,0.3)）');
  assert.ok(ffmpeg[0].args.some(a => String(a).endsWith('.jpg')), '输出为 JPEG 帧序列模板');
});

test('fewer than 15 produced frames are all kept', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'w12-frames-'));
  const out = await extractFrames({ captureId: 'cap-2', videoPath: '/tmp/clip.mp4', tmpRoot, run: makeRunner({ duration: 8, frameCount: 4 }).run });
  assert.equal(out.frames.length, 4);
});

test('audio track is extracted to wav and handed off to the voice pipeline stub', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'w12-frames-'));
  const handed = [];
  const out = await extractFrames({ captureId: 'cap-3', videoPath: '/tmp/clip.mp4', tmpRoot, run: makeRunner({ duration: 10, audio: true, frameCount: 3 }).run, handoffAudio: async (captureId, wavPath) => { handed.push([captureId, wavPath]); } });
  assert.deepEqual(handed, [['cap-3', out.audioPath]], 'handoffAudio(captureId, wavPath) 被调用');
  assert.ok(out.audioPath.endsWith('.wav') && existsSync(out.audioPath), 'wav 真实落盘在临时目录');
});

test('no audio track → no wav, no handoff', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'w12-frames-'));
  let handed = 0;
  const out = await extractFrames({ captureId: 'cap-4', videoPath: '/tmp/clip.mp4', tmpRoot, run: makeRunner({ duration: 10, audio: false, frameCount: 2 }).run, handoffAudio: async () => { handed++; } });
  assert.equal(out.audioPath, null);
  assert.equal(handed, 0);
});

test('cleanup() removes the whole temp dir; frames live until then', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'w12-frames-'));
  const out = await extractFrames({ captureId: 'cap-5', videoPath: '/tmp/clip.mp4', tmpRoot, run: makeRunner({ duration: 10, frameCount: 2 }).run });
  assert.ok(existsSync(out.workDir) && out.frames.every(f => existsSync(f)));
  await out.cleanup();
  assert.equal(existsSync(out.workDir), false, '临时目录被清理');
});

// ---- 以下为本模块补测（基线 7 例之上仅追加，无删改）----

test('runCommand（默认 runner）：真实子进程，stdout 透出，非零退出码拒绝', async () => {
  const ok = await runCommand(process.execPath, ['-e', 'process.stdout.write("ok")']);
  assert.equal(ok.stdout, 'ok');
  assert.equal(ok.stderr, '');
  await assert.rejects(runCommand(process.execPath, ['--unknown-flag-nope']), /failed/i);
});

test('远超 15 帧时均匀采样：保留首末帧、有序去重，未选中帧从磁盘删除', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'w12-frames-'));
  const out = await extractFrames({ captureId: 'cap-6', videoPath: '/tmp/clip.mp4', tmpRoot, run: makeRunner({ duration: 60, frameCount: 30 }).run });
  assert.equal(MAX_FRAMES, 15, '上限常量=15（BUILD-PLAN L144）');
  assert.equal(out.frames.length, 15);
  const names = out.frames.map(f => f.split('/').pop());
  assert.equal(names[0], 'frame-001.jpg', '首帧保留');
  assert.equal(names[names.length - 1], 'frame-030.jpg', '末帧保留（覆盖全片）');
  assert.deepEqual([...names].sort(), names, '有序');
  assert.equal(new Set(names).size, 15, '去重');
  assert.equal(existsSync(join(out.workDir, 'frame-002.jpg')), false, '未选中帧删除，落盘 ≤15');
  await out.cleanup();
});

test('probeVideo fail-closed 补充：无视频流 / 缺 duration 的合法 JSON 也拒', async () => {
  const noVideo = async () => ({ stdout: JSON.stringify({ streams: [{ codec_type: 'audio' }], format: { duration: '5' } }), stderr: '' });
  await assert.rejects(probeVideo('/tmp/v.mp4', { run: noVideo }), /probe/i);
  const noDuration = async () => ({ stdout: JSON.stringify({ streams: [{ codec_type: 'video' }], format: {} }), stderr: '' });
  await assert.rejects(probeVideo('/tmp/v.mp4', { run: noDuration }), /probe/i);
});

test('wav 提取失败优雅降级：帧不陪葬，audioPath=null 不交桩', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'w12-frames-'));
  let handed = 0;
  const base = makeRunner({ duration: 10, audio: true, frameCount: 2 });
  const run = async (bin, args) => {
    if (bin === 'ffmpeg' && args.some(a => typeof a === 'string' && a.endsWith('.wav'))) throw new Error('wav boom');
    return base.run(bin, args);
  };
  const out = await extractFrames({ captureId: 'cap-7', videoPath: '/tmp/clip.mp4', tmpRoot, run, handoffAudio: async () => { handed++; } });
  assert.equal(out.frames.length, 2, '帧照常返回');
  assert.equal(out.audioPath, null);
  assert.equal(handed, 0);
  await out.cleanup();
});

test('bins 可注入：ffprobeBin/ffmpegBin 原样传给 run（真实冒烟用绝对路径）', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'w12-frames-'));
  const base = makeRunner({ duration: 6, audio: true, frameCount: 1 });
  const seenBins = [];
  const run = async (bin, args) => {
    seenBins.push(bin);
    return base.run(bin.endsWith('ffprobe') ? 'ffprobe' : 'ffmpeg', args); // 基线 makeRunner 只认短名
  };
  const out = await extractFrames({ captureId: 'cap-8', videoPath: '/tmp/clip.mp4', tmpRoot, run, bins: { ffprobe: '/opt/homebrew/bin/ffprobe', ffmpeg: '/opt/homebrew/bin/ffmpeg' } });
  assert.deepEqual([...new Set(seenBins)].sort(), ['/opt/homebrew/bin/ffmpeg', '/opt/homebrew/bin/ffprobe']);
  await out.cleanup();
});

test('ffmpeg 抽帧失败：reject 且不在 tmpRoot 留残留目录', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'w12-frames-'));
  const base = makeRunner({ duration: 10, frameCount: 2 });
  const run = async (bin, args) => {
    if (bin === 'ffmpeg') throw new Error('ffmpeg boom');
    return base.run(bin, args);
  };
  await assert.rejects(extractFrames({ captureId: 'cap-9', videoPath: '/tmp/clip.mp4', tmpRoot, run }), /frame|ffmpeg/i);
  assert.deepEqual(readdirSync(tmpRoot), [], '失败路径临时目录已清');
});
