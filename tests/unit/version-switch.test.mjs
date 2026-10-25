import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request } from 'node:http';
import { createVersionSwitch, versionOf } from '../../scripts/version-switch.mjs';

function listen(server) { return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))); }
function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', c => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject); req.end();
  });
}
function upgrade(port, headers) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/voice/stream', headers: { Connection: 'Upgrade', Upgrade: 'websocket', ...headers } });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on('response', res => resolve(res.statusCode));
    req.on('error', () => resolve('closed'));
    req.end();
  });
}

test('versionOf reads only the v2 opt-in cookie', () => {
  assert.equal(versionOf({ headers: {} }), 'v1');
  assert.equal(versionOf({ headers: { cookie: 'a=1; donego_version=v2' } }), 'v2');
  assert.equal(versionOf({ headers: { cookie: 'donego_version=v3' } }), 'v1');
});

test('/v2 opts in, cookie requests and websocket upgrades reach the next version, /v1 opts out', async t => {
  const next = createServer((req, res) => res.end('next:' + req.url));
  next.on('upgrade', (req, socket) => socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'));
  const nextPort = await listen(next);
  const sw = createVersionSwitch({ nextPort, secure: true });
  const front = createServer((req, res) => { if (!sw.handle(req, res)) res.end('classic:' + req.url); });
  front.on('upgrade', (req, socket, head) => { if (!sw.upgrade(req, socket, head)) socket.destroy(); });
  const port = await listen(front);
  t.after(() => { front.close(); next.close(); });

  assert.equal((await get(port, '/')).body, 'classic:/');
  const optIn = await get(port, '/v2');
  assert.equal(optIn.status, 302);
  assert.equal(optIn.headers.location, '/');
  assert.match(optIn.headers['set-cookie'][0], /^donego_version=v2; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax; Secure$/);
  const cookie = 'donego_version=v2';
  assert.equal((await get(port, '/relay/home.js?x=1', { cookie })).body, 'next:/relay/home.js?x=1');
  assert.equal(await upgrade(port, { cookie }), 101);
  assert.equal(await upgrade(port, {}), 'closed');
  const optOut = await get(port, '/v1', { cookie });
  assert.equal(optOut.status, 302);
  assert.match(optOut.headers['set-cookie'][0], /^donego_version=; Path=\/; Max-Age=0/);

  next.close();
  const down = await get(port, '/', { cookie });
  assert.equal(down.status, 502);
});
