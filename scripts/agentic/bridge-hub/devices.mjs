// 本机桥设备注册表：令牌只在签发时返回，数据库仅保存不可逆摘要。
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const TOKEN_BYTES = 32; // 256 bits，base64url 编码至少 43 字符。
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
const tokenFor = () => randomBytes(TOKEN_BYTES).toString('base64url');

export function createDeviceRegistry({ db, now = () => Date.now(), randomToken = tokenFor, id = randomUUID } = {}) {
  if (!db) throw new TypeError('db is required');

  function issueDeviceToken(ownerId, label = '') {
    if (typeof ownerId !== 'string' || !ownerId) throw new TypeError('ownerId is required');
    const token = randomToken();
    if (typeof token !== 'string' || token.length < 43) throw new TypeError('randomToken must return a 256-bit token');
    const deviceId = id();
    db.prepare(`INSERT INTO bridge_devices
      (device_id, owner_id, label, token_hash, created_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, NULL)`)
      .run(deviceId, ownerId, typeof label === 'string' ? label.slice(0, 200) : '', digest(token), now());
    return { deviceId, token };
  }

  function resolveToken(token) {
    if (typeof token !== 'string' || !token) return null;
    const row = db.prepare(`SELECT device_id, owner_id, label, created_at
      FROM bridge_devices WHERE token_hash = ? AND revoked_at IS NULL`).get(digest(token));
    if (!row) return null;
    return { deviceId: row.device_id, ownerId: row.owner_id, label: row.label, createdAt: row.created_at };
  }

  function revokeDevice(deviceId, ownerId = null) {
    if (typeof deviceId !== 'string' || !deviceId) return false;
    const query = ownerId == null
      ? 'UPDATE bridge_devices SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL'
      : 'UPDATE bridge_devices SET revoked_at = ? WHERE device_id = ? AND owner_id = ? AND revoked_at IS NULL';
    const result = ownerId == null
      ? db.prepare(query).run(now(), deviceId)
      : db.prepare(query).run(now(), deviceId, ownerId);
    return result.changes === 1;
  }

  function listDevices(ownerId) {
    if (typeof ownerId !== 'string' || !ownerId) return [];
    return db.prepare(`SELECT device_id, owner_id, label, created_at, revoked_at
      FROM bridge_devices WHERE owner_id = ? ORDER BY created_at, device_id`).all(ownerId)
      .map(row => ({ deviceId: row.device_id, ownerId: row.owner_id, label: row.label,
        createdAt: row.created_at, revoked: row.revoked_at != null, revokedAt: row.revoked_at }));
  }

  return { issueDeviceToken, resolveToken, revokeDevice, listDevices };
}
