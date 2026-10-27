// S2D-W6 module 9: preview-routes (.s2d/plan.md §3 row 9) — the HTTP surface
// over the W6 stores. Per BUILD-PLAN §2.1 this module is NOT mounted into
// scripts/serve-tango.mjs: it exports createPreviewRoutes({db,auth,parsePatch,
// now}) → (req,res,pathname) => handled:boolean, and W13 mounts it in batch 3.
//
// Route table (PRD §10.4 API subset owned by this stream):
//   GET  /api/missions/:id/preview           → latest persisted version row
//   GET  /api/missions/:id/preview/versions  → the whole immutable chain
//   GET  /api/missions/:id/preview/timeline  → W11 timeline VM (projection)
//   POST /api/missions/:id/discuss           → one turn: parse→patch→next version
//   GET  /api/missions/:id/discussion        → replay the thread + change records
//   POST /api/missions/:id/confirm           → confirm/request_change/decline
//
// Rules enforced here (plan §2 负面路径; routes.test.mjs is the spec):
//   * Every error is the FROZEN api-error envelope (contracts/agentic/
//     api-error.schema.json): { error: { code, message, details?, requestId? } }.
//   * Unauthenticated → 401 AUTH_REQUIRED on every route; a principal without
//     an ownerId is equally unauthenticated (fail closed).
//   * Cross-owner reads/writes → 404 NOT_FOUND / empty lists: the stores scope
//     every query by owner_id, so a foreign owner can never distinguish
//     "missing" from "someone else's" (contract README:52, no existence leak).
//   * Stale baseVersion → 409 CONFLICT, malformed/oversized bodies, unknown
//     body keys and empty missionId → 400 CONTRACT_INVALID — all before any
//     write; a rejected request leaves zero rows behind (fail-closed stores).
//   * parsePatch failures (timeout / upstream down) surface as 503
//     UPSTREAM_UNAVAILABLE with zero preview changes (apply.mjs gates).
//   * P0→contracted: no external side effects — the parser is injected (the
//     default is the deterministic rules kernel of patch-parser.mjs, which
//     makes no network or model calls), the clock is injected, and confirm
//     only RECORDS the decision + contract-draft-request event (W3 interface);
//     it never dispatches anything.
//
// SSE seam (PRD §10.4 marks GET preview「SSE 推送分层渲染进度」): W6 serves the
// persisted snapshot as plain JSON. Layered render-progress events (L0→L2) are
// produced by the preview generation pipeline and rendered by W5/W11; when
// those land, this handler upgrades to text/event-stream WITHOUT changing the
// JSON payloads below. Rendering/player progress stays W11/W5 territory — it
// is never persisted into the frozen Preview contract (CTO-DECISIONS §2.3).
import { randomUUID } from 'node:crypto';
import { createPreviewStore } from './store.mjs';
import { projectTimeline } from './timeline.mjs';
import { createDiscussionStore } from '../discussion/store.mjs';
import { createConfirmEntry } from '../discussion/confirm.mjs';
import { applyPatch } from '../discussion/apply.mjs';
import { parsePatch as parsePatchKernel } from '../discussion/patch-parser.mjs';

/** api-error code → HTTP status (every code in the frozen enum is mapped). */
const STATUS_BY_CODE = Object.freeze({
  AUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONTRACT_INVALID: 400,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  BUDGET_EXCEEDED: 402,
  NEED_HUMAN: 428,
  UPSTREAM_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
});

/** Request-body cap: far above MAX_UTTERANCE_LENGTH (2000 chars) + envelope. */
const MAX_BODY_BYTES = 64 * 1024;

/** missionId path-segment bounds (plan §2: 空/超长 → CONTRACT_INVALID). */
const MAX_MISSION_ID_LENGTH = 200;

function fail(code, message, extra = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  for (const [key, value] of Object.entries(extra)) error[key] = value;
  throw error;
}

/** Build (not throw) an api-error — for promise executors, where throw would
 *  escape into the event emitter instead of rejecting the promise. */
function errorOf(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * Map any thrown value onto the frozen api-error envelope. Unknown codes and
 * plain Errors become INTERNAL_ERROR with a generic message — an infrastructure
 * bug's text is never leaked to the client; the requestId carries the trace.
 */
function sendError(res, error, requestId) {
  // Guard double-response: if the response already went out, only log-less
  // back out (writableEnded on real responses, `ended` in the test harness).
  if (res.writableEnded === true || res.ended === true) return;
  const code = error !== null && typeof error === 'object'
    && typeof error.code === 'string' && STATUS_BY_CODE[error.code] !== undefined
    ? error.code
    : 'INTERNAL_ERROR';
  const errorBody = {
    code,
    message: code === 'INTERNAL_ERROR'
      ? 'internal server error'
      : (error && error.message) || 'request failed',
  };
  // Optional `details` object: validation errors and conflict diagnostics ride
  // along when present (schema allows a details object; never arrays/scalars).
  const details = {};
  if (Array.isArray(error?.errors)) details.errors = error.errors;
  if (error?.currentVersion !== undefined && error?.currentVersion !== null) {
    details.currentVersion = error.currentVersion;
  }
  if (Object.keys(details).length > 0) errorBody.details = details;
  if (typeof requestId === 'string' && requestId.length > 0) errorBody.requestId = requestId;
  sendJson(res, STATUS_BY_CODE[code], { error: errorBody });
}

/**
 * Attach body listeners SYNCHRONOUSLY (before the first await of the dispatch
 * chain) so no 'data'/'end' event is ever missed, and buffer the request while
 * auth runs. Resolves with Buffer[]; rejects CONTRACT_INVALID past the size
 * cap. A detached .catch keeps an unconsumed body (GET requests) from ever
 * surfacing as an unhandled rejection.
 */
function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        settled = true;
        reject(errorOf('CONTRACT_INVALID', `request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(chunks);
    });
    req.on('error', (streamError) => {
      if (settled) return;
      settled = true;
      reject(errorOf('CONTRACT_INVALID', `request stream failed: ${streamError.message}`));
    });
  });
}

/** Await a collected body and demand a non-empty JSON object (fail closed). */
async function readJsonBody(collected) {
  const text = Buffer.concat(await collected).toString('utf8');
  if (text.trim() === '') {
    fail('CONTRACT_INVALID', 'request body must be a JSON object');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail('CONTRACT_INVALID', `request body is not valid JSON: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('CONTRACT_INVALID', 'request body must be a JSON object');
  }
  return parsed;
}

/** Strict allow-list: a body carrying unknown fields is CONTRACT_INVALID. */
function rejectUnknownKeys(body, allowed) {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      fail('CONTRACT_INVALID', `unrecognized field in request body: ${key} (allowed: ${allowed.join(', ')})`);
    }
  }
}

/** Store row → HTTP summary (ownerId never leaves the server). */
function previewSummary(row) {
  return {
    id: row.id,
    missionId: row.missionId,
    version: row.version,
    revision: row.revision,
    preview: row.preview,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Lighter version-list entry (the chain can be long; payloads stay per-version). */
function versionSummary(row) {
  return {
    id: row.id,
    missionId: row.missionId,
    version: row.version,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Decode one path segment; un-decodable input is not our route. */
function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Create the W6 preview/discussion route table over an already-migrated
 * Agentic database (preview-001-store.sql + preview-002-discussion.sql).
 *
 * params:
 *   db         — migrated node:sqlite database (required; wiring-time check)
 *   auth       — (req) => principal | null | Promise<principal | null>, where
 *                a principal is { ownerId, actor? }. Missing → every request
 *                is AUTH_REQUIRED (fail closed).
 *   parsePatch — (utterance) => { patch, origin } per patch-parser.mjs;
 *                defaults to the deterministic rules kernel (no LLM, no IO).
 *   now        — () => ISO timestamp injected into all three stores.
 *
 * Returns (req, res, pathname) => handled:boolean. `handled` is decided by
 * (method, path) alone; the response itself is written asynchronously.
 */
export function createPreviewRoutes(options = {}) {
  const {
    db,
    auth = () => null,
    parsePatch = utterance => parsePatchKernel(utterance),
    now = () => new Date().toISOString(),
  } = options ?? {};
  if (db === null || db === undefined) {
    throw new Error('createPreviewRoutes requires a migrated db (openAgenticDb + migrate)');
  }
  if (typeof auth !== 'function') {
    throw new Error('createPreviewRoutes requires auth: (req) => principal | null');
  }
  if (typeof parsePatch !== 'function') {
    throw new Error('createPreviewRoutes requires parsePatch: (utterance) => { patch, origin }');
  }

  const previewStore = createPreviewStore(db, { now });
  const discussionStore = createDiscussionStore(db, { now });
  const confirmEntry = createConfirmEntry(db, { now });

  /** Fail-closed path-segment gate shared by every handler. */
  function requireMissionId(missionId) {
    if (typeof missionId !== 'string' || missionId.trim() === '') {
      fail('CONTRACT_INVALID', 'missionId path segment must be a non-empty string');
    }
    if (missionId.length > MAX_MISSION_ID_LENGTH) {
      fail('CONTRACT_INVALID', `missionId must be at most ${MAX_MISSION_ID_LENGTH} characters`);
    }
  }

  /** auth may be sync or async; no principal or no ownerId → AUTH_REQUIRED. */
  async function authenticate(req) {
    const principal = await auth(req);
    if (principal === null || principal === undefined || typeof principal !== 'object') {
      fail('AUTH_REQUIRED', 'authentication required');
    }
    const { ownerId } = principal;
    if (typeof ownerId !== 'string' || ownerId.trim() === '') {
      fail('AUTH_REQUIRED', 'authenticated principal has no ownerId');
    }
    const actor = typeof principal.actor === 'string' && principal.actor.trim() !== ''
      ? principal.actor
      : ownerId;
    return { ownerId, actor };
  }

  /* ---- handlers: async, throw api-error-coded errors, end the response ---- */

  async function getPreview({ res, ownerId, missionId }) {
    const row = await previewStore.latest({ ownerId, missionId });
    if (row === null) {
      fail('NOT_FOUND', `no preview exists for this owner and mission ${missionId}`);
    }
    // SSE seam: see the module header — layered render progress is W11/W5.
    sendJson(res, 200, previewSummary(row));
  }

  async function listVersions({ res, ownerId, missionId }) {
    // A foreign or fresh mission yields [] — the chain listing carries no
    // existence information (owner scoping lives in the store predicates).
    const rows = await previewStore.list({ ownerId, missionId });
    sendJson(res, 200, rows.map(versionSummary));
  }

  async function getTimeline({ res, ownerId, missionId }) {
    const row = await previewStore.latest({ ownerId, missionId });
    if (row === null) {
      fail('NOT_FOUND', `no preview exists for this owner and mission ${missionId}`);
    }
    // The ONE place the frozen Preview meets the W11 player VM: a pure
    // projection (timeline.mjs); no player convenience ever grows the schema.
    sendJson(res, 200, projectTimeline(row.preview, {
      previewId: row.id,
      revision: row.revision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  async function postDiscuss({ res, req, body, ownerId, actor, missionId }) {
    rejectUnknownKeys(body, ['utterance', 'baseVersion']);
    if (typeof body.utterance !== 'string') {
      fail('CONTRACT_INVALID', 'utterance must be a string');
    }
    // baseVersion defaults to the current live version (PRD §11.3: the client
    // may omit it when it is not guarding against concurrent turns).
    let baseVersion = body.baseVersion;
    if (baseVersion === undefined || baseVersion === null) {
      const live = await previewStore.latest({ ownerId, missionId });
      if (live === null) {
        fail('NOT_FOUND', `no preview exists for this owner and mission ${missionId}`);
      }
      baseVersion = live.version;
    } else if (!Number.isInteger(baseVersion) || baseVersion < 1) {
      fail('CONTRACT_INVALID', 'baseVersion must be an integer >= 1');
    }
    const result = await applyPatch({
      ownerId,
      missionId,
      actor,
      utterance: body.utterance,
      baseVersion,
      previewStore,
      discussionStore,
      parsePatch,
    });
    sendJson(res, 200, {
      replayed: result.replayed,
      preview: previewSummary(result.preview),
      message: result.message,
      changeRecord: result.changeRecord,
    });
  }

  async function getDiscussion({ res, ownerId, missionId }) {
    // A mission without a preview has no discussion context: uniformly
    // NOT_FOUND (a foreign owner's mission looks exactly the same).
    const live = await previewStore.latest({ ownerId, missionId });
    if (live === null) {
      fail('NOT_FOUND', `no preview exists for this owner and mission ${missionId}`);
    }
    const thread = discussionStore.getThread({ ownerId, missionId });
    if (thread === null) {
      // Previewed but never discussed yet: an empty replay, not an error.
      sendJson(res, 200, { thread: null, messages: [], changeRecords: [] });
      return;
    }
    sendJson(res, 200, {
      thread: {
        id: thread.id,
        missionId: thread.missionId,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      },
      messages: thread.messages,
      // 讨论不改变合同而无记录: the audit trail ships with the replay.
      changeRecords: discussionStore.listChangeRecords({ ownerId, missionId }),
    });
  }

  async function postConfirm({ res, body, ownerId, actor, missionId }) {
    rejectUnknownKeys(body, ['previewVersion', 'decision', 'note']);
    // Shape and idempotency checks live in confirm-entry (single source of
    // truth); unknown decision → CONTRACT_INVALID, unknown/foreign/soft-deleted
    // version → NOT_FOUND, replay → the stored record with replayed:true.
    const record = await confirmEntry.record({
      ownerId,
      missionId,
      actor,
      previewVersion: body.previewVersion,
      decision: body.decision,
      note: body.note,
    });
    sendJson(res, 200, record);
  }

  /* ---- (method, path) table: claiming is decided here, synchronously ---- */

  const ROUTES = [
    { method: 'GET', tail: ['preview'], needsBody: false, handler: getPreview },
    { method: 'GET', tail: ['preview', 'versions'], needsBody: false, handler: listVersions },
    { method: 'GET', tail: ['preview', 'timeline'], needsBody: false, handler: getTimeline },
    { method: 'POST', tail: ['discuss'], needsBody: true, handler: postDiscuss },
    { method: 'GET', tail: ['discussion'], needsBody: false, handler: getDiscussion },
    { method: 'POST', tail: ['confirm'], needsBody: true, handler: postConfirm },
  ];

  /** Match (method, pathname) against the table; null = not our route. */
  function matchRoute(method, pathname) {
    if (typeof pathname !== 'string' || pathname === '') return null;
    const path = pathname.split('?')[0];
    const parts = path.split('/');
    // Expected shape: ['', 'api', 'missions', <missionId>, ...tail] — a
    // leading '/' yields the empty first element; relative paths never match.
    if (parts[0] !== '' || parts[1] !== 'api' || parts[2] !== 'missions') return null;
    const missionId = decodeSegment(parts[3]);
    if (missionId === null) return null; // undecodable segment: not ours
    const tail = parts.slice(4);
    for (const route of ROUTES) {
      if (route.method !== method) continue;
      if (route.tail.length !== tail.length) continue;
      if (route.tail.every((segment, index) => segment === tail[index])) {
        return { route, missionId };
      }
    }
    return null;
  }

  function routes(req, res, pathname) {
    const match = matchRoute(req.method, pathname);
    if (match === null) return false;
    const { route, missionId } = match;
    // Buffer the body from the very first tick so no event is lost while auth
    // is being resolved; GET handlers simply never await it.
    const collected = collectBody(req);
    collected.catch(() => {});
    const requestId = randomUUID();
    (async () => {
      const principal = await authenticate(req); // 401 before anything else
      requireMissionId(missionId); // 400 for empty/oversized missionId
      const body = route.needsBody ? await readJsonBody(collected) : undefined;
      await route.handler({ req, res, body, ownerId: principal.ownerId, actor: principal.actor, missionId });
    })().catch((error) => {
      sendError(res, error, requestId);
    });
    return true;
  }

  return routes;
}
