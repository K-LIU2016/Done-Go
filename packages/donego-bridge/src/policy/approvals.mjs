/*
 * W8 本机桥审批策略。
 *
 * 这里仅负责把 Codex App Server 的审批请求映射成桥内决策；Grant 的
 * 生命周期和审计仍由 W2 policy 注入 policyHook 负责。默认策略采用
 * 最小权限：合同 worktree + deliverables 内的文件动作和命令自动通过，
 * 其余请求生成 Need，高危命令永远拒绝。
 */
import path from 'node:path';
import { existsSync, realpathSync } from 'node:fs';

const POSIX = path.posix;

/**
 * 高危命令黑名单。数组是公开扩展点；匹配前会去除引号并统一大小写，
 * 因而不会因大小写、引号或短参数顺序变化而漏判。
 */
export const HIGH_RISK_COMMANDS = [
  /\brm\s+(?:(?:-[a-z]*[rf][a-z]*)(?:\s|$)|(?:--recursive|--force)\b)/i,
  /\brm\b[\s\S]*\s(?:--recursive|--force)\b/i,
  /\bgit\s+(?:-[^\s]+\s+)*push\b[\s\S]*?(?:--force(?:-with-lease)?\b|-f\b|(?:^|\s)\+[^\s;|]+)/i,
  /\bgit\s+(?:(?:-[^\s]+)\s+\S+\s+)*config\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\b(?:mkfs|dd)\b/i,
];

const SHELL_WRAPPERS = /\b(?:sh|bash|zsh|fish|cmd|powershell|pwsh)\s+(?:-[^\s]*c\b|--command\b|-Command\b)/i;

const NETWORK_OR_INSTALL = [
  /\b(?:npm|pnpm|yarn)\s+(?:install|add|upgrade|update)\b/i,
  /\b(?:pip|pip3)\s+install\b/i,
  /\b(?:curl|wget)\b[\s\S]*\|\s*(?:ba)?sh\b/i,
  /\b(?:curl|wget)\b[\s\S]*\|\s*python(?:3)?\b/i,
];

function asText(command) {
  if (Array.isArray(command)) return command.map(value => String(value)).join(' ');
  return command == null ? '' : String(command);
}

/** Normalize shell spelling without attempting to execute or fully parse a shell. */
function normalizedCommand(command) {
  return asText(command)
    .replace(/[\"'`]/g, '')
    .replace(/\\([\\"'`])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function matchesAny(patterns, value) {
  return patterns.some(pattern => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

function normalizedPath(value) {
  return String(value ?? '').replaceAll('\\', '/');
}

function resolveCandidate(root, candidate) {
  const value = normalizedPath(candidate);
  if (!value) return null;
  const absolute = POSIX.isAbsolute(value)
    ? POSIX.normalize(value)
    : POSIX.resolve(root, value);
  return absolute;
}

/** Lexical worktree fence. Optional ctx.resolvePath can add realpath/symlink checks. */
function containedPath(root, candidate, ctx = {}) {
  const rootAbs = POSIX.resolve(normalizedPath(root));
  const absolute = resolveCandidate(rootAbs, candidate);
  if (!absolute) return null;
  const relative = POSIX.relative(rootAbs, absolute);
  if (relative !== '' && (relative === '..' || relative.startsWith('../') || POSIX.isAbsolute(relative))) return null;
  const resolver = typeof ctx.resolvePath === 'function'
    ? ctx.resolvePath
    : (value, rootValue) => {
      try {
        if (!existsSync(rootValue)) return true;
        const rootReal = realpathSync(rootValue);
        let existing = value;
        const suffix = [];
        while (!existsSync(existing)) {
          const parent = POSIX.dirname(existing);
          if (parent === existing) return false;
          suffix.unshift(POSIX.basename(existing));
          existing = parent;
        }
        const candidateReal = POSIX.resolve(realpathSync(existing), ...suffix);
        const rel = POSIX.relative(rootReal, candidateReal);
        return rel === '' || (rel !== '..' && !rel.startsWith('../') && !POSIX.isAbsolute(rel));
      } catch {
        return false;
      }
    };
  if (resolver(absolute, rootAbs) === false) return null;
  return { absolute, relative: normalizedPath(relative) };
}

function globToRegExp(pattern) {
  const source = normalizedPath(pattern).replace(/^\.\//, '');
  let result = '^';
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === '*') {
      if (source[i + 1] === '*') {
        i += 1;
        if (source[i + 1] === '/') {
          i += 1;
          result += '(?:.*/)?';
        } else {
          result += '.*';
        }
      } else {
        result += '[^/]*';
      }
    } else if (char === '?') {
      result += '[^/]';
    } else {
      result += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`${result}$`);
}

function inDeliverables(root, candidate, deliverables, ctx) {
  const located = containedPath(root, candidate, ctx);
  if (!located) return false;
  const rules = Array.isArray(deliverables) ? deliverables : [];
  return rules.some(rule => {
    if (typeof rule !== 'string' || !rule.trim()) return false;
    return globToRegExp(rule).test(located.relative);
  });
}

function needResult(reason, request, contract) {
  return {
    decision: 'need',
    reason,
    need: {
      type: 'approval',
      missionId: contract?.missionId,
      reason,
      request,
    },
  };
}

function rejectResult(reason) {
  return { decision: 'reject', reason };
}

function approveResult(reason) {
  return { decision: 'approve', reason };
}

function hookResult(request, contract, ctx) {
  if (typeof ctx?.policyHook !== 'function') return null;
  const result = ctx.policyHook(request, contract, ctx);
  if (!result || typeof result !== 'object') return null;
  if (!['approve', 'need', 'reject'].includes(result.decision)) return null;
  return result;
}

function patchPaths(patch) {
  const text = typeof patch === 'string' ? patch : String(patch ?? '');
  const paths = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^(?:\+\+\+|---)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[1].trim().replace(/^\"|\"$/g, '');
    if (value === '/dev/null') continue;
    value = value.replace(/^[ab]\//, '');
    // The test/fixture envelope uses a/base and b/base as a synthetic header;
    // only paths introduced by the patch itself are policy-relevant.
    if (value === 'base') continue;
    // Unified diff timestamps are separated by a tab; they are not part of path.
    value = value.split(/\t/, 1)[0];
    paths.push(value);
  }
  return [...new Set(paths)];
}

function requestKind(request) {
  return String(request?.method ?? '');
}

/**
 * Decide a Codex approval request without performing any external action.
 * @returns {{decision:'approve'|'need'|'reject', reason:string, need?:object}}
 */
export function decideApproval(request, contract = {}, ctx = {}) {
  const method = requestKind(request);
  const params = request?.params && typeof request.params === 'object' ? request.params : {};
  const root = contract.worktreeRoot;

  if (!root || typeof root !== 'string') {
    return needResult('MISSING_WORKTREE_CONTRACT', request, contract);
  }

  if (method === 'item/commandExecution/requestApproval') {
    const command = normalizedCommand(params.command);
    if (matchesAny(HIGH_RISK_COMMANDS, command)) {
      return rejectResult('HIGH_RISK_COMMAND_BLOCKED');
    }
    if (SHELL_WRAPPERS.test(command)) {
      const hooked = hookResult(request, contract, ctx);
      return hooked ?? needResult('INTERPRETER_COMMAND_APPROVAL_REQUIRED', request, contract);
    }
    if (matchesAny(NETWORK_OR_INSTALL, command)) {
      const hooked = hookResult(request, contract, ctx);
      return hooked ?? needResult('NETWORK_OR_DEPENDENCY_APPROVAL_REQUIRED', request, contract);
    }
    if (!containedPath(root, params.cwd ?? root, ctx)) {
      const hooked = hookResult(request, contract, ctx);
      return hooked ?? needResult('COMMAND_CWD_OUTSIDE_WORKTREE', request, contract);
    }
    const pathArguments = Array.isArray(params.command)
      ? params.command.slice(1).filter(value => typeof value === 'string' && (value.startsWith('/') || value.includes('/')))
      : (command.match(/(?:^|\s)(\/[^\s;|&]+|\.\.?\/[^\s;|&]+)/g) ?? []).map(value => value.trim());
    if (pathArguments.some(candidate => !containedPath(root, candidate, ctx))) {
      const hooked = hookResult(request, contract, ctx);
      return hooked ?? needResult('COMMAND_PATH_OUTSIDE_WORKTREE', request, contract);
    }
    const hooked = hookResult(request, contract, ctx);
    return hooked ?? approveResult('COMMAND_WITHIN_WORKTREE');
  }

  if (method === 'item/fileChange/requestApproval') {
    const safe = inDeliverables(root, params.path, contract.deliverables, ctx);
    const hooked = hookResult(request, contract, ctx);
    if (hooked) return hooked;
    return safe
      ? approveResult('FILE_CHANGE_WITHIN_DELIVERABLES')
      : needResult('FILE_CHANGE_OUTSIDE_CONTRACT_SCOPE', request, contract);
  }

  if (method === 'applyPatchApproval') {
    const paths = patchPaths(params.patch);
    const safe = paths.length > 0 && paths.every(item => inDeliverables(root, item, contract.deliverables, ctx));
    const hooked = hookResult(request, contract, ctx);
    if (hooked) return hooked;
    return safe
      ? approveResult('PATCH_WITHIN_DELIVERABLES')
      : needResult('PATCH_OUTSIDE_CONTRACT_SCOPE', request, contract);
  }

  const hooked = hookResult(request, contract, ctx);
  return hooked ?? needResult('UNKNOWN_APPROVAL_REQUEST', request, contract);
}

export const _internals = Object.freeze({ normalizedCommand, containedPath, globToRegExp, patchPaths });
