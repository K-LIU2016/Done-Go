// S2D-W13 · 发布候选校验器（scripts/agentic/integration/release.mjs）。
//
// 依据：brief §5.8「发布候选 build 的 manifest 包含所有已批准的 web/server
// 文件……上一候选的回滚读取和服务行为可复核」、§6 门禁 6；plan.md §G6
// M24/M26。RED 规格先行（tests/unit/agentic/integration/release-rollback.test.mjs
// @ fd6b129，M19 写入，M21/M23 记录归 M26 前保持 RED）——M24 门禁要求
// tests/unit/agentic/integration/** 全绿，本模块即该 RED 的 GREEN 实现；
// M26 仍保留其端到端门禁（npm run build:web、真实候选、17711-17719 健康检查、
// 不部署），本模块只是离线校验器。
//
// verifyReleaseCandidate(directory) 契约（与 RED 规格一一对应）：
//   重读候选目录的 manifest.json，逐文件复算 SHA-256，返回
//   { ok, checked, mismatches[], hasServerEntry, agenticAssets }：
//   - ok：全部清单条目复算相等（清单可读为前提；不可读直接抛错——校验器
//     不虚构「通过」）；
//   - checked：实际复算的清单条目数；
//   - mismatches：指名不一致/缺席的相对路径（清单在而磁盘缺 = 不一致，不崩溃）；
//   - hasServerEntry：scripts/serve-tango.mjs 在清单中，且候选自带
//     package.json 的 scripts.start 仍指向它（候选服务行为可复核的前提）；
//   - agenticAssets：清单内 web/agentic/** 条目（W13 接缝资产计数——
//     pre-W13 候选应为空数组而非报错，历史候选照常可回读）。
//
// 红线（红线 4 自守）：只读候选目录；无 Date/Date.now/环境变量/fetch/
// 子进程——离线确定性校验，不部署、不触网、不读 key。

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SERVER_ENTRY = 'scripts/serve-tango.mjs';
const SERVER_START = 'node scripts/serve-tango.mjs';
const AGENTIC_PREFIX = 'web/agentic/';

export async function verifyReleaseCandidate(directory) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  const mismatches = [];
  let checked = 0;
  for (const [path, expectedSha] of Object.entries(manifest.files)) {
    checked += 1;
    let bytes;
    try {
      bytes = await readFile(join(directory, path));
    } catch {
      mismatches.push(path); // 清单在而文件缺/不可读 → 指名不一致
      continue;
    }
    if (createHash('sha256').update(bytes).digest('hex') !== expectedSha) mismatches.push(path);
  }
  return {
    ok: mismatches.length === 0,
    checked,
    mismatches,
    hasServerEntry: await serverEntryUsable(directory, manifest),
    agenticAssets: Object.keys(manifest.files).filter(path => path.startsWith(AGENTIC_PREFIX)),
  };
}

/** 服务入口可复核：server 文件在清单 + 候选自带启动脚本仍指向它。 */
async function serverEntryUsable(directory, manifest) {
  if (!(SERVER_ENTRY in manifest.files)) return false;
  let start;
  try {
    start = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).scripts.start;
  } catch {
    return false; // package.json 缺席 / 损坏 / 无 scripts.start 一律不可复核
  }
  return start === SERVER_START;
}
