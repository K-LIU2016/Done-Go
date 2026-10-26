// W11 media-gen · 按 Mission 版本的媒体缓存。
// 依据：BUILD-PLAN §3 W11.1 与 PRD §5.2「缓存与增量」：同一 Mission 版本缓存全部层，
// 讨论修改只重生成受影响的样张页。cache key = missionId+version+model+prompt 归一化哈希，
// 新版本不命中旧缓存；缓存条目记来源与元数据（source/model/prompt/missionId/version/createdAt）。
// 落盘走 tmp+rename 原子写（照 ccr_storage 的思路自写最小实现，不新增依赖）。
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** 把 prompt 的空白折叠成单空格并去首尾：语义等价的 prompt 共享一个缓存条目。 */
export function normalizePrompt(prompt) {
  return String(prompt ?? '').split(/\s+/).filter(Boolean).join(' ');
}

/** tmp+rename 原子写：多窗口/多进程并发写不会留下半写文件。 */
function atomicWrite(file, data) {
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

/**
 * 媒体缓存：目录里每个条目两个文件——<key>.bin（字节）与 <key>.json（元数据）。
 * 每次操作直接读盘，因此跨实例（= 跨进程）天然一致。
 */
export function createMediaCache({ dir }) {
  mkdirSync(dir, { recursive: true });

  const binFile = key => join(dir, key + '.bin');
  const metaFile = key => join(dir, key + '.json');

  return {
    /** sha256(missionId \n version \n model \n 归一化 prompt) 的 hex；任一分量不同即不同键。 */
    key({ missionId, version, model, prompt }) {
      const raw = [missionId, version, model, normalizePrompt(prompt)].map(v => String(v ?? '')).join('\n');
      return createHash('sha256').update(raw, 'utf8').digest('hex');
    },

    /** 写入字节与元数据，返回 { file }（bin 的绝对路径）。 */
    put(key, bytes, meta = {}) {
      atomicWrite(binFile(key), Buffer.from(bytes));
      const record = { ...meta, createdAt: new Date().toISOString() };
      atomicWrite(metaFile(key), JSON.stringify(record, null, 2));
      return { file: binFile(key) };
    },

    /** 命中返回 { file, bytes, meta }；bin 或元数据缺失/损坏返回 null。 */
    get(key) {
      try {
        const meta = JSON.parse(readFileSync(metaFile(key), 'utf8'));
        const bytes = readFileSync(binFile(key));
        return { file: binFile(key), bytes, meta };
      } catch {
        return null;
      }
    },
  };
}
