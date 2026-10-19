import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const MAX_CONFIG_BYTES = 8192;
const FIELDS = ['provider', 'url', 'model', 'reasoningEffort', 'keyEnv'];
const ENV_FIELDS = { provider: 'TANGO_AI_PROVIDER', url: 'TANGO_AI_URL', model: 'TANGO_AI_MODEL', key: 'TANGO_AI_KEY', reasoningEffort: 'TANGO_AI_REASONING_EFFORT' };
function invalid() { return Object.assign(new Error('TANGO_AI_CONFIG_INVALID'), { code: 'TANGO_AI_CONFIG_INVALID' }); }
function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function unsafeUrlText(value) {
  if (/\s/.test(value)) return true;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
function validMetadata(value) {
  for (const name of ['provider', 'url', 'model', 'reasoningEffort']) if (value[name] !== undefined && typeof value[name] !== 'string') throw invalid();
  if (value.provider && !['openai', 'anthropic'].includes(value.provider)) throw invalid();
  if (value.model && !/^[a-z0-9._:/-]{1,100}$/i.test(value.model)) throw invalid();
  if (value.reasoningEffort !== undefined && (!['low', 'medium', 'high', 'xhigh'].includes(value.reasoningEffort) || value.provider === 'anthropic')) throw invalid();
  if (value.url) {
    if (value.url.length > 500 || unsafeUrlText(value.url)) throw invalid();
    let url; try { url = new URL(value.url); } catch { throw invalid(); }
    if (url.username || url.password || url.search || url.hash || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw invalid();
  }
  return value;
}
function credential(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_CONFIG_BYTES || value.includes('\0') || value.includes('\r') || value.includes('\n')) throw invalid();
  return value;
}

async function readMetadata(projectRoot) {
  if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot) || projectRoot.includes('\u0000')) throw invalid();
  const root = await lstat(projectRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) throw invalid();
  const directory = join(projectRoot, '.tango-donego'), path = join(directory, 'assistant.json');
  const parent = await lstat(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw invalid();
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_CONFIG_BYTES) throw invalid();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const opened = await handle.stat(), currentParent = await lstat(directory);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > MAX_CONFIG_BYTES || !sameFile(before, opened) || !sameFile(parent, currentParent) || currentParent.isSymbolicLink()) throw invalid();
    const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1); let size = 0;
    while (size < bytes.length) {
      const chunk = await handle.read(bytes, size, bytes.length - size, size);
      if (!chunk.bytesRead) break;
      size += chunk.bytesRead;
    }
    if (size > MAX_CONFIG_BYTES) throw invalid();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
  } finally { await handle.close(); }
}

export async function loadAssistantConfig({ projectRoot, env = process.env } = {}) {
  try {
    if (!record(env)) throw invalid();
    if (Object.values(ENV_FIELDS).some(name => env[name] !== undefined)) {
      const explicit = {};
      for (const [field, name] of Object.entries(ENV_FIELDS)) explicit[field] = env[name];
      validMetadata(explicit); explicit.key = credential(explicit.key);
      return explicit;
    }
    let metadata;
    try { metadata = await readMetadata(projectRoot); } catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
    if (!record(metadata) || Object.keys(metadata).some(name => !FIELDS.includes(name))) throw invalid();
    validMetadata(metadata);
    if (metadata.keyEnv !== undefined && (typeof metadata.keyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(metadata.keyEnv))) throw invalid();
    return { provider: metadata.provider, url: metadata.url, model: metadata.model, reasoningEffort: metadata.reasoningEffort, key: metadata.keyEnv === undefined ? undefined : credential(env[metadata.keyEnv]) };
  } catch { throw invalid(); }
}
