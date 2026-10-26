import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authRequestAllowed } from '../../server/auth/config.mjs';

const req = (host, origin) => ({ method: 'POST', headers: { host, origin, 'x-tango-client': 'tango-settings/1' } });
const PUBLIC = 'https://donego.udify.fun';

test('a dev server with a public origin still accepts sign-up from its own localhost page', () => {
  const dev = { publicOrigin: PUBLIC, production: false };
  assert.equal(authRequestAllowed(req('localhost:5207', 'http://localhost:5207'), dev), true);
  assert.equal(authRequestAllowed(req('127.0.0.1:5207', 'http://127.0.0.1:5207'), dev), true);
  assert.equal(authRequestAllowed(req('donego.udify.fun', PUBLIC), dev), true);
  assert.equal(authRequestAllowed(req('donego.udify.fun', 'https://evil.example'), dev), false);
  assert.equal(authRequestAllowed(req('localhost:5207', 'https://evil.example'), dev), false);
});

test('production only trusts the public origin', () => {
  const prod = { publicOrigin: PUBLIC, production: true };
  assert.equal(authRequestAllowed(req('localhost:5207', 'http://localhost:5207'), prod), false);
  assert.equal(authRequestAllowed(req('donego.udify.fun', PUBLIC), prod), true);
});
