/**
 * W10 observability read routes (unmounted).
 *
 * The factory returns a 3-arity dispatcher `(req, res, pathname) => handled`.
 * It deliberately has no dependency on a running http.Server, no router and no
 * side effects outside the response object, so W13 can mount it and the tests
 * can exercise it directly.
 *
 * Every route is owner-scoped and answers with the frozen `api-error` envelope.
 * An unknown run and a run owned by somebody else produce a *byte-identical*
 * 404, so a probe cannot use the difference to enumerate other owners' runs
 * (N12). Authentication failures are collapsed into one generic 401 so an auth
 * implementation cannot leak its reason (or a token) through the body.
 */

import { createObservabilityStore, parseJsonOr } from './store.mjs';
import { createSpanRecorder } from './spans.mjs';

export const OBS_ROUTE_PATHS = Object.freeze(['/api/runs/:id/trace', '/api/runs/:id/activity', '/api/cache/stale']);

const JSON_HEADERS = Object.freeze({ 'content-type': 'application/json; charset=utf-8' });

/** Single generic body for every not-found answer, foreign or unknown alike. */
const NOT_FOUND_BODY = Object.freeze({ error: Object.freeze({ code: 'NOT_FOUND', message: 'run not found' }) });
const NOT_FOUND_TEXT = JSON.stringify(NOT_FOUND_BODY);

const AUTH_FAILED_TEXT = JSON.stringify({ error: { code: 'AUTH_REQUIRED', message: 'authentication required' } });

function send(res, statusCode, payload) {
  res.writeHead(statusCode, { ...JSON_HEADERS });
  res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  return true;
}

function sendNotFound(res) {
  return send(res, 404, NOT_FOUND_TEXT);
}

/**
 * Resolve the caller's session without ever exposing why it failed.
 *
 * A missing session, a session without an owner and a throwing auth function
 * are all the same 401 to the client.
 */
function resolveOwner(auth, req) {
  try {
    const session = typeof auth === 'function' ? auth(req) : null;
    const ownerId = session?.ownerId;
    return typeof ownerId === 'string' && ownerId.trim().length > 0 ? ownerId : null;
  } catch {
    return null;
  }
}

/** Split a pathname into decoded segments; returns null for an unusable path. */
function segments(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return null;
  const parts = pathname.split('/');
  try {
    return parts.map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
}

function runRoute(parts) {
  // ['', 'api', 'runs', '<id>', '<trace|activity>']
  if (parts.length !== 5) return null;
  if (parts[1] !== 'api' || parts[2] !== 'runs') return null;
  if (parts[4] !== 'trace' && parts[4] !== 'activity') return null;
  const id = parts[3];
  if (typeof id !== 'string' || id.length === 0) return null;
  return { id, action: parts[4] };
}

function isStaleCacheRoute(parts) {
  return parts.length === 4 && parts[1] === 'api' && parts[2] === 'cache' && parts[3] === 'stale';
}

function cacheRowForApi(row) {
  return {
    key: row.key,
    kind: row.kind,
    contractHash: row.contract_hash,
    blockRevision: row.block_revision,
    model: row.model,
    effort: row.effort,
    inputsHash: row.inputs_hash,
    modelSource: row.model_source,
    freshness: row.freshness,
    reasons: parseJsonOr(row.reasons_json, []),
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

/**
 * Count span outcomes for the activity view.
 *
 * `running`/`incomplete` stays separate from both success and failure: a trace
 * cut short is neither (N9/N10).
 */
function activityCounts(rows) {
  const counts = { succeeded: 0, failed: 0, running: 0, incomplete: 0 };
  for (const row of rows) {
    if (row.status === 'ok') counts.succeeded += 1;
    else if (row.status === 'error') counts.failed += 1;
    else {
      counts.running += 1;
      counts.incomplete += 1;
    }
  }
  return counts;
}

export function createObservabilityRoutes({ db, auth } = {}) {
  const store = createObservabilityStore({ db });
  const recorder = createSpanRecorder({ store });

  return function observabilityRoute(req, res, pathname) {
    if (req?.method !== 'GET') return false;

    const parts = segments(pathname);
    if (parts === null) return false;

    const runHit = runRoute(parts);
    const cacheHit = runHit === null && isStaleCacheRoute(parts);
    if (runHit === null && !cacheHit) return false;

    const ownerId = resolveOwner(auth, req);
    if (ownerId === null) {
      send(res, 401, AUTH_FAILED_TEXT);
      return true;
    }

    if (cacheHit) {
      const entries = store.listStaleCacheEntries(ownerId).map(cacheRowForApi);
      send(res, 200, { entries, count: entries.length });
      return true;
    }

    const run = store.getRun(ownerId, runHit.id);
    if (!run) {
      // Unknown and foreign collapse into the same bytes (N12).
      sendNotFound(res);
      return true;
    }

    if (runHit.action === 'trace') {
      const tree = recorder.buildTree(ownerId, run.id);
      send(res, 200, { run, tree: { roots: tree.roots, orphans: tree.orphans }, spans: store.listRunSpans(ownerId, run.id) });
      return true;
    }

    const rows = store.listRunSpans(ownerId, run.id);
    send(res, 200, {
      runId: run.id,
      counts: activityCounts(rows),
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        status: row.status,
        startedAt: row.started_at,
        endedAt: row.ended_at ?? null,
        actorRole: row.actor_role ?? null,
        resolvedModel: row.resolved_model ?? null,
        modelSource: row.model_source ?? null,
        provenance: row.provenance,
        error: row.error ?? null,
      })),
    });
    return true;
  };
}
