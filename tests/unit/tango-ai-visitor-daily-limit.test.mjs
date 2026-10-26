import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';
import { createTangoServer, createAIGuard } from '../../scripts/serve-tango.mjs';

// D23: anonymous visitors get a 30/day AI budget keyed by IP; the 31st call
// returns 429 TANGO_AI_VISITOR_DAILY_LIMIT with the existing quota message
// 「今日体验额度已用完」. Signed-in accounts are exempt (demo mode was removed
// 2026-10-26). The global TANGO_AI_DAILY_LIMIT=500 stays an in-process memory
// counter with its own code and is untouched by this quota.

const anonymous = undefined;
const paidActor = id => ({ id, demo: false, role: 'user', emailVerified: true });
const reqFrom = ip => ({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': ip } });

function call(port, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', part => { text += part; });
      res.on('end', () => resolve({ status: res.statusCode, data: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function start(t, options) {
  const server = createTangoServer(options);
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function countingAssistant() {
  const state = { calls: 0 };
  state.assistant = {
    configuration: () => ({}),
    chat: async () => { state.calls++; return { content: [{ type: 'text', text: 'ok' }] }; },
    streamChat: async function* () { state.calls++; yield 'ok'; },
  };
  return state;
}

test('an anonymous visitor gets 30 AI calls per day; the 31st returns 429 TANGO_AI_VISITOR_DAILY_LIMIT', () => {
  let clock = new Date(2026, 9, 23, 9, 0, 0).getTime();
  const guard = createAIGuard({ env: {}, now: () => clock });
  for (let i = 0; i < 30; i += 1) guard.check(reqFrom('203.0.113.9'), anonymous, 'chat');
  assert.throws(() => guard.check(reqFrom('203.0.113.9'), anonymous, 'chat'), error => error.code === 'TANGO_AI_VISITOR_DAILY_LIMIT' && error.status === 429);
  clock = new Date(2026, 9, 24, 9, 0, 0).getTime();
  guard.check(reqFrom('203.0.113.9'), anonymous, 'chat'); // next day resets the bucket
});

test('anonymous visitors are capped by IP alone while paid actors stay exempt', () => {
  const clock = new Date(2026, 9, 23, 11, 0, 0).getTime();
  const guard = createAIGuard({ env: {}, now: () => clock });
  for (let i = 0; i < 30; i += 1) guard.check(reqFrom('198.51.100.9'), undefined, 'chat');
  assert.throws(() => guard.check(reqFrom('198.51.100.9'), undefined, 'chat'), error => error.code === 'TANGO_AI_VISITOR_DAILY_LIMIT');
  for (let i = 0; i < 40; i += 1) guard.check(reqFrom('198.51.100.9'), paidActor('u-1'), 'chat'); // the IP bucket does not apply to accounts
});

test('TANGO_AI_VISITOR_DAILY_LIMIT overrides the default 30', () => {
  const clock = new Date(2026, 9, 23, 12, 0, 0).getTime();
  const guard = createAIGuard({ env: { TANGO_AI_VISITOR_DAILY_LIMIT: '3' }, now: () => clock });
  for (let i = 0; i < 3; i += 1) guard.check(reqFrom('203.0.113.4'), anonymous, 'chat');
  assert.throws(() => guard.check(reqFrom('203.0.113.4'), anonymous, 'chat'), error => error.code === 'TANGO_AI_VISITOR_DAILY_LIMIT');
});

test('the visitor quota is independent of the in-memory global daily budget', () => {
  const clock = new Date(2026, 9, 23, 13, 0, 0).getTime();
  const guard = createAIGuard({ env: {}, now: () => clock });
  for (let i = 0; i < 30; i += 1) guard.check(reqFrom('203.0.113.5'), anonymous, 'chat');
  assert.throws(() => guard.check(reqFrom('203.0.113.5'), anonymous, 'chat'), error => error.code === 'TANGO_AI_VISITOR_DAILY_LIMIT');
  guard.check(reqFrom('203.0.113.6'), anonymous, 'chat'); // another visitor is still served: the global 500 is far away
});

test('HTTP surface: the 31st call from one visitor IP is 429 TANGO_AI_VISITOR_DAILY_LIMIT with the quota message', async t => {
  const state = countingAssistant();
  const server = await start(t, { assistant: state.assistant, aiGuard: createAIGuard({ env: {} }) });
  const port = server.address().port;
  const headers = { Origin: 'http://127.0.0.1:' + port, 'Content-Type': 'application/json' };
  const ask = (ip, prompt) => call(port, '/api/assistant/chat', { method: 'POST', headers: { ...headers, 'X-Forwarded-For': ip }, body: JSON.stringify({ prompt }) });
  for (let i = 0; i < 30; i += 1) assert.equal((await ask('203.0.113.77', '第' + i + '次')).status, 200);
  assert.equal(state.calls, 30);
  const blocked = await ask('203.0.113.77', '第31次');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.data.code, 'TANGO_AI_VISITOR_DAILY_LIMIT');
  assert.equal(blocked.data.message, '今日体验额度已用完');
  assert.equal(state.calls, 30);
  assert.equal((await ask('203.0.113.78', '另一位访客')).status, 200);
  assert.equal(state.calls, 31);
});

test('each signed-in account has its own daily cap (default 200) so one account cannot drain the global budget', () => {
  let clock = new Date(2026, 9, 23, 8, 0, 0).getTime();
  const guard = createAIGuard({ env: { TANGO_AI_USER_DAILY_LIMIT: '5', TANGO_AI_RATE_LIMIT: '1000' }, now: () => clock });
  for (let i = 0; i < 5; i += 1) guard.check(reqFrom('203.0.113.1'), paidActor('u-9'), 'chat');
  assert.throws(() => guard.check(reqFrom('203.0.113.2'), paidActor('u-9'), 'chat'), error => error.code === 'TANGO_AI_VISITOR_DAILY_LIMIT' && error.status === 429, 'switching IPs does not reset the account bucket');
  guard.check(reqFrom('203.0.113.1'), paidActor('u-10'), 'chat'); // another account is unaffected
  clock = new Date(2026, 9, 24, 8, 0, 0).getTime();
  guard.check(reqFrom('203.0.113.1'), paidActor('u-9'), 'chat'); // next day resets
});
