import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createTangoServer } from '../../scripts/serve-tango.mjs';

const get = (port, path, headers) => new Promise((resolve, reject) => {
  request({ host: '127.0.0.1', port, path, headers }, res => { const parts = []; res.on('data', p => parts.push(p)); res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(parts) })); }).on('error', reject).end();
});

test('text assets are gzipped when the client accepts it, and served raw otherwise', async t => {
  const server = createTangoServer({});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const { port } = server.address();
  const original = await readFile(new URL('../../web/index.html', import.meta.url));
  const zipped = await get(port, '/', { 'accept-encoding': 'gzip, br' });
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.ok(zipped.body.length < original.length / 2);
  assert.deepEqual(gunzipSync(zipped.body), original);
  const raw = await get(port, '/', {});
  assert.equal(raw.headers['content-encoding'], undefined);
  assert.deepEqual(raw.body, original);
});
