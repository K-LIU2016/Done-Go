import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';

function get(port, path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject); req.end();
  });
}

test('status reports local release identity without exposing environment and rejects foreign origins', async t => {
  const service = await import('../../scripts/serve-tango.mjs');
  assert.equal(typeof service.createTangoServer, 'function');
  const server = service.createTangoServer({ speechCapabilities: async () => ({ available: false, languages: [], secret: 'do-not-export' }) });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const response = await get(port, '/api/status');
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  const status = JSON.parse(response.body);
  assert.equal(status.status, 'ok');
  assert.equal(status.runtime, 'web-local');
  assert.match(status.version, /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/i);
  assert.deepEqual(status.speech, { available: false, languages: [] });
  assert.equal(response.body.includes('do-not-export'), false);
  const rejected = await get(port, '/api/status', { Origin: 'https://evil.example' });
  assert.equal(rejected.status, 403);
  assert.equal(JSON.parse(rejected.body).code, 'TANGO_ORIGIN_REJECTED');
  const foreignHost = await get(port, '/api/status', { Host: 'evil.example:' + port });
  assert.equal(foreignHost.status, 403);
  const method = await get(port, '/api/status', {}, 'POST');
  assert.equal(method.status, 405);
  assert.equal(JSON.parse(method.body).code, 'TANGO_METHOD_REJECTED');
  const invalidAudio = await get(port, '/api/speech/transcribe', { Origin: 'http://127.0.0.1:' + port }, 'POST');
  assert.equal(invalidAudio.status, 415);
  assert.equal(JSON.parse(invalidAudio.body).code, 'TANGO_AUDIO_WAV_REQUIRED');
});

test('capability failures have a stable service error without exposing native details', async t => {
  const { createTangoServer } = await import('../../scripts/serve-tango.mjs');
  const server = createTangoServer({ speechCapabilities: async () => { throw new Error('private native path'); } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const response = await get(server.address().port, '/api/status');
  assert.equal(response.status, 503);
  assert.deepEqual(JSON.parse(response.body), { error: 'service-unavailable', code: 'TANGO_SERVICE_UNAVAILABLE' });
});
