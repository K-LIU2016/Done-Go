const now = () => new Date().toISOString();
const json = value => JSON.stringify(value);
const parse = value => JSON.parse(value);
const rowMission = row => row ? ({
  id: row.id, ownerId: row.owner_id, revision: row.revision, schemaVersion: row.schema_version,
  blockId: row.block_id, goal: row.goal, state: row.state, autonomy: row.autonomy,
  scanId: row.scan_id, previewId: row.preview_id, contractId: row.contract_id, contractHash: row.contract_hash,
  blockedReason: row.blocked_reason, resumeState: row.resume_state, createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at,
}) : null;
export function createMissionStore(db) {
  return {
    saveMission(mission) {
      db.prepare(`INSERT INTO missions (id, owner_id, revision, schema_version, block_id, goal, state, autonomy, scan_id, preview_id, contract_id, contract_hash, blocked_reason, resume_state, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(mission.id, mission.ownerId, mission.revision, mission.schemaVersion, mission.blockId, mission.goal, mission.state, mission.autonomy, mission.scanId, mission.previewId, mission.contractId, mission.contractHash || null, mission.blockedReason || null, mission.resumeState || null, mission.createdAt, mission.updatedAt, mission.deletedAt || null);
      return { ok: true, mission };
    },
    getMission(ownerId, id) { return rowMission(db.prepare('SELECT * FROM missions WHERE owner_id = ? AND id = ? AND deleted_at IS NULL').get(ownerId, id)); },
    updateMission(mission, { ownerId, expectedRevision }) {
      const existing = this.getMission(ownerId, mission.id);
      if (!existing) return { ok: false, error: { code: 'NOT_FOUND' } };
      if (existing.revision !== expectedRevision) return { ok: false, error: { code: 'CONFLICT' } };
      db.prepare(`UPDATE missions SET revision=?, state=?, autonomy=?, scan_id=?, preview_id=?, contract_id=?, contract_hash=?, blocked_reason=?, resume_state=?, updated_at=?, deleted_at=? WHERE owner_id=? AND id=? AND revision=?`).run(mission.revision, mission.state, mission.autonomy, mission.scanId, mission.previewId, mission.contractId, mission.contractHash || null, mission.blockedReason || null, mission.resumeState || null, mission.updatedAt, mission.deletedAt || null, ownerId, mission.id, expectedRevision);
      return { ok: true, mission };
    },
    appendEvent(event) {
      try { db.prepare('INSERT INTO mission_events (owner_id, mission_id, event_id, revision, from_state, to_state, event_type, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(event.ownerId, event.missionId, event.eventId, event.revision || 1, event.from, event.to, event.type || 'transition', event.payload || '{}'); return { ok: true, duplicate: false }; }
      catch (error) { if (String(error.message).includes('UNIQUE')) return { ok: true, duplicate: true }; throw error; }
    },
    listEvents(ownerId, missionId) { return db.prepare('SELECT event_id AS eventId, revision, from_state, to_state, event_type AS type, payload_json AS payload FROM mission_events WHERE owner_id = ? AND mission_id = ? ORDER BY revision').all(ownerId, missionId).map(event => ({ eventId: event.eventId, revision: event.revision, from: event.from_state, to: event.to_state, type: event.type, payload: parse(event.payload) })); },
    rememberCommand(ownerId, commandId, result) {
      const existing = db.prepare('SELECT result_json FROM mission_idempotency WHERE owner_id=? AND command_id=?').get(ownerId, commandId);
      if (existing) {
        const previous = parse(existing.result_json);
        if (previous?.pending === true && result?.pending !== true) {
          db.prepare('UPDATE mission_idempotency SET result_json=? WHERE owner_id=? AND command_id=?').run(json(result), ownerId, commandId);
          return { duplicate: false };
        }
        return { duplicate: true, result: previous };
      }
      db.prepare('INSERT INTO mission_idempotency (owner_id, command_id, result_json) VALUES (?, ?, ?)').run(ownerId, commandId, json(result));
      return { duplicate: false };
    },
    saveGrant(grant) {
      db.prepare('INSERT INTO mission_grants (owner_id, id, revision, contract_hash, actor, capabilities_json, data_disclosure_json, expires_at, status, consumed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(grant.ownerId, grant.id, grant.revision, grant.contractHash, grant.actor, json(grant.capabilities), json(grant.dataDisclosure), grant.expiresAt, grant.status, grant.consumedAt || null, grant.createdAt || now(), grant.updatedAt || now());
      return { ok: true, grant };
    },
    getGrant(ownerId, id) {
      const row = db.prepare('SELECT * FROM mission_grants WHERE owner_id=? AND id=?').get(ownerId, id);
      return row && { ...row, ownerId: row.owner_id, contractHash: row.contract_hash, capabilities: parse(row.capabilities_json), dataDisclosure: parse(row.data_disclosure_json), expiresAt: row.expires_at, consumedAt: row.consumed_at, createdAt: row.created_at, updatedAt: row.updated_at };
    },
    invalidateGrants(ownerId, oldContractHash, updatedAt = now()) {
      const result = db.prepare("UPDATE mission_grants SET status='invalidated', revision=revision+1, updated_at=? WHERE owner_id=? AND contract_hash=? AND status IN ('proposed','active')").run(updatedAt, ownerId, oldContractHash);
      return { ok: true, count: result.changes };
    },
    now,
  };
}
