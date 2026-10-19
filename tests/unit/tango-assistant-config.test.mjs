import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const metadata = { provider: 'openai', url: 'https://api.openai-next.com/v1/chat/completions', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh', keyEnv: 'OPENAI_NEXT_API_KEY' };
const load = async options => (await import('../../scripts/assistant-config.mjs')).loadAssistantConfig(options);
async function fixture(value) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'tango-config-test-'));
  const directory = join(projectRoot, '.tango-donego'); await mkdir(directory);
  if (value !== undefined) await writeFile(join(directory, 'assistant.json'), typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
  return { projectRoot, directory };
}
function invalid(error) { return error.code === 'TANGO_AI_CONFIG_INVALID' && error.message === 'TANGO_AI_CONFIG_INVALID' && !('path' in error) && !('cause' in error); }

test('missing metadata returns undefined without reading unrelated environment configuration', async () => {
  const { projectRoot } = await fixture();
  assert.equal(await load({ projectRoot, env: { OPENAI_NEXT_API_KEY: 'fixture-token-not-real' } }), undefined);
});

test('safe BOM metadata resolves only its named virtual environment credential and leaves env unchanged', async () => {
  const { projectRoot } = await fixture('\uFEFF' + JSON.stringify(metadata));
  const env = { OPENAI_NEXT_API_KEY: 'fixture-token-not-real', UNRELATED: 'unchanged' }, before = { ...env };
  const config = await load({ projectRoot, env });
  assert.deepEqual(config, { provider: 'openai', url: metadata.url, model: 'gpt-6.1-sol', reasoningEffort: 'xhigh', key: 'fixture-token-not-real' });
  assert.deepEqual(env, before);
});

test('every explicit Tango environment variable selects the entire environment group without file fallback', async () => {
  const { projectRoot } = await fixture('{damaged metadata');
  const cases = [
    ['TANGO_AI_PROVIDER', 'openai', 'provider'], ['TANGO_AI_URL', metadata.url, 'url'],
    ['TANGO_AI_MODEL', 'gpt-6.1-sol', 'model'], ['TANGO_AI_KEY', 'fixture-token-not-real', 'key'],
    ['TANGO_AI_REASONING_EFFORT', 'xhigh', 'reasoningEffort'], ['TANGO_AI_KEY', '', 'key']
  ];
  for (const [name, value, field] of cases) {
    const config = await load({ projectRoot, env: { [name]: value, OPENAI_NEXT_API_KEY: 'must-not-fallback' } });
    assert.deepEqual(config, { provider: undefined, url: undefined, model: undefined, reasoningEffort: undefined, key: undefined, [field]: value });
  }
});

test('incomplete file metadata stays unavailable and never invents provider or credential defaults', async () => {
  for (const value of [{ model: 'gpt-6.1-sol' }, metadata]) {
    const { projectRoot } = await fixture(value);
    const config = await load({ projectRoot, env: {} });
    assert.equal(config.model, 'gpt-6.1-sol'); assert.equal(config.key, undefined);
    if (!value.provider) { assert.equal(config.provider, undefined); assert.equal(config.url, undefined); }
  }
});

test('unknown fields, unsupported credential files, unsafe URLs and environment selectors fail without raw details', async () => {
  const values = [
    { ...metadata, keyFile: 'not-supported' }, { ...metadata, unexpected: 'untrusted-body' },
    { ...metadata, url: 'https://user:pass@example.com/v1' }, { ...metadata, url: 'http://remote.example/v1' },
    { ...metadata, url: 'https://example.com/v1?token=untrusted-body' },
    { ...metadata, keyEnv: '../OTHER_CONFIG' }, { ...metadata, keyEnv: 'NAME\nBAD' },
    { ...metadata, reasoningEffort: 'invented' }, { ...metadata, model: {} }, [], null
  ];
  for (const value of values) { const { projectRoot } = await fixture(value); await assert.rejects(load({ projectRoot, env: {} }), invalid); }
  const { projectRoot } = await fixture('{untrusted-body');
  await assert.rejects(load({ projectRoot, env: {} }), invalid);
});

test('metadata reads are capped at 8192 bytes and reject invalid UTF-8', async () => {
  const json = JSON.stringify(metadata);
  const exact = await fixture(json + ' '.repeat(8192 - Buffer.byteLength(json)));
  assert.equal((await load({ projectRoot: exact.projectRoot, env: {} })).model, 'gpt-6.1-sol');
  for (const body of [json + ' '.repeat(8193 - Buffer.byteLength(json)), Buffer.from([0xff])]) {
    const { projectRoot } = await fixture(body); await assert.rejects(load({ projectRoot, env: {} }), invalid);
  }
});

test('nonregular metadata and linked private directories are rejected before reading targets', async () => {
  const dirFile = await fixture(); await mkdir(join(dirFile.directory, 'assistant.json'));
  await assert.rejects(load({ projectRoot: dirFile.projectRoot, env: {} }), invalid);
  const projectRoot = await mkdtemp(join(tmpdir(), 'tango-config-junction-test-'));
  const target = await fixture(metadata);
  await symlink(target.directory, join(projectRoot, '.tango-donego'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(load({ projectRoot, env: {} }), invalid);
});

test('hard-linked metadata cannot redirect loading to a second file', async () => {
  const { projectRoot, directory } = await fixture();
  const publicFixture = join(projectRoot, 'public-fixture.json'); await writeFile(publicFixture, JSON.stringify(metadata));
  await link(publicFixture, join(directory, 'assistant.json'));
  await assert.rejects(load({ projectRoot, env: {} }), invalid);
});

test('reasoning settings match the provider contract for both file metadata and explicit environment groups', async () => {
  for (const reasoningEffort of ['none', 'minimal', '']) {
    const { projectRoot } = await fixture({ ...metadata, reasoningEffort });
    await assert.rejects(load({ projectRoot, env: {} }), invalid);
    await assert.rejects(load({ projectRoot, env: { TANGO_AI_PROVIDER: 'openai', TANGO_AI_REASONING_EFFORT: reasoningEffort } }), invalid);
  }
  for (const reasoningEffort of ['low', 'medium', 'high', 'xhigh']) {
    const valid = await fixture({ ...metadata, reasoningEffort });
    assert.equal((await load({ projectRoot: valid.projectRoot, env: {} })).reasoningEffort, reasoningEffort);
    const unsupported = await fixture({ ...metadata, provider: 'anthropic', reasoningEffort });
    await assert.rejects(load({ projectRoot: unsupported.projectRoot, env: {} }), invalid);
    await assert.rejects(load({ projectRoot: unsupported.projectRoot, env: { TANGO_AI_PROVIDER: 'anthropic', TANGO_AI_REASONING_EFFORT: reasoningEffort } }), invalid);
  }
  const anthropic = { ...metadata, provider: 'anthropic' }; delete anthropic.reasoningEffort;
  const { projectRoot } = await fixture(anthropic);
  assert.equal((await load({ projectRoot, env: {} })).provider, 'anthropic');
});

test('URL control and whitespace rejection and credential NUL CRLF rejection retain their exact boundaries', async () => {
  for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127, 160, 0x2028, 0x3000]) {
    const url = 'https://example.com/a' + String.fromCharCode(code) + 'b';
    await assert.rejects(load({ env: { TANGO_AI_URL: url } }), invalid);
  }
  for (const code of [0, 10, 13]) await assert.rejects(load({ env: { TANGO_AI_KEY: 'fixture-token' + String.fromCharCode(code) } }), invalid);
  for (const code of [9, 31, 127]) {
    const value = 'fixture-token' + String.fromCharCode(code);
    assert.equal((await load({ env: { TANGO_AI_KEY: value } })).key, value);
  }
});
