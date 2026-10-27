// W11 media-gen · 每日配额计数器。
// 依据：PRD §5.2「缓存与增量」：生图/视频花费计入每日预演预算（默认：生图 ≤30 张/天，
// 场景片 ≤3 段/天，可调）。BUILD-PLAN §2.3 的冒烟红线（生图 ≤20、生视频 ≤2）是另一组
// 数字，由 smoke 阶段自己约束，不在这里。
// 原子落盘（tmp+rename）、跨进程安全（每次操作读盘）、超额抛类型化错误 QUOTA_EXCEEDED。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/** 产品默认（PRD §5.2）：生图 30 张/天。冒烟预算 ≤20 是另一个数字（smoke.mjs 管）。 */
export const DEFAULT_IMAGE_QUOTA = 30;
/** 产品默认（PRD §5.2）：场景片 3 段/天。 */
export const DEFAULT_VIDEO_QUOTA = 3;

/** Asia/Shanghai 的日键（YYYY-MM-DD）：预演预算按本地一天滚动。 */
export function shanghaiDayKey(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function quotaError(message) {
  return Object.assign(new Error(message), { code: 'QUOTA_EXCEEDED' });
}

function atomicWriteJson(file, value) {
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

/** 读状态文件：缺失或损坏（半写/手改坏）都当作空账本，当天从 0 记起。 */
function loadState(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.days && typeof parsed.days === 'object') return parsed;
  } catch { /* 缺失/损坏 → 重来 */ }
  return { days: {} };
}

/**
 * 每日配额：used()/remaining()/check() 只读；spend(n) 记账（超额整批拒绝、不记半笔）。
 * now 必须可注入（测试钉死时钟）；跨实例（= 另一进程）读同一文件看到同一计数。
 */
export function createDailyQuota({ file, limit = DEFAULT_IMAGE_QUOTA, now = () => new Date() }) {
  mkdirSync(dirname(file), { recursive: true });
  const today = () => shanghaiDayKey(now());

  const readCount = day => Number(loadState(file).days[day] ?? 0);

  return {
    /** 某天已用次数；缺省查今天。历史日仍可查（账本按日保留）。 */
    used(day = today()) { return readCount(day); },

    /** 今天剩余次数（不为负）。 */
    remaining() { return Math.max(0, limit - this.used()); },

    /** { ok, used, remaining }：超额检查不抛错，调用方可以先看再花。 */
    check() {
      const used = this.used();
      return { ok: used < limit, used, remaining: Math.max(0, limit - used) };
    },

    /** 记 n 次使用（默认 1）。整批会超额则整体拒绝、一个都不记。 */
    spend(n = 1) {
      const count = Math.max(1, Math.floor(n));
      const state = loadState(file);
      const day = today();
      const used = Number(state.days[day] ?? 0);
      if (used + count > limit) {
        throw quotaError(`每日配额已用尽：上限 ${limit} 次/天，已用 ${used}，本次还需 ${count}`);
      }
      state.days[day] = used + count;
      atomicWriteJson(file, state);
      return used + count;
    },
  };
}
