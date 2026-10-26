import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_PATH = ['.config', 'llm-gateway', 'endpoint.json'];

function missingGatewayKey() {
  const error = new Error('GATEWAY_KEY_MISSING');
  error.code = 'GATEWAY_KEY_MISSING';
  return error;
}

/**
 * Read the Done-Go gateway key for the current process.
 *
 * The endpoint file is deliberately read on every call: callers can rotate the
 * local gateway configuration without restarting this process, and no secret
 * is retained in module state.
 */
export function gatewayKey() {
  const home = process.env.HOME || homedir();
  const configPath = join(home, ...CONFIG_PATH);

  try {
    const endpoint = JSON.parse(readFileSync(configPath, 'utf8'));
    const key = endpoint?.keys?.donego;
    if (typeof key !== 'string' || key.trim() === '') throw missingGatewayKey();
    return key;
  } catch (error) {
    if (error?.code === 'GATEWAY_KEY_MISSING') throw error;
    throw missingGatewayKey();
  }
}
