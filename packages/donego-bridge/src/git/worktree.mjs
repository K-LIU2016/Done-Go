// M5：每个 Mission 使用独立的 git worktree，并把所有文件操作限制在工作树内。
// 依据：PRD §6.5（每任务一工作树）、§6.5.1；.s2d/plan.md §2 M5。
// 本模块只依赖 Node 标准库；git 参数通过 execFileSync 传递，避免 shell 拼接。
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  realpathSync,
  lstatSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const BRANCH_PREFIX = 'feat/donego-';
const WORKTREE_DIR = '.donego/worktrees';

function git(repoRoot, args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if (allowFailure) return '';
    const detail = error?.stderr?.toString().trim();
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`, { cause: error });
  }
}

function assertRepoRoot(repoRoot) {
  if (!isAbsolute(repoRoot)) throw new TypeError('repoRoot must be an absolute path');
  const root = resolve(repoRoot);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    throw new Error(`repoRoot is not a directory: ${root}`);
  }
  // rev-parse also rejects a plain directory which is not a git repository.
  git(root, ['rev-parse', '--show-toplevel']);
  return root;
}

function assertMissionId(missionId) {
  if (typeof missionId !== 'string' || !missionId || missionId === '.' || missionId === '..') {
    throw new TypeError('missionId must be a non-empty string');
  }
  // The id is used in both a branch name and a path component. Keep the namespace
  // deliberately narrow so neither input can escape the worktree directory.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(missionId)) {
    throw new TypeError('missionId contains unsupported characters');
  }
}

function parseWorktrees(repoRoot) {
  const text = git(repoRoot, ['worktree', 'list', '--porcelain']);
  const records = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) records.push(current);
      current = { path: line.slice('worktree '.length), branch: null, head: null };
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (current && line.startsWith('branch ')) {
      const ref = line.slice('branch '.length);
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    }
  }
  if (current) records.push(current);
  return records;
}

function branchFor(missionId) {
  return `${BRANCH_PREFIX}${missionId}`;
}

function worktreeFor(repoRoot, missionId) {
  return resolve(repoRoot, WORKTREE_DIR, missionId);
}

function findMission(repoRoot, missionId) {
  const branch = branchFor(missionId);
  return parseWorktrees(repoRoot).find((item) => item.branch === branch) ?? null;
}

function branchExists(repoRoot, branch) {
  return spawnSync('git', ['-C', repoRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
    stdio: 'ignore',
  }).status === 0;
}

/**
 * Return whether p resolves to a location inside root (including root itself).
 * realpathSync is applied to the nearest existing ancestor, so a not-yet-created
 * child below a symlink is fenced as well.
 */
export function containedIn(root, p) {
  if (typeof root !== 'string' || typeof p !== 'string') return false;
  try {
    const rootPath = resolve(root);
    const candidate = resolve(p);
    const rootReal = realpathSync(rootPath);
    // Resolve the candidate itself when it exists (including symlinks). For a
    // future child, resolve its nearest existing ancestor and append only the
    // non-existent suffix.
    let existing = candidate;
    const suffix = [];
    while (!existsSync(existing)) {
      const parent = dirname(existing);
      if (parent === existing) return false;
      suffix.unshift(basename(existing));
      existing = parent;
    }
    const candidateReal = resolve(realpathSync(existing), ...suffix);
    const rel = relative(rootReal, candidateReal);
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
  } catch {
    return false;
  }
}

/** Create or reuse the worktree for one Mission. */
export function createMissionWorktree(repoRoot, missionId, options = {}) {
  const root = assertRepoRoot(repoRoot);
  assertMissionId(missionId);
  const branch = branchFor(missionId);
  const target = worktreeFor(root, missionId);

  if (!containedIn(root, target)) throw new Error('worktree path escapes repository root');

  const registered = findMission(root, missionId);
  if (registered) {
    // Git may canonicalize macOS /var paths to /private/var; return the
    // deterministic path this API computes so repeated calls are stable.
    return { missionId, path: target, branch };
  }

  const base = options.base ?? git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true });
  if (!base) throw new Error('base must be supplied when repository HEAD is detached');
  git(root, ['rev-parse', '--verify', `${base}^{commit}`]);
  mkdirSync(dirname(target), { recursive: true });

  if (existsSync(target)) {
    throw new Error(`worktree target already exists: ${target}`);
  }

  if (branchExists(root, branch)) {
    // A branch left by a prior cleanup is intentionally reusable, but never
    // silently reset: its commits are the Mission's recoverable work.
    git(root, ['worktree', 'add', target, branch]);
  } else {
    git(root, ['worktree', 'add', '-b', branch, target, base]);
  }
  return { missionId, path: target, branch };
}

/** Remove a Mission worktree; retain an unmerged branch for recovery. */
export function cleanupMissionWorktree(repoRoot, missionId, options = {}) {
  const root = assertRepoRoot(repoRoot);
  assertMissionId(missionId);
  const branch = branchFor(missionId);
  const record = findMission(root, missionId);
  const path = record?.path ? resolve(record.path) : worktreeFor(root, missionId);
  const force = options.force === true;

  if (record) {
    git(root, ['worktree', 'remove', ...(force ? ['--force'] : []), path]);
  } else if (existsSync(path)) {
    throw new Error(`unregistered worktree target exists: ${path}`);
  }
  git(root, ['worktree', 'prune']);

  let branchDeleted = false;
  if (git(root, ['branch', '--merged', 'HEAD']).split('\n').some((line) => line.trim().replace(/^\*\s+/, '') === branch)) {
    git(root, ['branch', '-d', branch], { allowFailure: true });
    branchDeleted = !branchExists(root, branch);
  }
  return { missionId, path, branch, removed: Boolean(record), branchDeleted };
}

/** List registered Mission worktrees, excluding the repository's primary tree. */
export function listMissions(repoRoot) {
  const root = assertRepoRoot(repoRoot);
  return parseWorktrees(root)
    .filter((item) => item.branch?.startsWith(BRANCH_PREFIX))
    .map((item) => ({
      missionId: item.branch.slice(BRANCH_PREFIX.length),
      path: resolve(item.path),
      branch: item.branch,
    }));
}
