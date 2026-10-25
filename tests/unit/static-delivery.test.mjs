import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';
import { gunzipSync } from 'node:zlib';

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
}

test('static pages are gzip-compressed when accepted, revalidated by ETag, and plain otherwise', async t => {
  const { createTangoServer } = await import('../../scripts/serve-tango.mjs');
  const server = createTangoServer({ speechCapabilities: async () => ({ available: false, languages: [] }) });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const plain = await get(port, '/');
  assert.equal(plain.status, 200);
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.headers['cache-control'], 'no-cache');
  assert.ok(plain.headers.etag);

  const zipped = await get(port, '/', { 'Accept-Encoding': 'gzip, br' });
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.equal(zipped.headers.vary, 'Accept-Encoding');
  assert.ok(zipped.body.length < plain.body.length / 2);
  assert.deepEqual(gunzipSync(zipped.body), plain.body);

  const again = await get(port, '/', { 'If-None-Match': plain.headers.etag });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);

  const missing = await get(port, '/no-such-file.js');
  assert.equal(missing.status, 404);
});
