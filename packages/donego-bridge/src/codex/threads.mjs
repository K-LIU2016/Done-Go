// Codex Mission thread 注册表：把一个 Mission 绑定到唯一的 App Server thread。
// 该层不持久化状态；持久化和恢复由上层 runtime 负责。

export function createThreadRegistry() {
  const entries = new Map();

  function set(missionId, entry) {
    if (typeof missionId !== 'string' || !missionId) throw new TypeError('missionId is required');
    if (!entry || typeof entry.threadId !== 'string' || !entry.threadId) {
      throw new TypeError('threadId is required');
    }
    entries.set(missionId, { ...entry });
    return entries.get(missionId);
  }

  function get(missionId) {
    return entries.get(missionId) ?? null;
  }

  function require(missionId) {
    const entry = get(missionId);
    if (!entry) throw new Error(`MISSION_NOT_FOUND: ${missionId}`);
    return entry;
  }

  function remove(missionId) {
    return entries.delete(missionId);
  }

  function values() {
    return [...entries.values()].map(entry => ({ ...entry }));
  }

  return Object.freeze({ set, get, require, remove, values });
}
