// W8 G6 安全回归：验证配对码、审批命令、路径围栏和 WSS 凭据不出现高危绕过。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { createPairingService } from '../../../../scripts/agentic/bridge-hub/pairing.mjs';
import { decideApproval } from '../../../../packages/donego-bridge/src/policy/approvals.mjs';
import { createBridgeClient } from '../../../../packages/donego-bridge/src/client/wss.mjs';

function pairingDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE bridge_pairings (
    code_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
  );`);
  return db;
}

const command = value => ({
  method: 'item/commandExecution/requestApproval',
  params: { command: value, cwd: '/wt/m1' },
});

class CaptureSocket extends EventEmitter {
  static last;
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = 1;
    CaptureSocket.last = this;
  }
  ping() {}
  close() { this.readyState = 3; this.emit('close', 1000); }
}

test('配对码：owner 不匹配时不得消耗一次性凭据', () => {
  const service = createPairingService({ db: pairingDb(), now: () => 1000, randomCode: () => 'PAIR123' });
  const { code } = service.issuePairingCode('owner-a');
  assert.deepEqual(service.consumePairingCode(code, 'owner-b'), { ok: false, code: 'OWNER_MISMATCH' });
  assert.deepEqual(service.consumePairingCode(code, 'owner-a'), { ok: true, ownerId: 'owner-a' });
});

test('审批黑名单：分离 rm 选项和 git -C config 变体仍然直接拒绝', () => {
  const contract = { worktreeRoot: '/wt/m1', deliverables: ['src/**'] };
  for (const value of ['rm -r -f /wt/m1', 'rm --preserve-root --recursive /wt/m1', 'git -C /wt/m1 config user.name attacker']) {
    assert.equal(decideApproval(command(value), contract).decision, 'reject', value);
  }
});

test('审批路径围栏：worktree 内 symlink 指向外部时升级 Need', () => {
  const root = mkdtempSync(join(tmpdir(), 'donego-g6-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'donego-g6-out-'));
  try {
    mkdirSync(join(root, 'src'));
    symlinkSync(outside, join(root, 'src', 'linked'));
    const result = decideApproval({
      method: 'item/fileChange/requestApproval',
      params: { path: 'src/linked/secret.txt' },
    }, { worktreeRoot: root, deliverables: ['src/**'] });
    assert.equal(result.decision, 'need');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('出站 WSS：设备令牌只放 Authorization，不进入可被访问日志记录的 URL', () => {
  const client = createBridgeClient({
    url: 'wss://hub.example/api/bridge',
    token: 'secret-device-token',
    WebSocket: CaptureSocket,
    heartbeatMs: 60_000,
  });
  client.connect();
  assert.equal(CaptureSocket.last.url.includes('secret-device-token'), false);
  assert.equal(CaptureSocket.last.options.headers.authorization, 'Bearer secret-device-token');
  client.stop();
});
