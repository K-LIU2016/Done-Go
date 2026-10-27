/**
 * W10 stale-cache identification.
 *
 * Freshness is decided by *content identity*, not by age. A day-old entry whose
 * key recomputes to the same value is still the same content; an entry whose
 * contract, block revision, model, effort or inputs moved is stale even if it
 * was written a second ago. Age alone can only ever downgrade a match to
 * `EXPIRED_BUT_MATCHING`, which is recorded but is not stale.
 *
 * A cache summary is never success evidence on its own: `mock`/`unknown`
 * sources are unverifiable (N8) and stale entries are excluded from the
 * verified set (N7).
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from '../contracts.mjs';
import { observabilityError, MODEL_SOURCES, VERIFIABLE_MODEL_SOURCES, OBS_ERROR_CODES } from './vocabulary.mjs';

export const FRESHNESS = Object.freeze({
  FRESH: 'FRESH',
  STALE: 'STALE',
  EXPIRED_BUT_MATCHING: 'EXPIRED_BUT_MATCHING',
  UNVERIFIABLE: 'UNVERIFIABLE',
});

/** Fields that together define a cache entry's content identity. */
export const CACHE_KEY_FIELDS = Object.freeze([
  'kind',
  'contractHash',
  'blockRevision',
  'model',
  'effort',
  'inputsHash',
]);

function isKnown(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * `sha256(canonicalJson({kind, contractHash, blockRevision, model, effort, inputsHash}))`.
 *
 * Every field is required: a missing field would silently widen the key space
 * and let two different computations collide (plan §2.3).
 */
export function cacheKey(inputs) {
  if (inputs === null || typeof inputs !== 'object' || Array.isArray(inputs)) {
    throw observabilityError(OBS_ERROR_CODES.CACHE_KEY_INCOMPLETE, 'cache inputs must be an object');
  }
  const missing = CACHE_KEY_FIELDS.filter((field) => !isKnown(inputs[field]));
  if (missing.length > 0) {
    throw observabilityError(
      OBS_ERROR_CODES.CACHE_KEY_INCOMPLETE,
      `cache key is missing ${missing.join(', ')}`,
      { missing },
    );
  }
  const payload = Object.fromEntries(CACHE_KEY_FIELDS.map((field) => [field, inputs[field]]));
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

function identityReasons(entry, current) {
  const reasons = [];
  if (entry.key !== cacheKey(current)) reasons.push('key');
  for (const field of CACHE_KEY_FIELDS) {
    if (entry[field] !== current[field]) {
      reasons.push(field);
    }
  }
  return reasons;
}

function modelSourceVerifiable(entry) {
  if (!MODEL_SOURCES.includes(entry.modelSource)) return false;
  return VERIFIABLE_MODEL_SOURCES.includes(entry.modelSource);
}

/**
 * Judge one stored entry against the identity a caller is about to reuse.
 *
 * Returns `{ freshness, stale, expired, verifiable, reasons }`. Precedence is
 * unverifiable source → content drift → unknown age → age only, so the weakest
 * claim that the facts support always wins.
 */
export function assessCacheEntry(entry, current, { now, ttlMs } = {}) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw observabilityError(OBS_ERROR_CODES.CACHE_UNVERIFIABLE, 'cache entry must be an object');
  }

  if (!modelSourceVerifiable(entry)) {
    const reasons = ['modelSource'];
    if (entry.key !== cacheKey(current)) reasons.push(...identityReasons(entry, current));
    return {
      freshness: FRESHNESS.UNVERIFIABLE,
      stale: null,
      expired: null,
      verifiable: false,
      reasons,
    };
  }

  const reasons = identityReasons(entry, current);
  if (reasons.length > 0) {
    return { freshness: FRESHNESS.STALE, stale: true, expired: null, verifiable: false, reasons };
  }

  if (now === undefined && ttlMs === undefined) {
    return { freshness: FRESHNESS.FRESH, stale: false, expired: false, verifiable: true, reasons: [] };
  }

  const createdMs = typeof entry.createdAt === 'string' ? Date.parse(entry.createdAt) : NaN;
  const nowMs = typeof now === 'string' ? Date.parse(now) : NaN;
  if (!Number.isFinite(createdMs) || !Number.isFinite(nowMs)) {
    return {
      freshness: FRESHNESS.UNVERIFIABLE,
      stale: null,
      expired: null,
      verifiable: false,
      reasons: ['createdAt'],
    };
  }

  const ageMs = nowMs - createdMs;
  const ttl = typeof ttlMs === 'number' && Number.isFinite(ttlMs) ? ttlMs : null;
  if (ttl !== null && ageMs > ttl) {
    // Same content, older than the TTL: recorded, verifiable, but not stale.
    return { freshness: FRESHNESS.EXPIRED_BUT_MATCHING, stale: false, expired: true, verifiable: true, reasons: [] };
  }
  return { freshness: FRESHNESS.FRESH, stale: false, expired: false, verifiable: true, reasons: [] };
}

/**
 * Split entries into mutually exclusive buckets. Every input lands in exactly
 * one bucket; `verified` contains only entries that are both verifiable and not
 * stale, so a stale or mock summary can never be counted as evidence.
 *
 * Each bucketed entry carries the verdict it was sorted by (`freshness`,
 * `reasons`), because a downstream report has to say *why* an entry was
 * rejected. Dropping the reasons here would leave `CACHE_STALE: []` — a claim
 * with nothing behind it.
 */
export function partitionCacheEntries(entries, current, options = {}) {
  const partition = { verified: [], stale: [], unverifiable: [] };
  for (const entry of Array.isArray(entries) ? entries : []) {
    const verdict = assessCacheEntry(entry, current, options);
    const annotated = { ...entry, freshness: verdict.freshness, reasons: verdict.reasons };
    if (!verdict.verifiable) {
      if (verdict.stale === true) partition.stale.push(annotated);
      else partition.unverifiable.push(annotated);
    } else {
      partition.verified.push(annotated);
    }
  }
  return partition;
}

/** Re-key an entry to the identity it is being recomputed for. */
export function refreshCacheEntry(entry, current, { now } = {}) {
  const key = cacheKey(current);
  return {
    ...entry,
    ...Object.fromEntries(CACHE_KEY_FIELDS.map((field) => [field, current[field]])),
    key,
    createdAt: now ?? new Date().toISOString(),
    updatedAt: now ?? new Date().toISOString(),
    stale: false,
    freshness: FRESHNESS.FRESH,
    reasons: [],
  };
}
