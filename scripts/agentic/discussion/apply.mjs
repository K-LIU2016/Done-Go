// S2D-W6 module 7: patch-apply (.s2d/plan.md §3 row 7) — the discussion→preview
// write path: a validated MissionPatch becomes the NEXT immutable preview
// version plus the discussion message that caused it (and, for
// contract-relevant patches, a contract_change_records row written in the SAME
// transaction as the message by the discussion store).
//
// Ordering guarantees (tests/unit/agentic/preview/apply.test.mjs is the spec):
//   * Every gate runs BEFORE any store call — CONTRACT_INVALID / FORBIDDEN /
//     NOT_FOUND / CONFLICT / UPSTREAM_UNAVAILABLE all leave zero rows written
//     (no half-applied patch; plan §2 拒绝/超时 negative paths).
//   * Replay wins over staleness: the idempotency key
//     (owner, mission, baseVersion, whitespace-normalized utterance) is looked
//     up FIRST, so a retried turn returns the stored result even after the live
//     version has moved on.
//   * A stale baseVersion (≠ current live version) is CONFLICT — concurrent
//     discussions never silently rebase (plan §2; routes stale-base 409 case).
//   * Write order: preview version first, then the message. The discussion
//     store commits message + change record in one transaction; the version row
//     commits just before it, so the crash window (unreachable in one process,
//     backstopped by put's own baseVersion check across processes) can only
//     leave an audit-safe orphan VERSION — never a message whose afterVersion
//     does not exist.
//
// Patch vocabulary (fail-closed): apply understands exactly
// {sources, length, boundary}; any other MissionPatch field (e.g. dod, format,
// window) is CONTRACT_INVALID — W6 refuses fields it cannot faithfully apply
// rather than silently dropping them.
//
// “讨论不改变合同而无记录” (plan §2): patches that actually change boundary.*
// are contract changes; the change record (full patch + changed field paths)
// lands in the same transaction as the message, via discussion-store's
// contractChange parameter. A boundary patch that changes nothing records the
// talk but no version and no record — no change, nothing to record.
//
// System wont (PRD §8.1) can never be relaxed here: removing a system wont
// item, or willing a system-forbidden action, is FORBIDDEN before any write;
// willing an item that contradicts the owner's explicit current wont is
// FORBIDDEN too (it would undo an explicit restriction through the back door).
//
// No external side effects: no network, no model calls (the parser is injected
// and mocked in tests), no clock reads — timestamps come from the stores'
// injected clocks.
import { MAX_UTTERANCE_LENGTH } from './store.mjs';

/** PRD §8.1 default wont vocabulary — relaxing any of these is FORBIDDEN. */
const SYSTEM_WONT_PATTERNS = Object.freeze([
  '付款', '支付', '对外发送', '发送邮件', '发邮件',
  '读凭据', '读取凭据', '删文件', '删除文件', '零打扰', '入侵',
]);

/** The only MissionPatch fields apply can faithfully apply (fail-closed). */
const PATCH_FIELDS = Object.freeze(['sources', 'length', 'boundary']);
const BOUNDARY_SECTIONS = Object.freeze(['will', 'wont']);
const BOUNDARY_OPS = Object.freeze(['add', 'remove']);

function fail(code, message, extra = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  for (const [key, value] of Object.entries(extra)) error[key] = value;
  throw error;
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('CONTRACT_INVALID', `${name} must be a non-empty string`);
  }
}

function requireStringArray(value, name, { allowEmpty } = { allowEmpty: true }) {
  const bad = !Array.isArray(value)
    || (!allowEmpty && value.length === 0)
    || value.some(item => typeof item !== 'string' || item.trim() === '');
  if (bad) {
    fail('CONTRACT_INVALID', `${name} must be an array of non-empty strings${allowEmpty ? '' : ' (at least one)'}`);
  }
}

/** Replay identity of an utterance: trimmed, whitespace runs collapsed. */
function normalizeUtterance(utterance) {
  return utterance.trim().replace(/\s+/g, ' ');
}

/** Deterministic idempotency key for one discussion turn. */
function idempotencyKeyFor(missionId, baseVersion, utterance) {
  return JSON.stringify(['discuss-v1', missionId, baseVersion, normalizeUtterance(utterance)]);
}

function isSystemWont(item) {
  return SYSTEM_WONT_PATTERNS.some(pattern => item.includes(pattern));
}

/**
 * Fail-closed MissionPatch shape check. Returns the patch (or null when the
 * parser produced no patch); anything apply cannot apply exactly is
 * CONTRACT_INVALID before a single row is written.
 */
function validatePatch(patch) {
  if (patch === null || patch === undefined) return null;
  if (typeof patch !== 'object' || Array.isArray(patch)) {
    fail('CONTRACT_INVALID', 'patch must be a MissionPatch object or null');
  }
  for (const field of Object.keys(patch)) {
    if (!PATCH_FIELDS.includes(field)) {
      fail('CONTRACT_INVALID', `unrecognized patch field: ${field} (apply supports: ${PATCH_FIELDS.join(', ')})`);
    }
  }
  if (patch.sources != null) {
    if (typeof patch.sources !== 'object' || Array.isArray(patch.sources)) {
      fail('CONTRACT_INVALID', 'patch.sources must be an object');
    }
    for (const field of Object.keys(patch.sources)) {
      if (field !== 'include') fail('CONTRACT_INVALID', `unrecognized patch.sources field: ${field}`);
    }
    if (patch.sources.include !== undefined) {
      requireStringArray(patch.sources.include, 'patch.sources.include', { allowEmpty: false });
    }
  }
  if (patch.length != null) {
    if (typeof patch.length !== 'object' || Array.isArray(patch.length)) {
      fail('CONTRACT_INVALID', 'patch.length must be an object');
    }
    for (const field of Object.keys(patch.length)) {
      if (field !== 'unit' && field !== 'value') {
        fail('CONTRACT_INVALID', `unrecognized patch.length field: ${field}`);
      }
    }
    if (typeof patch.length.unit !== 'string' || patch.length.unit.trim() === '') {
      fail('CONTRACT_INVALID', 'patch.length.unit must be a non-empty string');
    }
    if (typeof patch.length.value !== 'number' || !Number.isFinite(patch.length.value) || patch.length.value <= 0) {
      fail('CONTRACT_INVALID', 'patch.length.value must be a positive number');
    }
  }
  if (patch.boundary != null) {
    if (typeof patch.boundary !== 'object' || Array.isArray(patch.boundary)) {
      fail('CONTRACT_INVALID', 'patch.boundary must be an object');
    }
    for (const field of Object.keys(patch.boundary)) {
      if (!BOUNDARY_SECTIONS.includes(field)) {
        fail('CONTRACT_INVALID', `unrecognized patch.boundary field: ${field}`);
      }
    }
    for (const section of BOUNDARY_SECTIONS) {
      const ops = patch.boundary[section];
      if (ops == null) continue;
      if (typeof ops !== 'object' || Array.isArray(ops)) {
        fail('CONTRACT_INVALID', `patch.boundary.${section} must be an object`);
      }
      for (const op of Object.keys(ops)) {
        if (!BOUNDARY_OPS.includes(op)) {
          fail('CONTRACT_INVALID', `unrecognized patch.boundary.${section} op: ${op}`);
        }
      }
      if (ops.add !== undefined) requireStringArray(ops.add, `patch.boundary.${section}.add`);
      if (ops.remove !== undefined) requireStringArray(ops.remove, `patch.boundary.${section}.remove`);
    }
  }
  return patch;
}

/** PRD §8.1: system-forbidden items can never be relaxed through a patch. */
function forbidRelaxations(patch, currentWont) {
  const willAdd = patch?.boundary?.will?.add;
  if (willAdd) {
    for (const item of willAdd) {
      if (isSystemWont(item)) {
        fail('FORBIDDEN', `system-forbidden actions can never be added to will: ${item}`);
      }
      if (currentWont.includes(item)) {
        fail('FORBIDDEN', `will item contradicts the owner's explicit wont: ${item}`);
      }
    }
  }
  const wontRemove = patch?.boundary?.wont?.remove;
  if (wontRemove) {
    for (const item of wontRemove) {
      if (isSystemWont(item)) {
        fail('FORBIDDEN', `system wont items can never be removed: ${item}`);
      }
    }
  }
}

/** The preview's facts block, or null when the shape has none. */
function factsBlockOf(preview) {
  return preview.shape.blocks.find(block => block.type === 'facts') ?? null;
}

/** Set one facts entry (creating it when absent) and record its dotted path. */
function setFact(preview, key, value, changed, path) {
  const block = factsBlockOf(preview);
  if (block === null || !Array.isArray(block.items)) {
    fail('CONTRACT_INVALID', `cannot apply ${path}: the preview has no facts block to update`);
  }
  const item = block.items.find(entry => entry.k === key);
  if (item === undefined) block.items.push({ k: key, v: value });
  else item.v = value;
  changed.push(path);
}

/**
 * Pure derivation of the next preview from (current preview, patch, reason).
 * Never mutates the input; returns the candidate preview, the changed dotted
 * paths, and the subset of those paths that are contract-relevant (boundary.*).
 * An empty change set yields the preview unchanged with no diff.
 */
function applyPatchToPreview(preview, patch, reason) {
  const next = structuredClone(preview);
  const changed = [];
  const contractFields = [];

  if (patch?.sources?.include) {
    setFact(next, '来源范围', patch.sources.include.join('、'), changed, 'shape.facts[来源范围]');
  }
  if (patch?.length) {
    setFact(next, '课时', String(patch.length.value), changed, 'shape.facts[课时]');
  }
  if (patch?.boundary) {
    for (const section of BOUNDARY_SECTIONS) {
      const ops = patch.boundary[section];
      if (ops == null) continue;
      const list = next.boundary[section];
      const toAdd = (ops.add ?? []).filter(item => !list.includes(item));
      const toRemove = ops.remove ?? [];
      const removesAny = toRemove.some(item => list.includes(item));
      if (toAdd.length === 0 && !removesAny) continue; // pure no-op section
      next.boundary[section] = [...list.filter(item => !toRemove.includes(item)), ...toAdd];
      const path = `boundary.${section}`;
      changed.push(path);
      contractFields.push(path);
    }
  }

  if (changed.length > 0) next.diff = { changed, reason };
  else delete next.diff;
  return { preview: next, changed, contractFields };
}

/**
 * Apply one discussion turn end to end.
 *
 * params: { ownerId, missionId, actor, utterance, baseVersion, previewStore,
 * discussionStore, parsePatch }. `parsePatch(utterance)` must resolve to
 * { patch, origin } (patch null when nothing matched) or reject with
 * code UPSTREAM_UNAVAILABLE — both per discussion/patch-parser.mjs.
 *
 * Resolves with { replayed, preview, message, changeRecord }:
 *   * replayed — true when the (owner, mission, baseVersion, normalized
 *     utterance) turn was already recorded; the stored result comes back.
 *   * preview — the preview-store row after the turn (a new version row when
 *     the patch changed something, otherwise the current live row).
 *   * message — the appended discussion message (beforeVersion/afterVersion
 *     pair; afterVersion === beforeVersion when no new version was produced).
 *   * changeRecord — the contract_change_records row for contract-relevant
 *     patches, or null.
 */
export async function applyPatch(params) {
  const {
    ownerId, missionId, actor, utterance, baseVersion,
    previewStore, discussionStore, parsePatch,
  } = params ?? {};
  requireNonEmptyString(ownerId, 'ownerId');
  requireNonEmptyString(missionId, 'missionId');
  requireNonEmptyString(actor, 'actor');
  if (!Number.isInteger(baseVersion) || baseVersion < 1) {
    fail('CONTRACT_INVALID', 'baseVersion must be an integer >= 1');
  }
  if (typeof utterance !== 'string') {
    fail('CONTRACT_INVALID', 'utterance must be a string');
  }
  if (typeof parsePatch !== 'function') {
    fail('CONTRACT_INVALID', 'parsePatch must be an injected function');
  }
  if (previewStore == null || discussionStore == null) {
    fail('CONTRACT_INVALID', 'previewStore and discussionStore are required');
  }

  const idempotencyKey = idempotencyKeyFor(missionId, baseVersion, utterance);

  // 1. Replay first: a recorded turn is returned exactly as stored, even
  //    though the live version has moved on since (a retry must not 409).
  const thread = discussionStore.getThread({ ownerId, missionId });
  const recorded = thread === null
    ? null
    : thread.messages.find(message => message.idempotencyKey === idempotencyKey) ?? null;
  if (recorded !== null) {
    const message = { ...recorded, replayed: true };
    const version = message.afterVersion ?? message.beforeVersion;
    const preview = (await previewStore.get({ ownerId, missionId, version }))
      ?? (await previewStore.latest({ ownerId, missionId }));
    const changeRecord = discussionStore
      .listChangeRecords({ ownerId, missionId })
      .find(record => record.messageId === message.id) ?? null;
    return { replayed: true, preview, message, changeRecord };
  }

  // 2. Utterance gates (post-replay: a stored turn is always within bounds).
  if (utterance.trim() === '') {
    fail('CONTRACT_INVALID', 'utterance must not be empty');
  }
  if (utterance.length > MAX_UTTERANCE_LENGTH) {
    fail('CONTRACT_INVALID', `utterance must be at most ${MAX_UTTERANCE_LENGTH} characters`);
  }

  // 3. Existence + optimistic concurrency — both fail before any write.
  const live = await previewStore.latest({ ownerId, missionId });
  if (live === null) {
    fail('NOT_FOUND', `no preview exists for this owner and mission ${missionId}`);
  }
  if (live.version !== baseVersion) {
    fail('CONFLICT', `baseVersion ${baseVersion} is stale; current version is ${live.version}`, {
      currentVersion: live.version,
    });
  }

  // 4. Parse, then shape-check and forbid relaxations — all before any write.
  const parsed = await parsePatch(utterance);
  const patch = validatePatch(parsed == null ? parsed : parsed.patch ?? null);
  forbidRelaxations(patch, live.preview.boundary.wont);

  // 5. Derive the next preview purely; an empty change set keeps the version.
  const { preview: nextPreview, changed, contractFields } = applyPatchToPreview(live.preview, patch, utterance);

  const turn = {
    ownerId,
    missionId,
    actor,
    utterance,
    baseVersion,
    beforeVersion: live.version,
    idempotencyKey,
    patch,
  };

  if (changed.length === 0) {
    // The talk is recorded, the preview is untouched (no patch or pure no-op).
    const message = await discussionStore.appendMessage({ ...turn, afterVersion: live.version });
    return { replayed: message.replayed, preview: live, message, changeRecord: null };
  }

  // 6. Version first, then the message (+ change record in the same txn).
  const stored = await previewStore.put({ ownerId, missionId, preview: nextPreview, baseVersion });
  const message = await discussionStore.appendMessage({
    ...turn,
    afterVersion: stored.version,
    contractChange: contractFields.length > 0 ? { patch, changedFields: contractFields } : undefined,
  });
  const changeRecord = contractFields.length > 0
    ? discussionStore
      .listChangeRecords({ ownerId, missionId })
      .find(record => record.messageId === message.id) ?? null
    : null;
  return { replayed: message.replayed, preview: stored, message, changeRecord };
}
