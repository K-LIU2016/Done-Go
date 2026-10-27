// W9 M1 delivery-domain · 用户验收（brief 裁决③：用户验收 ≠ agent 自报成功）
//
// createAcceptance({ db, clock, idGen, events }) → { record(ownerId, artifactId, opts) }
//   - decision 动词：accept | revise | reject → 落库/返回对象映射 accepted | revision_requested | rejected。
//   - 只允许对 status='ready' 的最新版本验收；generating/accepted/rejected/revision_requested → CONFLICT。
//   - version 缺省绑定当前最新版本；显式 version ≠ 最新 → CONFLICT。
//   - actor 必须是 'user:*'；'agent:*' 自报 → FORBIDDEN。
//   - accepted/rejected 关闭版本链（新 put CONFLICT）；revision_requested 允许新版本继续。
//   - 每次_record 恰好消费一次 clock.now()；w9_acceptances 落 owner_id/artifact_version/mission_id，
//     对外对象保持 acceptance.schema.json 纯净；状态翻转写入 append-only 的 w9_artifact_events。
import { loadSchema, validate } from '../contracts.mjs';
import {
  ApiError, CONTRACT_DIR, NOOP_EVENTS, assertNonEmptyString, rejectUnknownFields,
  requireInjectables, withTransaction,
} from './util.mjs';

const ACCEPTANCE_SCHEMA = loadSchema('acceptance.schema.json', CONTRACT_DIR);

const DECISION_BY_VERB = Object.freeze({
  accept: 'accepted',
  revise: 'revision_requested',
  reject: 'rejected',
});
const RECORD_ALLOWED_KEYS = ['actor', 'decision', 'comment', 'version'];

export function createAcceptance({ db, clock, idGen, events = NOOP_EVENTS }) {
  requireInjectables('createAcceptance', { db, clock, idGen }, ['db', 'clock', 'idGen']);
  const sink = events ?? NOOP_EVENTS;

  async function record(ownerId, artifactId, opts = {}) {
    assertNonEmptyString(ownerId, 'ownerId');
    assertNonEmptyString(artifactId, 'artifactId');
    if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
      throw new ApiError('CONTRACT_INVALID', 'acceptance options must be an object');
    }
    rejectUnknownFields(opts, RECORD_ALLOWED_KEYS, 'acceptance');

    const verb = opts.decision;
    if (typeof verb !== 'string' || !(verb in DECISION_BY_VERB)) {
      throw new ApiError('CONTRACT_INVALID', 'decision must be accept|revise|reject', { field: 'decision' });
    }
    const decision = DECISION_BY_VERB[verb];

    const actor = opts.actor;
    if (typeof actor !== 'string' || actor.length === 0) {
      throw new ApiError('CONTRACT_INVALID', 'actor must be a non-empty string', { field: 'actor' });
    }
    if (actor.startsWith('agent:')) {
      // 用户验收 ≠ agent 自报成功（brief 裁决③）。
      throw new ApiError('FORBIDDEN', 'agent actors cannot record acceptances');
    }
    if (!actor.startsWith('user:')) {
      throw new ApiError('CONTRACT_INVALID', "actor must use the 'user:' principal namespace", { field: 'actor' });
    }

    const comment = opts.comment;
    if (decision === 'revision_requested' && (typeof comment !== 'string' || comment.length === 0)) {
      throw new ApiError('CONTRACT_INVALID', 'revise requires a non-empty comment', { field: 'comment' });
    }
    if (comment !== undefined && typeof comment !== 'string') {
      throw new ApiError('CONTRACT_INVALID', 'comment must be a string', { field: 'comment' });
    }

    let version;
    if (opts.version !== undefined) {
      if (!Number.isInteger(opts.version) || opts.version < 1) {
        throw new ApiError('CONTRACT_INVALID', 'version must be an integer >= 1', { field: 'version' });
      }
      version = opts.version;
    }

    const artifact = db.prepare(
      'SELECT * FROM w9_artifacts WHERE id = ? AND owner_id = ? AND deleted_at IS NULL',
    ).get(artifactId, ownerId);
    if (artifact == null) throw new ApiError('NOT_FOUND', 'artifact not found');

    const latestVersion = artifact.current_version;
    if (version !== undefined && version !== latestVersion) {
      throw new ApiError('CONFLICT', `acceptance must target the latest version (${latestVersion}), got ${version}`);
    }
    const boundVersion = version ?? latestVersion;

    if (artifact.status !== 'ready') {
      // 状态机：只有 ready 可验收；revision_requested 必须先产出新版本（README §状态机）。
      throw new ApiError('CONFLICT', `artifact status '${artifact.status}' is not acceptable (must be ready)`);
    }

    const id = idGen();
    const createdAt = clock.now(); // 每次 record 恰好一次时钟读数

    const wire = { id, artifactId, actor, decision };
    if (comment !== undefined) wire.comment = comment;
    wire.createdAt = createdAt;
    const check = validate(wire, ACCEPTANCE_SCHEMA, { schemaDir: CONTRACT_DIR });
    if (!check.valid) {
      throw new ApiError('CONTRACT_INVALID', 'acceptance fails acceptance.schema.json', { errors: check.errors });
    }

    withTransaction(db, () => {
      db.prepare(`
        INSERT INTO w9_acceptances
          (id, owner_id, artifact_id, artifact_version, mission_id, actor, decision, comment, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, ownerId, artifactId, boundVersion, artifact.mission_id, actor, decision,
        comment === undefined ? null : comment, createdAt);
      db.prepare('UPDATE w9_artifacts SET status = ?, updated_at = ? WHERE id = ? AND owner_id = ?')
        .run(decision, createdAt, artifactId, ownerId);
      db.prepare(`
        INSERT INTO w9_artifact_events (id, owner_id, artifact_id, type, payload_json, created_at)
        VALUES (?, ?, ?, 'status_changed', ?, ?)
      `).run(idGen(), ownerId, artifactId, JSON.stringify({
        from: artifact.status, to: decision, acceptanceId: id, artifactVersion: boundVersion, actor,
      }), createdAt);
    });

    sink.emit({
      type: 'acceptance.recorded', ownerId, objectType: 'acceptance', objectId: id, at: createdAt,
      data: { decision, artifactId, artifactVersion: boundVersion, actor },
    });
    return wire;
  }

  return { record };
}
