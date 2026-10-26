// 本机桥设备配置：只保存桥自身的 hub 地址、设备标识和设备令牌。
// 令牌文件按最小权限写入，不读取任何上游或网关密钥。
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_KEYS = ['hubUrl', 'deviceId', 'token', 'pairedAt'];

export function deviceConfigPath(configDir = join(homedir(), '.config', 'donego-bridge')) {
  return join(configDir, 'device.json');
}

export function saveDeviceConfig(configDir, config) {
  if (!configDir || !config || typeof config !== 'object') throw new TypeError('config is required');
  for (const key of CONFIG_KEYS) {
    if (!(key in config)) throw new TypeError(`config.${key} is required`);
  }
  const safe = Object.fromEntries(CONFIG_KEYS.map(key => [key, config[key]]));
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const path = deviceConfigPath(configDir);
  writeFileSync(path, `${JSON.stringify(safe)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function loadDeviceConfig(configDir = join(homedir(), '.config', 'donego-bridge')) {
  const path = deviceConfigPath(configDir);
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let value;
  try { value = JSON.parse(text); }
  catch { throw Object.assign(new Error('CONFIG_CORRUPT'), { code: 'CONFIG_CORRUPT' }); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || CONFIG_KEYS.some(key => !(key in value))
      || Object.keys(value).some(key => !CONFIG_KEYS.includes(key))) {
    throw Object.assign(new Error('CONFIG_CORRUPT'), { code: 'CONFIG_CORRUPT' });
  }
  return value;
}

export { CONFIG_KEYS };
