// S2D-W2 policy engine: immutable system prohibitions, grants, decisions and audit.
import { randomUUID } from 'node:crypto';
import { contractHash } from './hash.mjs';
export const SYSTEM_WONT = ['不付款下单', '不以你的名义对外发送（除非逐次确认）', '不读取凭据', '不访问未授权来源', '不在自己的时间打扰', '不删除你的文件'];
const json = (v) => JSON.stringify(v ?? {});
const parse = (v, fallback = {}) => { try { return v == null ? fallback : JSON.parse(v); } catch { return fallback; } };
const rank = (a) => Number(String(a || 'A0').slice(1));
const err = (code) => Object.assign(new Error(code), { code });
function scopeAllows(scope, resource) {
  if (typeof resource !== 'string') return false;
  const folders = scope?.folders || scope?.paths || scope?.resources || [];
  return folders.length > 0 && folders.some((folder) => {
    if (typeof folder !== 'string') return false;
    const root = folder.replace(/\/$/, '');
    return resource === root || resource.startsWith(`${root}/`);
  });
}
function disclosed(disclosure, classes) {
  const allowed = new Set((disclosure || []).map((d) => typeof d === 'string' ? d : d.dataClass));
  return classes.every((value) => allowed.has(value));
}
function systemWontHit(action) {
  const text = [action?.key, action?.capability, action?.resource, action?.description, action?.reason]
    .filter(Boolean).join(' ').toLowerCase();
  return /payment|付款|下单|credential|password|secret|token|凭据|未授权|unauthori[sz]ed|delete|删除|disturb|打扰|send|发送/.test(text);
}
export function createPolicyEngine({ db, now = () => new Date().toISOString() } = {}) {
  if (!db) throw new TypeError('POLICY_DB_REQUIRED');
  const getGrant = (id) => db.prepare('SELECT * FROM grants WHERE id=?').get(id);
  const mapGrant = (row) => row && ({
    ...row,
    capabilities: parse(row.capabilities, []),
    scope: parse(row.scope, {}),
    dataDisclosure: parse(row.data_disclosure ?? row.dataDisclosure, []),
  });
  const audit = ({ grant, action, outcome, externalId = null, ownerId = null, contractHash: hash = null }) => {
    db.prepare(`INSERT INTO audit(id,owner_id,actor,grant_id,action,contract_hash,outcome,external_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(randomUUID(), ownerId ?? grant?.owner_id ?? null, grant?.actor ?? null, grant?.id ?? grant?.grant_id ?? null, action, hash ?? grant?.contract_hash ?? null, outcome, externalId, now());
  };
  const normalizeContract = async (input) => {
    const contract = structuredClone(input);
    if (!['A1', 'A2', 'A3'].includes(contract.autonomy)) throw err('AUTONOMY_OUT_OF_CONTRACT');
    if ((contract.will || []).some((item) => SYSTEM_WONT.includes(item))) throw err('SYSTEM_WONT_IMMUTABLE');
    contract.wont = [...new Set([...(contract.wont || []), ...SYSTEM_WONT])];
    delete contract.hash;
    const hash = contractHash(contract); contract.hash = hash;
    return { contract, hash };
  };
  const grantIssue = async (spec) => {
    const id = randomUUID(); const row = { ...spec, id, status: 'proposed', consumedAt: null, updatedAt: now() };
    db.prepare(`INSERT INTO grants(id,owner_id,actor,contract_hash,capabilities,scope,data_disclosure,expires_at,status,consumed_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,'proposed',NULL,?)`).run(id, spec.ownerId, spec.actor, spec.contractHash, json(spec.capabilities || []), json(spec.scope || {}), json(spec.dataDisclosure || []), spec.expiresAt, row.updatedAt);
    audit({ grant: { ...row, owner_id: spec.ownerId, contract_hash: spec.contractHash }, action: 'grant.issue', outcome: 'allow' }); return mapGrant(getGrant(id));
  };
  const transition = async (id, from, to, action, extra = {}) => {
    const grant = getGrant(id); if (!grant || (from && grant.status !== from)) throw err(`GRANT_${String(grant?.status || 'NOT_FOUND').toUpperCase()}`);
    const result = db.prepare('UPDATE grants SET status=?, consumed_at=?, updated_at=? WHERE id=?').run(to, extra.consumedAt ?? grant.consumed_at, now(), id);
    if (!result.changes) throw err('GRANT_NOT_FOUND'); audit({ grant: { ...grant, id }, action, outcome: 'allow', externalId: extra.externalId }); return mapGrant(getGrant(id));
  };
  const grantActivate = (id) => transition(id, 'proposed', 'active', 'grant.activate');
  const grantConsume = async (id, { externalId = null } = {}) => {
    const current = getGrant(id);
    if (current?.status === 'consumed') throw err('GRANT_ALREADY_CONSUMED');
    return transition(id, 'active', 'consumed', 'grant.consume', { consumedAt: now(), externalId });
  };
  const grantRevoke = (id) => transition(id, 'active', 'revoked', 'grant.revoke');
  const grantInvalidateForContract = async (hash) => {
    const rows = db.prepare("SELECT * FROM grants WHERE status IN ('proposed','active')").all();
    for (const row of rows) { db.prepare("UPDATE grants SET status='invalidated',updated_at=? WHERE id=?").run(now(), row.id); audit({ grant: row, action: 'grant.invalidate', outcome: 'allow' }); }
  };
  const decide = async ({ action, grant: supplied, contract, spent = {}, estimate = {}, now: at = now() }) => {
    let grant = mapGrant(supplied); if (!grant?.id) return { allow: false, reason: 'GRANT_NOT_ACTIVE' };
    const stored = getGrant(grant.id); grant = mapGrant(stored);
    const deny = (reason, need = null) => { audit({ grant, action: 'decide', outcome: 'deny', contractHash: contract?.hash }); return { allow: false, reason, ...(need ? { need } : {}) }; };
    if (grant.contract_hash !== contract.hash && grant.status === 'proposed') {
      db.prepare("UPDATE grants SET status='invalidated',updated_at=? WHERE id=?").run(now(), grant.id);
      audit({ grant, action: 'grant.invalidate', outcome: 'deny' });
      return deny('GRANT_INVALIDATED');
    }
    if (grant.status === 'proposed') return deny('GRANT_NOT_ACTIVE');
    if (grant.status === 'consumed') return deny('GRANT_CONSUMED');
    if (grant.status === 'revoked') return deny('GRANT_REVOKED');
    if (grant.status === 'invalidated') return deny('GRANT_INVALIDATED');
    if (grant.expires_at && Date.parse(at) >= Date.parse(grant.expires_at)) { db.prepare("UPDATE grants SET status='expired',updated_at=? WHERE id=?").run(now(), grant.id); audit({ grant, action: 'grant.expire', outcome: 'deny' }); return deny('GRANT_EXPIRED'); }
    if (grant.contract_hash !== contract.hash) {
      db.prepare("UPDATE grants SET status='invalidated',updated_at=? WHERE id=?").run(now(), grant.id);
      audit({ grant, action: 'grant.invalidate', outcome: 'deny' });
      return deny('GRANT_INVALIDATED');
    }
    if (systemWontHit(action)) return deny('SYSTEM_WONT');
    if (action.autonomy === 'A5') return deny('A5_NEVER_AUTO');
    if (action.autonomy === 'A4') return deny('A4_REQUIRES_CONFIRMATION', { type: 'confirmation', action, reason: 'A4_REQUIRES_CONFIRMATION' });
    if (rank(action.autonomy) > rank(contract.autonomy)) return deny('AUTONOMY_EXCEEDED');
    if (!grant.capabilities.includes(action.capability)) return deny('CAPABILITY_NOT_GRANTED');
    if (!scopeAllows(grant.scope, action.resource)) return deny('RESOURCE_OUT_OF_SCOPE');
    const classes = action.dataClasses || (action.dataClass ? [action.dataClass] : []);
    if (!disclosed(contract.dataDisclosure, classes) || !disclosed(grant.dataDisclosure, classes)) return deny('DATA_CLASS_NOT_DISCLOSED');
    const window = contract.window;
    if (window && (Date.parse(at) < Date.parse(window.prepStart) || Date.parse(at) > Date.parse(window.end))) return deny('OUT_OF_WINDOW');
    const budget = contract.budget || {};
    for (const key of Object.keys({ ...spent, ...estimate })) if (budget[key] != null && Number(spent[key] || 0) + Number(estimate[key] || 0) > Number(budget[key])) return deny('BUDGET_EXCEEDED');
    audit({ grant, action: 'decide', outcome: 'allow', contractHash: contract.hash }); return { allow: true, reason: 'ALLOWED' };
  };
  return { normalizeContract, decide, grantIssue, grantActivate, grantConsume, grantRevoke, grantInvalidateForContract, getGrant: (id) => mapGrant(getGrant(id)), listAudit: ({ ownerId, grantId } = {}) => { const clauses = []; const args = []; if (ownerId) { clauses.push('owner_id=?'); args.push(ownerId); } if (grantId) { clauses.push('grant_id=?'); args.push(grantId); } const sql = `SELECT * FROM audit${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at, id`; return db.prepare(sql).all(...args); } };
}
