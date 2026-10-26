// 本机桥配对码：一次性、短时有效，只把摘要写入数据库。
// 配对码属于登录材料；明文仅在签发返回值中短暂存在，不进入日志或持久化层。
import { createHash, randomBytes } from 'node:crypto';

const PAIRING_TTL_MS = 10 * 60_000; // 人工输入码的最长有效期。
const CODE_BYTES = 9; // 72 bits，足够抵抗在线猜测且仍便于输入。

const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
const makeCode = () => randomBytes(CODE_BYTES).toString('hex').slice(0, 12);

export function createPairingService({ db, now = () => Date.now(), randomCode = makeCode } = {}) {
  if (!db) throw new TypeError('db is required');

  function issuePairingCode(ownerId) {
    if (typeof ownerId !== 'string' || !ownerId) throw new TypeError('ownerId is required');
    const expiresAt = now() + PAIRING_TTL_MS;
    let code;
    let hash;
    do {
      code = randomCode();
      if (typeof code !== 'string' || !/^[A-Za-z0-9]{6,}$/.test(code)) throw new TypeError('randomCode must return an alphanumeric code');
      hash = digest(code);
    } while (db.prepare('SELECT 1 FROM bridge_pairings WHERE code_hash = ?').get(hash));
    db.prepare('INSERT INTO bridge_pairings (code_hash, owner_id, expires_at, used_at) VALUES (?, ?, ?, NULL)')
      .run(hash, ownerId, expiresAt);
    return { code, expiresAt };
  }

  function consumePairingCode(code) {
    if (typeof code !== 'string' || !code) return { ok: false, code: 'PAIRING_CODE_UNKNOWN' };
    const row = db.prepare('SELECT code_hash, owner_id, expires_at, used_at FROM bridge_pairings WHERE code_hash = ?')
      .get(digest(code));
    if (!row) return { ok: false, code: 'PAIRING_CODE_UNKNOWN' };
    if (row.used_at != null) return { ok: false, code: 'PAIRING_CODE_USED' };
    if (now() >= row.expires_at) return { ok: false, code: 'PAIRING_CODE_EXPIRED' };
    const changed = db.prepare('UPDATE bridge_pairings SET used_at = ? WHERE code_hash = ? AND used_at IS NULL')
      .run(now(), row.code_hash);
    if (changed.changes !== 1) return { ok: false, code: 'PAIRING_CODE_USED' };
    return { ok: true, ownerId: row.owner_id };
  }

  return { issuePairingCode, consumePairingCode };
}

export { PAIRING_TTL_MS };
