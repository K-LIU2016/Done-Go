// W11 composer · export 留桩先行单测（RED 契约）。
// 依据：DAG 组2(3)：exportReel(reel) 留桩——返回 {status:'pending', reason:'P2 HyperFrames MP4'}
// （BUILD-PLAN §3 W11.2：export 接口先留桩，P2 用 HyperFrames 渲染 MP4）。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { exportReel } from '../../../../../scripts/agentic/composer/export.mjs';

test('exportReel is a stub that reports pending P2 HyperFrames MP4 rendering', () => {
  const out = exportReel('<!doctype html><html><body>reel</body></html>');
  assert.deepEqual(out, { status: 'pending', reason: 'P2 HyperFrames MP4' });
});

test('the stub is synchronous, dependency-free and stable across calls', () => {
  const a = exportReel('reel-a');
  const b = exportReel({ html: 'reel-b' });
  assert.deepEqual(a, b, '留桩不读入参内容，任何 reel 都返回同一结构');
  assert.equal(a.mp4, undefined, 'P2 之前绝不假装产出视频文件');
});
