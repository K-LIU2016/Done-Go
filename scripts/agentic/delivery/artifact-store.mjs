// W9 M1 delivery-domain · A11 artifact-store（brief 裁决②：append-only 版本链）
//
// createArtifactStore({ db, clock, idGen, events }) → { put, get, list, versions, delete }
//   - put(ownerId, payload)：不带 artifactId → 新工件 v1；带 artifactId → 追加版本（服务端 max+1）。
//     与当前最新版本内容完全相同的重复 put 幂等返回既有版本，不新增版本行。
//   - 身份字段（id/version/createdAt/ownerId/source/hash）一律服务端生成，客户端提交即 CONTRACT_INVALID。
//   - 跨 owner 读写一律 NOT_FOUND（README §owner 隔离：不泄露对象存在性）。
//   - accepted/rejected 工件关闭版本链（CONFLICT）；删除是软删：只写状态事件行，版本链完整保留。
//   - clock/idGen 强制注入；每次 put 恰好消费一次 clock.now()（确定性时钟，W4 教训）。
import { loadSchema, validate, contractHash } from '../contracts.mjs';
import {
  ApiError, CONTRACT_DIR, NOOP_EVENTS, assertNonEmptyString, rejectServerOwnedFields,
  rejectUnknownFields, requireInjectables, withTransaction,
} from './util.mjs';

const ARTIFACT_SCHEMA = loadSchema('artifact.schema.json', CONTRACT_DIR);
const EVIDENCE_SCHEMA = loadSchema('evidence.schema.json', CONTRACT_DIR);

const CLIENT_ALLOWED_KEYS = ['missionId', 'type', 'title', 'location', 'status', 'evidence', 'artifactId'];
const SERVER_OWNED_KEYS = ['id', 'version', 'createdAt', 'ownerId', 'source', 'hash'];
const CLIENT_STATUSES = ['generating', 'ready'];
/** 验收终结态：版本链关闭，新 put 一律 CONFLICT。 */
const VERSION_CHAIN_CLOSED_STATUSES = ['accepted', 'rejected'];

function loadArtifactRow(db, ownerId, artifactId) {
  // DatabaseSync.get() 无匹配时返回 undefined；统一归一为 null。
  return db.prepare(
    'SELECT * FROM w9_artifacts WHERE id = ? AND owner_id = ? AND deleted_at IS NULL',
  ).get(artifactId, ownerId) ?? null;
}

function versionRowToWire(row, artifactStatus) {
  const artifact = {
    id: row.artifact_id,
    ownerId: row.owner_id,
    missionId: row.mission_id,
    version: row.version,
    type: row.type,
    // status 是工件级生命周期状态（README §状态机：ready → accepted|revision_requested|rejected
    // 由用户验收驱动），版本行只保存提交时的内容状态；对外对象一律反映工件级状态。
    status: artifactStatus ?? row.status,
    title: row.title,
    location: row.location,
    source: row.source,
    createdAt: row.created_at,
  };
  if (row.evidence_json !== null && row.evidence_json !== undefined) {
    artifact.evidence = JSON.parse(row.evidence_json);
  }
  return artifact;
}

function insertVersion(db, { artifactId, ownerId, version, content, contentHash, createdAt }) {
  db.prepare(`
    INSERT INTO w9_artifact_versions
      (artifact_id, owner_id, version, mission_id, type, title, status, location, source,
       content_hash, evidence_json, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    artifactId, ownerId, version, content.missionId, content.type, content.title,
    content.status, content.location, content.source, contentHash,
    content.evidence === undefined ? null : JSON.stringify(content.evidence),
    createdAt, ownerId,
  );
}

export function createArtifactStore({ db, clock, idGen, events = NOOP_EVENTS }) {
  requireInjectables('createArtifactStore', { db, clock, idGen }, ['db', 'clock', 'idGen']);
  const sink = events ?? NOOP_EVENTS;

  async function put(ownerId, payload) {
    assertNonEmptyString(ownerId, 'ownerId');
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new ApiError('CONTRACT_INVALID', 'artifact payload must be a JSON object');
    }
    rejectServerOwnedFields(payload, SERVER_OWNED_KEYS, 'artifact');
    rejectUnknownFields(payload, CLIENT_ALLOWED_KEYS, 'artifact');

    const artifactId = payload.artifactId === undefined ? undefined : payload.artifactId;
    if (artifactId !== undefined) assertNonEmptyString(artifactId, 'artifactId');

    const status = payload.status === undefined ? 'generating' : payload.status;
    if (!CLIENT_STATUSES.includes(status)) {
      // accepted/revision_requested/rejected 属于验收状态机，只能由用户验收产生（brief 裁决③）。
      throw new ApiError('CONTRACT_INVALID', 'status must be generating|ready when submitted by client', {
        field: 'status',
        allowed: CLIENT_STATUSES,
      });
    }

    const evidence = payload.evidence === undefined ? undefined : payload.evidence;
    if (evidence !== undefined) {
      if (!Array.isArray(evidence)) {
        throw new ApiError('CONTRACT_INVALID', 'evidence must be an array', { field: 'evidence' });
      }
      for (const [index, item] of evidence.entries()) {
        const result = validate(item, EVIDENCE_SCHEMA, { schemaDir: CONTRACT_DIR });
        if (!result.valid) {
          throw new ApiError('CONTRACT_INVALID', `evidence[${index}] fails evidence.schema.json`, {
            field: `evidence[${index}]`,
            errors: result.errors,
          });
        }
      }
    }

    // 内容身份只覆盖客户端可控内容；同一内容跨工件 hash 相同（测试钉死）。
    const contentPayload = { missionId: payload.missionId, type: payload.type, title: payload.title, location: payload.location, status };
    if (evidence !== undefined) contentPayload.evidence = evidence;
    const contentHash = await contractHash(contentPayload);

    const existing = artifactId === undefined ? null : loadArtifactRow(db, ownerId, artifactId);
    if (artifactId !== undefined && existing === null) {
      // 不存在 / 已软删 / 跨 owner：统一 NOT_FOUND，不泄露存在性。
      throw new ApiError('NOT_FOUND', 'artifact not found');
    }
    if (existing !== null && VERSION_CHAIN_CLOSED_STATUSES.includes(existing.status)) {
      throw new ApiError('CONFLICT', `artifact version chain is closed by acceptance (${existing.status})`);
    }

    if (existing !== null) {
      const latest = db.prepare(
        'SELECT * FROM w9_artifact_versions WHERE artifact_id = ? ORDER BY version DESC LIMIT 1',
      ).get(artifactId);
      if (latest !== undefined && latest.content_hash === contentHash) {
        // 幂等：同内容重复提交返回既有最新版本，不新增版本行、不回退版本。
        return versionRowToWire(latest, existing.status);
      }
    }

    const id = artifactId ?? idGen();
    const version = existing === null
      ? 1
      : db.prepare('SELECT COALESCE(MAX(version), 0) AS max FROM w9_artifact_versions WHERE artifact_id = ?')
        .get(artifactId).max + 1;
    const createdAt = clock.now(); // 每次 put 恰好一次时钟读数
    const content = {
      missionId: payload.missionId, type: payload.type, title: payload.title,
      location: payload.location, status, source: 'real', evidence,
    };

    const wire = {
      id, ownerId, missionId: content.missionId, version, type: content.type,
      status: content.status, title: content.title, location: content.location,
      source: content.source, createdAt,
    };
    if (evidence !== undefined) wire.evidence = evidence;
    const check = validate(wire, ARTIFACT_SCHEMA, { schemaDir: CONTRACT_DIR });
    if (!check.valid) {
      throw new ApiError('CONTRACT_INVALID', 'artifact fails artifact.schema.json', {
        errors: check.errors,
      });
    }

    withTransaction(db, () => {
      if (existing === null) {
        db.prepare(`
          INSERT INTO w9_artifacts
            (id, owner_id, mission_id, current_version, title, type, status, location, source, created_at, updated_at, deleted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        `).run(id, ownerId, content.missionId, version, content.title, content.type,
          content.status, content.location, content.source, createdAt, createdAt);
      } else {
        db.prepare(`
          UPDATE w9_artifacts
          SET current_version = ?, mission_id = ?, title = ?, type = ?, status = ?, location = ?, updated_at = ?
          WHERE id = ? AND owner_id = ?
        `).run(version, content.missionId, content.title, content.type, content.status,
          content.location, createdAt, artifactId, ownerId);
      }
      insertVersion(db, {
        artifactId: id, ownerId, version, content, contentHash, createdAt,
      });
    });

    sink.emit({
      type: existing === null ? 'artifact.created' : 'artifact.versioned',
      ownerId, objectType: 'artifact', objectId: id, at: createdAt,
      data: { version, status: content.status, missionId: content.missionId },
    });
    return wire;
  }

  async function get(ownerId, artifactId, options = {}) {
    assertNonEmptyString(ownerId, 'ownerId');
    assertNonEmptyString(artifactId, 'artifactId');
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new ApiError('CONTRACT_INVALID', 'options must be an object');
    }
    let version;
    if (options.version !== undefined) {
      if (!Number.isInteger(options.version) || options.version < 1) {
        throw new ApiError('CONTRACT_INVALID', 'version must be an integer >= 1', { field: 'version' });
      }
      version = options.version;
    }
    const artifact = loadArtifactRow(db, ownerId, artifactId);
    if (artifact === null) throw new ApiError('NOT_FOUND', 'artifact not found');
    const target = version ?? artifact.current_version;
    const row = db.prepare(
      'SELECT * FROM w9_artifact_versions WHERE artifact_id = ? AND version = ?',
    ).get(artifactId, target);
    if (row === undefined) throw new ApiError('NOT_FOUND', 'artifact version not found');
    return versionRowToWire(row, artifact.status);
  }

  async function list(ownerId, options = {}) {
    assertNonEmptyString(ownerId, 'ownerId');
    const missionId = options?.missionId;
    if (missionId !== undefined) assertNonEmptyString(missionId, 'missionId');
    const rows = missionId === undefined
      ? db.prepare('SELECT * FROM w9_artifacts WHERE owner_id = ? AND deleted_at IS NULL ORDER BY created_at, id')
        .all(ownerId)
      : db.prepare('SELECT * FROM w9_artifacts WHERE owner_id = ? AND mission_id = ? AND deleted_at IS NULL ORDER BY created_at, id')
        .all(ownerId, missionId);
    const byVersion = db.prepare('SELECT * FROM w9_artifact_versions WHERE artifact_id = ? AND version = ?');
    return rows.map((row) => {
      const versionRow = byVersion.get(row.id, row.current_version);
      if (versionRow === undefined) {
        throw new ApiError('INTERNAL_ERROR', `artifact ${row.id} is missing its current version row`);
      }
      return versionRowToWire(versionRow, row.status);
    });
  }

  async function versions(ownerId, artifactId) {
    assertNonEmptyString(ownerId, 'ownerId');
    assertNonEmptyString(artifactId, 'artifactId');
    const artifact = loadArtifactRow(db, ownerId, artifactId);
    if (artifact === null) throw new ApiError('NOT_FOUND', 'artifact not found');
    const rows = db.prepare(
      'SELECT * FROM w9_artifact_versions WHERE artifact_id = ? ORDER BY version',
    ).all(artifactId);
    return rows.map((row) => versionRowToWire(row, artifact.status));
  }

  async function deleteArtifact(ownerId, artifactId) {
    assertNonEmptyString(ownerId, 'ownerId');
    assertNonEmptyString(artifactId, 'artifactId');
    const artifact = loadArtifactRow(db, ownerId, artifactId);
    if (artifact === null) throw new ApiError('NOT_FOUND', 'artifact not found');
    const at = clock.now();
    const eventId = idGen();
    withTransaction(db, () => {
      // 软删：不抹版本链、不改历史行，只置 deleted_at 并追加状态事件（brief 裁决②）。
      db.prepare('UPDATE w9_artifacts SET deleted_at = ?, updated_at = ? WHERE id = ? AND owner_id = ?')
        .run(at, at, artifactId, ownerId);
      db.prepare(`
        INSERT INTO w9_artifact_events (id, owner_id, artifact_id, type, payload_json, created_at)
        VALUES (?, ?, ?, 'deleted', ?, ?)
      `).run(eventId, ownerId, artifactId, JSON.stringify({ previousStatus: artifact.status }), at);
    });
    sink.emit({
      type: 'artifact.deleted', ownerId, objectType: 'artifact', objectId: artifactId, at,
      data: { previousStatus: artifact.status },
    });
    return { id: artifactId, deletedAt: at };
  }

  return { put, get, list, versions, delete: deleteArtifact };
}
