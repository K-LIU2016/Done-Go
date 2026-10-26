// W11 tts · 中文 TTS 模型下载器：单 URL → sha256 校验 → 落盘；校验不过/超限即删，不留半成品。
// tar.bz2 模型包下载后解包安装到 asr-lab/models/tts/<模型名>/（models.md 是来源与校验和台账，
// DEFAULT_MODELS 与其保持同步）。单测注入 fetch 与小 tarball，不真实外呼。
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync, renameSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024; // tts-models 最大包 ~635MB，1GiB 留裕量
export const MODELS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'asr-lab', 'models', 'tts');

// 台账唯一凭证是 scripts/agentic/tts/models.md；此处为安装器默认清单，两者必须同步更新。
export const DEFAULT_MODELS = [
  {
    name: 'vits-piper-zh_CN-xiao_ya-medium-int8',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-zh_CN-xiao_ya-medium-int8.tar.bz2',
    sha256: 'eab027e194e70289233cf12308373611fa4e2e96ef2d97354ef433ab663d831f',
  },
];

/**
 * 下载单个文件到 dir/name。失败类型（都带 code，且不留下任何文件）：
 * http-<status> / DOWNLOAD_TOO_LARGE（超过 maxBytes）/ CHECKSUM_MISMATCH（校验不过即删）。
 * 返回 { file, sha256, bytes }。
 */
export async function downloadModel({ url, sha256, dir, name, fetch: fetchImpl = fetch, maxBytes = DEFAULT_MAX_BYTES, log = () => {} }) {
  const res = await fetchImpl(url);
  if (!res.ok) throw typed(`TTS model download failed: HTTP ${res.status} for ${url}`, `http-${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const file = join(dir, name), part = file + '.part';
  mkdirSync(dir, { recursive: true });
  let got = '';
  try {
    if (bytes.length > maxBytes) throw typed(`TTS model too large: ${bytes.length} > maxBytes ${maxBytes}`, 'DOWNLOAD_TOO_LARGE');
    writeFileSync(part, bytes);
    got = createHash('sha256').update(bytes).digest('hex');
    if (got !== String(sha256).toLowerCase()) throw typed(`TTS model checksum mismatch for ${url}: want ${sha256} got ${got}`, 'CHECKSUM_MISMATCH');
    renameSync(part, file);
    log(`downloaded ${name} (${bytes.length} bytes, sha256 ok)`);
  } catch (e) { rmSync(part, { force: true }); throw e; } // 半成品即删：失败后目录回到空
  return { file, sha256: got, bytes: bytes.length };
}

/** 解包 tar.bz2 到 into/，校验解出目录里有 .onnx，返回解出的顶层目录名。 */
export function installTarball({ file, into, extract = defaultExtract }) {
  mkdirSync(into, { recursive: true });
  const top = extract(file, into); // [顶层目录名]
  const dir = top && join(into, top);
  if (!dir || !readdirSync(dir).some(f => f.endsWith('.onnx'))) { if (dir) rmSync(dir, { recursive: true, force: true }); throw typed(`TTS tarball has no .onnx inside: ${file}`, 'MODEL_PACKAGE_INVALID'); }
  return dir;
}

function defaultExtract(tarball, into) {
  const before = new Set(readdirSync(into, { withFileTypes: true }).filter(f => f.isDirectory()).map(f => f.name));
  const r = spawnSync('tar', ['-xjf', tarball, '-C', into], { stdio: 'pipe' });
  if (r.status !== 0) throw typed(`tar -xjf failed (${r.status}): ${r.stderr}`, 'EXTRACT_FAILED');
  return readdirSync(into, { withFileTypes: true }).find(f => f.isDirectory() && !before.has(f.name))?.name; // 解包新出现的顶层目录
}

/** 按 models.md 台账下载并安装全部模型：下载 → 校验 → 解包 → 删 tarball。 */
export async function installModels({ root = MODELS_ROOT, models = DEFAULT_MODELS, fetch: fetchImpl = fetch, log = () => {} } = {}) {
  mkdirSync(root, { recursive: true });
  const installed = [];
  for (const m of models) {
    let present = false;
    try { present = readdirSync(join(root, m.name)).some(f => f.endsWith('.onnx')); } catch { /* 尚未安装 */ }
    if (present) { log(`${m.name}: already installed`); installed.push(join(root, m.name)); continue; }
    const downloads = join(root, '.downloads');
    const { file } = await downloadModel({ url: m.url, sha256: m.sha256, dir: downloads, name: `${m.name}.tar.bz2`, fetch: fetchImpl, log });
    const dir = installTarball({ file, into: root });
    if (dir !== join(root, m.name)) throw typed(`tarball top dir ${dir} != 台账名 ${join(root, m.name)}（models.md 与包内容不同步）`, 'MODEL_PACKAGE_INVALID');
    rmSync(file, { force: true });
    installed.push(dir);
  }
  return installed;
}

const typed = (message, code) => Object.assign(new Error(message), { code });

const invokedDirectly = () => { try { return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (invokedDirectly()) {
  // CLI：node scripts/agentic/tts/download-model.mjs（真实安装，供冒烟前一次性执行）
  installModels({ log: m => process.stdout.write(m + '\n') }).then(
    dirs => { for (const d of dirs) process.stdout.write(`installed: ${d}\n`); },
    e => { process.stderr.write(`${e.code ?? 'ERROR'}: ${e.message}\n`); process.exit(1); },
  );
}
