// S2D-W6 module 6: patch-parser (.s2d/plan.md:55) — utterance → MissionPatch
// (PRD §11.3 讨论 → 结构化补丁; examples in PRD §5.2 讨论 paragraph).
//
// Layering (plan §2 外部副作用封锁 / 超时 rows):
// - The DEFAULT kernel is a fixed rule table over the utterance text: pure
//   string matching with zero I/O, zero clock reads and no LLM, so parsing is
//   safe to call in tests without mocks (sync-shape contract). Rules always
//   win over the LLM: a deterministic, auditable match never pays for or
//   depends on an upstream call.
// - An OPTIONAL injectable LLM interface ({ parse: async utterance =>
//   MissionPatch | null }) extends the kernel and is consulted ONLY when no
//   rule matched. Every upstream failure mode — timeout, rejection, and a
//   non-object payload — fails closed with UPSTREAM_UNAVAILABLE so a
//   discussion can never half-apply: the caller (discussion/apply.mjs)
//   treats that as "zero writes" (plan §2: 预演零变更、无半应用补丁).
// - This module extracts intent; it does not authorize. The kernel only
//   ADDS constraints (narrowing sources, wont.add, length). Whether a patch
//   may legally apply — system-wont relaxation, PRD §8.1 defaults — is judged
//   downstream in apply.mjs (FORBIDDEN), never here.
// - MissionPatch field names follow PRD §11.3 (scope/audience/format/length/
//   sources.include|exclude/dod.add|remove/boundary.wont.add/window). The
//   deterministic rules cover the three utterance families evidenced by the
//   PRD/prototype discussion chips; everything else ("幻灯片换成深色") is LLM
//   territory and stays origin=none without an injected iface.
import { MAX_UTTERANCE_LENGTH } from './store.mjs';

/** Default budget for one injected-LLM parse call; callers may override. */
export const DEFAULT_LLM_TIMEOUT_MS = 10_000;

/** Normalized wont label the email-prohibition rule adds (R2). */
const EMAIL_WONT_LABEL = '读取邮箱';

function contractInvalid(detail, path) {
  const error = new Error(`CONTRACT_INVALID: ${detail}`);
  error.code = 'CONTRACT_INVALID';
  error.errors = [{ path, message: detail }];
  return error;
}

function upstreamUnavailable(detail, cause) {
  const error = new Error(`UPSTREAM_UNAVAILABLE: ${detail}`);
  error.code = 'UPSTREAM_UNAVAILABLE';
  if (cause !== undefined) error.cause = cause;
  return error;
}

function describeType(value) {
  return Array.isArray(value) ? 'array' : typeof value;
}

function validateUtterance(utterance) {
  if (typeof utterance !== 'string') {
    throw contractInvalid('utterance must be a string', '$.utterance');
  }
  if (utterance.trim() === '') {
    throw contractInvalid('utterance must contain non-whitespace text', '$.utterance');
  }
  if (utterance.length > MAX_UTTERANCE_LENGTH) {
    throw contractInvalid(`utterance must be at most ${MAX_UTTERANCE_LENGTH} characters`, '$.utterance');
  }
}

/*
 * Rule table. Each rule is pure: (utterance) → MissionPatch fragment | null.
 * All matching rules merge into ONE patch (a single turn may say several
 * things, PRD §5.2 combined example); first match per rule wins.
 */
const RULES = [
  {
    id: 'R1 只看…→ sources.include',
    // "研究只看国内 K12" → { sources: { include: ['国内 K12'] } }. The capture
    // stops at the first clause separator so combined utterances stay scoped;
    // 顿号-separated items become list entries. "不只看到…" must NOT fire
    // (negative lookbehind) — it is not a source narrowing.
    apply(utterance) {
      const match = utterance.match(/(?<!不)只看([^，,。．！!？?；;]+)/);
      if (!match) return null;
      const include = match[1].split('、').map(part => part.trim()).filter(Boolean);
      return include.length === 0 ? null : { sources: { include } };
    },
  },
  {
    id: 'R2 邮箱禁读 → boundary.wont.add',
    // "别读我的邮箱" / "以后不读邮箱了" → wont.add a normalized 读取邮箱 item.
    // Only prohibitions fire: "允许读邮箱" has no 别/不/禁止 marker directly
    // before the verb and must not produce a wont.add patch — loosening
    // requests are not this kernel's business (and removing system-wont
    // items is FORBIDDEN in apply.mjs anyway).
    apply(utterance) {
      const prohibited = /(不要|别再|禁止|别|不)(再)?(?:读|看|查|访问)(?:我的)?邮箱/.test(utterance);
      return prohibited ? { boundary: { wont: { add: [EMAIL_WONT_LABEL] } } } : null;
    },
  },
  {
    id: 'R3 N 课时 → length',
    // "课程是给初中老师的 4 课时工作坊" → { length: { unit: '课时', value: 4 } }.
    // First quantity wins; the unit set covers the PRD's 时长/篇幅 families
    // (课时/小时/分钟/字/页). Digits not followed by a unit ("2026 年") don't fire.
    apply(utterance) {
      const match = utterance.match(/(\d+(?:\.\d+)?)\s*(课时|小时|分钟|字|页)/);
      if (!match) return null;
      return { length: { unit: match[2], value: Number(match[1]) } };
    },
  },
];

/**
 * Call the injected LLM iface under a timeout. The upstream starts inside a
 * promise chain so a synchronous throw in llm.parse also surfaces as a
 * rejection; the swallowed `upstream.catch` keeps a late failure (after the
 * race already decided) from becoming an unhandled rejection.
 */
function callLlm(llm, utterance, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(
      () => reject(upstreamUnavailable(`llm patch parse timeout after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  const upstream = Promise.resolve().then(() => llm.parse(utterance));
  upstream.catch(() => {});
  return Promise.race([upstream, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Parse one discussion utterance into a MissionPatch (PRD §11.3).
 *
 * Resolves with { utterance, patch, origin }:
 * - origin 'rules': the deterministic kernel matched; `patch` is the merged
 *   fragment(s); an injected llm is NOT consulted.
 * - origin 'llm': no rule matched and the injected llm produced the patch —
 *   null means the llm legitimately answered "no patch".
 * - origin 'none': no rule matched and no llm was injected → patch null
 *   (plain chatter: the caller records the turn without a new preview
 *   version).
 *
 * Rejects with CONTRACT_INVALID for input problems (empty/whitespace/
 * oversized utterance, malformed llm iface, non-positive timeoutMs) —
 * checked BEFORE any upstream call — and with UPSTREAM_UNAVAILABLE for every
 * injected-upstream failure (timeout, rejection, non-object payload), cause
 * preserved. It never resolves a fabricated patch.
 */
export async function parsePatch(utterance, options) {
  validateUtterance(utterance);
  const opts = options ?? {};
  const llm = opts.llm ?? null;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  if (llm !== null && (typeof llm !== 'object' || typeof llm.parse !== 'function')) {
    throw contractInvalid(
      'options.llm must be { parse: (utterance) => Promise<MissionPatch | null> }',
      '$.llm',
    );
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw contractInvalid('options.timeoutMs must be a positive number of milliseconds', '$.timeoutMs');
  }

  const patch = {};
  let matched = false;
  for (const rule of RULES) {
    const fragment = rule.apply(utterance);
    if (fragment !== null) {
      matched = true;
      Object.assign(patch, fragment);
    }
  }
  if (matched) return { utterance, patch, origin: 'rules' };

  if (llm === null) return { utterance, patch: null, origin: 'none' };

  let produced;
  try {
    produced = await callLlm(llm, utterance, timeoutMs);
  } catch (error) {
    if (error?.code === 'UPSTREAM_UNAVAILABLE') throw error;
    throw upstreamUnavailable(`llm patch parse failed (${error?.message ?? error})`, error);
  }
  if (produced === null || produced === undefined) {
    return { utterance, patch: null, origin: 'llm' };
  }
  if (typeof produced !== 'object' || Array.isArray(produced)) {
    throw upstreamUnavailable(
      `llm patch parse returned ${describeType(produced)} instead of a MissionPatch object or null`,
    );
  }
  return { utterance, patch: produced, origin: 'llm' };
}
