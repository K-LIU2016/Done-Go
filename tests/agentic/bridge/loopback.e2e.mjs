// W8 M9 opt-in e2e 壳：默认不接入 unit suite，避免 CI 误占端口。
// 需要真实 hub/CLI 子进程时显式设置 DONEGO_S2D_E2E=1；端口由环回夹具限定为 17631–17639。
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const enabled = process.env.DONEGO_S2D_E2E === '1';
const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

test('W8 loopback e2e（opt-in）', { skip: !enabled }, async () => {
  const result = await runNode(['--test', 'tests/unit/agentic/bridge/hub-loopback.test.mjs']);
  if (result.code !== 0) throw new Error(`loopback e2e failed: ${result.signal || result.code}`);
});
