// W9 M1 delivery-domain · 路由工厂（BUILD-PLAN §2.2；挂载与 SSE/HTTP 归 W13，本模块不挂 serve-tango）
//
// createDeliveryRoutes({ db, auth, clock, idGen, events, verdictGate? })
//   → async (req, res, pathname) => handled:boolean
//   - GET  /api/artifacts/:id（?version=N）        → 200 artifact（过 artifact.schema.json）
//   - POST /api/artifacts/:id/accept|revise|reject → 200 { acceptance, verdict? }
//   - auth(req) → { ownerId } | null；null → 401 AUTH_REQUIRED（api-error 信封）。
//   - verdictGate(artifactId, version) 提供时附核验摘要；未提供则响应无 verdict 字段。
//   - 未匹配的 pathname 返回 false 且不写响应（由挂载方继续分发）。
import { createArtifactStore } from './artifact-store.mjs';
import { createAcceptance } from './acceptance.mjs';
import { ApiError, readJsonBody, requireInjectables, sendApiError, sendJson } from './util.mjs';

const GET_ARTIFACT = /^\/api\/artifacts\/([^/]+)$/;
const POST_DECISION = /^\/api\/artifacts\/([^/]+)\/(accept|revise|reject)$/;
const VERB_BY_ACTION = Object.freeze({ accept: 'accept', revise: 'revise', reject: 'reject' });

export function createDeliveryRoutes({ db, auth, clock, idGen, events, verdictGate }) {
  requireInjectables('createDeliveryRoutes', { db, auth, clock, idGen }, ['db', 'auth', 'clock', 'idGen']);
  const store = createArtifactStore({ db, clock, idGen, events });
  const acceptance = createAcceptance({ db, clock, idGen, events });

  return async function deliveryRoutes(req, res, pathname) {
    const rawPath = typeof pathname === 'string' && pathname !== '' ? pathname : req?.url;
    if (typeof rawPath !== 'string' || rawPath === '') return false;
    const path = rawPath.split('?')[0];
    const query = new URLSearchParams(rawPath.split('?')[1] ?? '');

    const method = req?.method;
    const getMatch = method === 'GET' ? GET_ARTIFACT.exec(path) : null;
    const postMatch = method === 'POST' ? POST_DECISION.exec(path) : null;
    if (getMatch === null && postMatch === null) return false;

    try {
      const session = auth(req);
      if (session === null || session === undefined || typeof session.ownerId !== 'string' || session.ownerId === '') {
        throw new ApiError('AUTH_REQUIRED', 'authentication required');
      }
      const { ownerId } = session;

      if (getMatch !== null) {
        const artifactId = decodeURIComponent(getMatch[1]);
        const rawVersion = query.get('version');
        const options = rawVersion === null ? {} : { version: Number(rawVersion) };
        const artifact = await store.get(ownerId, artifactId, options);
        sendJson(res, 200, artifact);
        return true;
      }

      const artifactId = decodeURIComponent(postMatch[1]);
      const body = await readJsonBody(req);
      const artifactRow = db.prepare(
        'SELECT current_version FROM w9_artifacts WHERE id = ? AND owner_id = ? AND deleted_at IS NULL',
      ).get(artifactId, ownerId);
      if (artifactRow == null) throw new ApiError('NOT_FOUND', 'artifact not found');

      const options = { actor: body.actor, decision: VERB_BY_ACTION[postMatch[2]] };
      if (body.comment !== undefined) options.comment = body.comment;
      if (body.version !== undefined) options.version = body.version;
      const record = await acceptance.record(ownerId, artifactId, options);

      // 验收绑定的版本：显式 version（record 已校验 = 最新）或当前最新版本。
      const boundVersion = Number.isInteger(options.version) ? options.version : artifactRow.current_version;

      const responseBody = { acceptance: record };
      if (verdictGate !== undefined && verdictGate !== null) {
        responseBody.verdict = await verdictGate(artifactId, boundVersion);
      }
      sendJson(res, 200, responseBody);
      return true;
    } catch (error) {
      sendApiError(res, error);
      return true;
    }
  };
}
