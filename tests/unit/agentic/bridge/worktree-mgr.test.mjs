// M5 worktree-mgr 单测（TDD RED 先行）。
// 契约来源：PRD §6.5 L403（每任务一个 git worktree + feat/donego-<mission> 分支）、L441（沙箱只允许写 worktree）、
// .s2d/plan.md §2 M5（分支复用策略明确、清理保留未合入分支、路径围栏防 .. / symlink 逃逸）。
// 测试只用 mktemp -d 一次性 git 仓库，绝不触真实项目目录（§2.3 红线）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import {
  createMissionWorktree, cleanupMissionWorktree, listMissions, containedIn,
} from '../../../../packages/donego-bridge/src/git/worktree.mjs';

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'donego-wt-'));
  execFileSync('git', ['-C', repo, 'init', '-b', 'main'], { stdio: 'ignore' });
  git(repo, 'config', 'user.email', 't@t'); // 测试一次性仓库内的本地配置（与"改用户 git 配置"黑名单无关）
  git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), '# x\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'init');
  return repo;
}

test('createMissionWorktree：建 feat/donego-<missionId> 分支 worktree；同 mission 重复调用走复用不报错', () => {
  const repo = makeRepo();
  try {
    const first = createMissionWorktree(repo, 'm1');
    assert.ok(isAbsolute(first.path) && existsSync(first.path));
    assert.equal(first.branch, 'feat/donego-m1');
    const wtList = git(repo, 'worktree', 'list');
    assert.ok(wtList.includes(first.path), 'git worktree list 应包含新工作树');
    assert.ok(git(repo, 'branch', '--list', 'feat/donego-m1').includes('feat/donego-m1'));

    const second = createMissionWorktree(repo, 'm1');
    assert.equal(second.path, first.path, '同 missionId 复用已有 worktree');
    assert.equal(git(repo, 'worktree', 'list').split('\n').length, 2, '不重复创建');
  } finally {
    try { execFileSync('git', ['-C', repo, 'worktree', 'prune'], { stdio: 'ignore' }); } catch {}
    rmSync(repo, { recursive: true, force: true });
  }
});

test('createMissionWorktree 支持指定 base 分支', () => {
  const repo = makeRepo();
  try {
    git(repo, 'checkout', '-b', 'feat/base-x');
    writeFileSync(join(repo, 'b.txt'), 'b\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'b');
    git(repo, 'checkout', 'main');
    const wt = createMissionWorktree(repo, 'm2', { base: 'feat/base-x' });
    assert.ok(existsSync(join(wt.path, 'b.txt')), '从 base 建出的 worktree 含 base 的提交');
  } finally {
    try { git(repo, 'worktree', 'prune'); } catch {}
    rmSync(repo, { recursive: true, force: true });
  }
});

test('cleanup：分支未合入 → 只删 worktree、保留分支（防丢工作）；合入后 → worktree+分支都清理', () => {
  const repo = makeRepo();
  try {
    const wt = createMissionWorktree(repo, 'm3');
    writeFileSync(join(wt.path, 'src.txt'), 'x\n');
    git(wt.path, 'add', '.'); git(wt.path, 'commit', '-m', 'wip');

    const kept = cleanupMissionWorktree(repo, 'm3');
    assert.equal(kept.removed, true);
    assert.equal(kept.branchDeleted, false, '未合入 main 的分支必须保留');
    assert.ok(!existsSync(wt.path), 'worktree 目录已移除');
    assert.ok(git(repo, 'branch', '--list', 'feat/donego-m3'), '分支仍在');

    // 合入后重建再清理：分支一并删除
    git(repo, 'merge', 'feat/donego-m3', '-m', 'merge');
    const again = createMissionWorktree(repo, 'm3');
    const done = cleanupMissionWorktree(repo, 'm3');
    assert.equal(done.branchDeleted, true);
    assert.equal(git(repo, 'branch', '--list', 'feat/donego-m3'), '', '合入后的分支被清理');
    void again;
  } finally {
    try { git(repo, 'worktree', 'prune'); } catch {}
    rmSync(repo, { recursive: true, force: true });
  }
});

test('listMissions：列出 missionId/path/branch', () => {
  const repo = makeRepo();
  try {
    createMissionWorktree(repo, 'm4');
    createMissionWorktree(repo, 'm5');
    const list = listMissions(repo);
    const ids = list.map(m => m.missionId).sort();
    assert.deepEqual(ids, ['m4', 'm5']);
    const m4 = list.find(m => m.missionId === 'm4');
    assert.equal(m4.branch, 'feat/donego-m4');
    assert.ok(existsSync(m4.path));
  } finally {
    try { git(repo, 'worktree', 'prune'); } catch {}
    rmSync(repo, { recursive: true, force: true });
  }
});

test('containedIn 路径围栏：内部真、外部假、.. 逃逸假', () => {
  const root = mkdtempSync(join(tmpdir(), 'donego-fence-'));
  try {
    assert.equal(containedIn(root, join(root, 'src/a.mjs')), true);
    assert.equal(containedIn(root, root), true);
    assert.equal(containedIn(root, join(root, '..', 'outside.mjs')), false);
    assert.equal(containedIn(root, '/etc/hosts'), false);
    assert.equal(containedIn(root, join(root, 'src', '..', '..', 'x')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('containedIn 防 symlink 逃逸：root 内符号链接指向外部 → false（安全评审点）', () => {
  const root = mkdtempSync(join(tmpdir(), 'donego-fence-'));
  const outside = mkdtempSync(join(tmpdir(), 'donego-out-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    symlinkSync(outside, join(root, 'src', 'link-out'));
    assert.equal(containedIn(root, join(root, 'src', 'link-out')), false, '指向外部的 symlink 不算围栏内');
    assert.equal(containedIn(root, join(root, 'src', 'link-out', 'secret.txt')), false);
    // 指向内部的符号链接仍算内部
    writeFileSync(join(root, 'real.txt'), 'x');
    symlinkSync(join(root, 'real.txt'), join(root, 'src', 'link-in'));
    assert.equal(containedIn(root, join(root, 'src', 'link-in')), true);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
