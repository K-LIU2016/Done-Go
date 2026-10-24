import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const { rollbackCommitCheck, parseArgs } = await import('../../scripts/release-preflight.mjs');

async function git(repository, args) {
  const { stdout } = await execFile('git', args, { cwd: repository });
  return stdout.trim();
}

async function createFixture() {
  const repository = await mkdtemp(join(tmpdir(), 'donego-rollback-fixture-'));
  await git(repository, ['init', '--quiet', '--initial-branch=main']);
  await git(repository, ['config', 'user.name', 'Rollback Fixture']);
  await git(repository, ['config', 'user.email', 'rollback-fixture@invalid']);
  await git(repository, ['commit', '--quiet', '--allow-empty', '-m', 'anchor release']);
  const anchor = await git(repository, ['rev-parse', 'HEAD']);
  await git(repository, ['branch', 'rollback/prod-fixture']);
  await git(repository, ['commit', '--quiet', '--allow-empty', '-m', 'candidate release']);
  const head = await git(repository, ['rev-parse', 'HEAD']);
  return { repository, anchor, head };
}

test('a resolvable rollback target reports identity, existence, refs, and release line', async () => {
  const { repository, anchor, head } = await createFixture();
  try {
    const check = await rollbackCommitCheck({ repository, target: anchor, anchor });
    assert.equal(check.status, 'VERIFIED');
    assert.equal(check.details.repository, repository);
    assert.equal(check.details.input, anchor);
    assert.equal(check.details.resolves, true);
    assert.equal(check.details.objectType, 'commit');
    assert.equal(check.details.targetSha, anchor);
    assert.equal(check.details.subject, 'anchor release');
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(check.details.commitDate), 'commitDate should be ISO-like');
    assert.ok(check.details.refsPointingAtTarget.includes('refs/heads/rollback/prod-fixture'));
    assert.equal(check.details.headSha, head);
    assert.equal(check.details.onReleaseLine, true);
    assert.equal(check.details.anchor.input, anchor);
    assert.equal(check.details.anchor.resolves, true);
    assert.equal(check.details.anchor.anchorSha, anchor);
    assert.equal(check.details.anchor.matchesTarget, true);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('a rollback target given as the recorded anchor ref must match the anchor commit', async () => {
  const { repository, anchor } = await createFixture();
  try {
    const check = await rollbackCommitCheck({ repository, target: 'rollback/prod-fixture', anchor });
    assert.equal(check.status, 'VERIFIED');
    assert.equal(check.details.targetSha, anchor);
    assert.equal(check.details.anchor.matchesTarget, true);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('a rollback target that does not exist in the repository fails existence', async () => {
  const { repository } = await createFixture();
  try {
    const absent = '7'.repeat(40);
    const check = await rollbackCommitCheck({ repository, target: absent });
    assert.equal(check.status, 'FAIL');
    assert.equal(check.details.resolves, false);
    assert.equal(check.details.targetSha, null);
    assert.equal(check.details.refsPointingAtTarget.length, 0);
    assert.equal(check.details.onReleaseLine, null);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('a rollback target that resolves to a different commit than the anchor fails consistency', async () => {
  const { repository, anchor, head } = await createFixture();
  try {
    const check = await rollbackCommitCheck({ repository, target: head, anchor });
    assert.equal(check.status, 'FAIL');
    assert.equal(check.details.resolves, true);
    assert.equal(check.details.targetSha, head);
    assert.equal(check.details.anchor.resolves, true);
    assert.equal(check.details.anchor.anchorSha, anchor);
    assert.equal(check.details.anchor.matchesTarget, false);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('a configured anchor that does not resolve fails instead of guessing', async () => {
  const { repository, anchor } = await createFixture();
  try {
    const check = await rollbackCommitCheck({ repository, target: anchor, anchor: 'f'.repeat(40) });
    assert.equal(check.status, 'FAIL');
    assert.equal(check.details.resolves, true);
    assert.equal(check.details.anchor.resolves, false);
    assert.equal(check.details.anchor.anchorSha, null);
    assert.equal(check.details.anchor.matchesTarget, false);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('rollback commit checks stay UNKNOWN when no target is configured', async () => {
  const { repository } = await createFixture();
  try {
    const check = await rollbackCommitCheck({ repository });
    assert.equal(check.status, 'UNKNOWN');
    assert.equal(check.details.input, null);
    assert.equal(check.details.resolves, false);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('preflight argument parsing accepts rollback value options and rejects malformed input', async () => {
  const parsed = parseArgs(['--health', '--rollback-target', 'abc123', '--rollback-anchor', 'def456', '--rollback-repo', '/tmp/inspect']);
  assert.equal(parsed.help, false);
  assert.equal(parsed.flags.has('health'), true);
  assert.equal(parsed.values.rollbackTarget, 'abc123');
  assert.equal(parsed.values.rollbackAnchor, 'def456');
  assert.equal(parsed.values.rollbackRepo, '/tmp/inspect');
  const plain = parseArgs([]);
  assert.equal(plain.help, false);
  assert.deepEqual(plain.values, {});
  assert.throws(() => parseArgs(['--rollback-target']));
  assert.throws(() => parseArgs(['--rollback-target', '--health']));
  assert.throws(() => parseArgs(['--rollback-anchor']));
  assert.throws(() => parseArgs(['--rollback-repo']));
  assert.throws(() => parseArgs(['--unknown-option']));
});
