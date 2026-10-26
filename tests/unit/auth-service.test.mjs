import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAuthService } from "../../server/auth/service.mjs";
import { readAuthConfig } from "../../server/auth/config.mjs";
import { createEmailSender } from "../../server/auth/email.mjs";

const PASSWORD = "Passw0rd123";
const HEADERS = { "x-tango-client": "tango-settings/1", "content-type": "application/json" };
const config = (extra = {}) => readAuthConfig({ TANGO_AUTH_SECRET: "test-only-secret-with-more-than-32-characters", EMAIL_TRANSPORT: "console", ADMIN_EMAILS: "admin@example.test", ...extra });

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "tango-donego-auth-test-"));
  const databaseFile = join(directory, "auth.sqlite");
  const sent = [];
  let clock = Date.now();
  let failDelivery = false;
  const options = { databaseFile, config: config(), now: () => clock, sendEmail: async (message) => { if (failDelivery) throw new Error("provider_secret_must_not_escape"); sent.push(message); }, ...overrides };
  let service = createAuthService(options);
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (!await service.handle(req, res, body)) { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); service.close(); await rm(directory, { recursive: true, force: true }); });
  const advance = (ms) => { clock += ms; };
  const request = async (path, { method = "GET", body, cookie, headers = {} } = {}) => {
    const response = await fetch(url + path, { method, headers: { ...HEADERS, ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie"), headers: response.headers };
  };
  const codeFor = async (email) => (await request("/api/auth/send-code", { method: "POST", body: { email } })).body.devCode;
  const register = async (email) => {
    advance(61000); // 跨过同 IP 发码冷却之外的同邮箱冷却
    const response = await request("/api/auth/register", { method: "POST", body: { email, password: PASSWORD, confirmPassword: PASSWORD, code: await codeFor(email) } });
    assert.equal(response.status, 200);
    return response;
  };
  return { request, register, codeFor, sent, databaseFile, advance, failDelivery: () => { failDelivery = true; }, restart: () => { service.close(); service = createAuthService(options); } };
}

test("mail2profile registration, cookie restore, login and logout preserve separate identities", async (t) => {
  const f = await fixture(t);
  const alice = await f.register("ALICE@example.test");
  const bob = await f.register("bob@example.test");
  assert.notEqual(alice.body.user.id, bob.body.user.id);
  assert.equal(alice.body.user.email, "alice@example.test");
  assert.equal(alice.body.user.emailVerified, true);
  assert.match(alice.cookie, /HttpOnly; SameSite=Lax/);
  assert.equal(alice.body.token, undefined);
  assert.equal(alice.body.user.password_hash, undefined);
  f.restart();
  assert.equal((await f.request("/api/auth/me", { cookie: alice.cookie })).body.user.id, alice.body.user.id);
  assert.equal((await f.request("/api/auth/me", { cookie: bob.cookie })).body.user.id, bob.body.user.id);
  assert.equal((await f.request("/api/auth/me")).status, 401);
  assert.equal((await f.request("/api/auth/logout", { method: "POST", cookie: alice.cookie, body: {} })).status, 200);
  assert.equal((await f.request("/api/auth/me", { cookie: alice.cookie })).status, 401);
  assert.equal((await f.request("/api/auth/me", { cookie: bob.cookie })).status, 200);
  const login = await f.request("/api/auth/login", { method: "POST", body: { email: "alice@example.test", password: PASSWORD } });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.id, alice.body.user.id);
  const raw = await readFile(f.databaseFile);
  assert.equal(raw.includes(Buffer.from(PASSWORD)), false);
});

test("login codes are single-use, persist cooldown across restart, and exhaust after five guesses", async (t) => {
  const f = await fixture(t);
  const alice = await f.register("alice@example.test");
  const first = await f.request("/api/auth/send-code", { method: "POST", body: { email: "alice@example.test", purpose: "login" } });
  assert.match(first.body.devCode, /^\d{6}$/);
  f.restart();
  assert.equal((await f.request("/api/auth/send-code", { method: "POST", body: { email: "alice@example.test", purpose: "login" } })).body.error, "CODE_COOLDOWN");
  for (let i = 0; i < 5; i++) {
    const result = await f.request("/api/auth/login-code", { method: "POST", body: { email: "alice@example.test", code: "wrong" } });
    assert.equal(result.body.error, "INVALID_CODE");
  }
  assert.equal((await f.request("/api/auth/login-code", { method: "POST", body: { email: "alice@example.test", code: first.body.devCode } })).body.error, "INVALID_CODE");
  f.advance(61000);
  const second = await f.request("/api/auth/send-code", { method: "POST", body: { email: "alice@example.test", purpose: "login" } });
  assert.equal(second.status, 200);
  const login = await f.request("/api/auth/login-code", { method: "POST", body: { email: "alice@example.test", code: second.body.devCode } });
  assert.equal(login.status, 200);
  const replay = await f.request("/api/auth/login-code", { method: "POST", body: { email: "alice@example.test", code: second.body.devCode } });
  assert.equal(replay.body.error, "INVALID_CODE");
  assert.equal((await f.request("/api/auth/me", { cookie: login.cookie })).status, 200);
  assert.equal((await f.request("/api/auth/me", { cookie: alice.cookie })).status, 200);
});

test("expired, superseded and wrong-purpose codes are rejected, and registration always needs a code", async (t) => {
  const f = await fixture(t);
  const first = await f.request("/api/auth/send-code", { method: "POST", body: { email: "expiry@example.test" } });
  f.advance(601000);
  assert.equal((await f.request("/api/auth/login-code", { method: "POST", body: { email: "expiry@example.test", code: first.body.devCode } })).body.error, "INVALID_CODE");
  const registered = await f.register("alice@example.test");
  const reset = await f.request("/api/auth/send-code", { method: "POST", body: { email: "alice@example.test", purpose: "reset" } });
  assert.equal(reset.status, 200);
  assert.equal((await f.request("/api/auth/login-code", { method: "POST", body: { email: "alice@example.test", code: reset.body.devCode } })).body.error, "INVALID_CODE");
  const direct = await f.register("new@example.test");
  assert.equal(direct.status, 200);
  // 已注册的邮箱拿不到注册码（发码被静默抑制），所以重复注册先报验证码无效，不暴露账号是否存在
  assert.equal((await f.request("/api/auth/register", { method: "POST", body: { email: "alice@example.test", password: PASSWORD, confirmPassword: PASSWORD } })).body.error, "INVALID_CODE");
  assert.equal((await f.request("/api/auth/me", { cookie: registered.cookie })).status, 200);
});

test("password reset revokes all sessions and only the replacement password logs in", async (t) => {
  const f = await fixture(t);
  const alice = await f.register("alice@example.test");
  await f.request("/api/auth/send-code", { method: "POST", body: { email: "alice@example.test", purpose: "reset" } });
  const newPassword = "Replace987x";
  const reset = await f.request("/api/auth/reset-password", { method: "POST", body: { email: "alice@example.test", code: f.sent.at(-1).code, newPassword } });
  assert.equal(reset.status, 200);
  assert.equal((await f.request("/api/auth/me", { cookie: alice.cookie })).status, 401);
  assert.equal((await f.request("/api/auth/login", { method: "POST", body: { email: "alice@example.test", password: PASSWORD } })).status, 401);
  assert.equal((await f.request("/api/auth/login", { method: "POST", body: { email: "alice@example.test", password: newPassword } })).status, 200);
  assert.equal((await f.request("/api/auth/reset-password", { method: "POST", body: { email: "alice@example.test", code: f.sent.at(-1).code, newPassword } })).status, 400);
});

test("profile update cannot escalate role; password change revokes the previous session", async (t) => {
  const f = await fixture(t);
  const alice = await f.register("alice@example.test");
  const update = await f.request("/api/auth/me", { method: "PUT", cookie: alice.cookie, body: { displayName: "Done&Go 用户", role: "admin", settings: { theme: "ink" } } });
  assert.equal(update.body.user.displayName, "Done&Go 用户");
  assert.equal(update.body.user.role, "user");
  assert.deepEqual(update.body.user.settings, { theme: "ink" });
  const change = await f.request("/api/auth/me/password", { method: "PUT", cookie: alice.cookie, body: { oldPassword: PASSWORD, newPassword: "NewPass98765" } });
  assert.equal(change.status, 200);
  assert.equal((await f.request("/api/auth/me", { cookie: alice.cookie })).status, 401);
  assert.equal((await f.request("/api/auth/me", { cookie: change.cookie })).status, 200);
});

test("admin RBAC, disable, enable, deletion and resource hooks enforce account boundaries", async (t) => {
  const removed = [];
  const f = await fixture(t, { resourceHooks: { countUserResources: async () => 2, onUserDeleted: async (id) => { removed.push(id); } } });
  const admin = await f.register("admin@example.test");
  const alice = await f.register("alice@example.test");
  assert.equal(admin.body.user.role, "admin");
  assert.equal((await f.request("/api/admin/users", { cookie: alice.cookie })).status, 403);
  const list = await f.request("/api/admin/users", { cookie: admin.cookie });
  assert.equal(list.body.users.length, 2);
  assert.equal(list.body.users[0].resourceCount, 2);
  const target = `/api/admin/users/${alice.body.user.id}`;
  assert.equal((await f.request(target, { method: "PATCH", cookie: admin.cookie, body: { isActive: false } })).status, 200);
  assert.equal((await f.request("/api/auth/me", { cookie: alice.cookie })).status, 401);
  assert.equal((await f.request("/api/auth/login", { method: "POST", body: { email: "alice@example.test", password: PASSWORD } })).body.error, "ACCOUNT_INACTIVE");
  assert.equal((await f.request(target, { method: "PATCH", cookie: admin.cookie, body: { isActive: true } })).status, 200);
  const login = await f.request("/api/auth/login", { method: "POST", body: { email: "alice@example.test", password: PASSWORD } });
  assert.equal(login.status, 200);
  assert.equal((await f.request(`/api/admin/users/${admin.body.user.id}`, { method: "DELETE", cookie: admin.cookie })).status, 400);
  assert.equal((await f.request(target, { method: "DELETE", cookie: admin.cookie })).status, 200);
  assert.deepEqual(removed, [alice.body.user.id]);
  assert.equal((await f.request("/api/auth/me", { cookie: login.cookie })).status, 401);
});

test("authentication rejects forged tokens, expired sessions, foreign origins and missing client header", async (t) => {
  const f = await fixture(t);
  const alice = await f.register("alice@example.test");
  const forged = alice.cookie.replace("tango_session=", "tango_session=x");
  assert.equal((await f.request("/api/auth/me", { cookie: forged })).status, 401);
  assert.equal((await f.request("/api/auth/me", { cookie: alice.cookie, headers: { origin: "https://attacker.example" } })).status, 403);
  assert.equal((await f.request("/api/auth/me", { cookie: alice.cookie, headers: { "x-tango-client": "" } })).status, 403);
  f.advance(73 * 3600000);
  assert.equal((await f.request("/api/auth/me", { cookie: alice.cookie })).status, 401);
});

test("unknown user and wrong password have the same login failure, and repeated attempts are limited", async (t) => {
  const f = await fixture(t);
  await f.register("alice@example.test");
  const wrong = await f.request("/api/auth/login", { method: "POST", body: { email: "alice@example.test", password: "wrong" } });
  const unknown = await f.request("/api/auth/login", { method: "POST", body: { email: "missing@example.test", password: "wrong" } });
  assert.equal(wrong.status, unknown.status);
  assert.deepEqual(wrong.body, unknown.body);
  for (let i = 0; i < 8; i++) await f.request("/api/auth/login", { method: "POST", body: { email: "missing@example.test", password: "wrong" } });
  assert.equal((await f.request("/api/auth/login", { method: "POST", body: { email: "missing@example.test", password: "wrong" } })).status, 429);
});

test("delivery failure returns a redacted failure and cannot verify a pending code", async (t) => {
  const f = await fixture(t);
  f.failDelivery();
  const result = await f.request("/api/auth/send-code", { method: "POST", body: { email: "alice@example.test" } });
  assert.equal(result.status, 503);
  assert.equal(result.body.error, "EMAIL_DELIVERY_FAILED");
  assert.equal(JSON.stringify(result.body).includes("provider_secret"), false);
  assert.equal(result.body.devCode, undefined);
});

test("public configuration forbids console codes and requires a strong signing secret", () => {
  assert.throws(() => readAuthConfig({}), /32 bytes/);
  assert.throws(() => config({ TANGO_PUBLIC_ORIGIN: "https://tango-donego.udify.fun" }), /prohibited/);
  assert.throws(() => config({ ENV: "production" }), /prohibited/);
  assert.throws(() => config({ TANGO_PUBLIC_ORIGIN: "http://tango-donego.udify.fun" }), /HTTPS/);
  assert.throws(() => config({ EMAIL_TRANSPORT: "resend" }), /RESEND_API_KEY/);
});

test("invalid fields do not create an account and concurrent registration creates exactly one identity", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/api/auth/send-code", { method: "POST", body: { email: "not-an-email" } })).body.error, "INVALID_EMAIL");
  const body = { email: "alice@example.test", password: PASSWORD, confirmPassword: PASSWORD };
  assert.equal((await f.request("/api/auth/register", { method: "POST", body: { ...body, password: "short", confirmPassword: "short" } })).body.error, "INVALID_PASSWORD");
  assert.equal((await f.request("/api/auth/register", { method: "POST", body: { ...body, displayName: "" } })).body.error, "INVALID_NAME");
  const code = await f.codeFor("alice@example.test");
  const results = await Promise.all([f.request("/api/auth/register", { method: "POST", body: { ...body, code } }), f.request("/api/auth/register", { method: "POST", body: { ...body, code } })]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 400]);
  assert.ok(["REGISTRATION_FAILED", "INVALID_CODE"].includes(results.find((result) => result.status === 400).body.error));
});

test("passwords are enforced server-side between 8 and 15 characters", async (t) => {
  const f = await fixture(t);
  const tooShort = await f.request("/api/auth/register", { method: "POST", body: { email: "bounds@example.test", password: "Abcdefg", confirmPassword: "Abcdefg" } });
  const tooLong = await f.request("/api/auth/register", { method: "POST", body: { email: "bounds@example.test", password: "Abcdefghijklmno1", confirmPassword: "Abcdefghijklmno1" } });
  assert.equal(tooShort.body.error, "INVALID_PASSWORD");
  assert.equal(tooLong.body.error, "INVALID_PASSWORD");
  const minimum = await f.request("/api/auth/register", { method: "POST", body: { email: "bounds@example.test", password: "Abcdefg1", confirmPassword: "Abcdefg1", code: await f.codeFor("bounds@example.test") } });
  const maximum = await f.request("/api/auth/register", { method: "POST", body: { email: "wide@example.test", password: "Abcdefghijklmno", confirmPassword: "Abcdefghijklmno", code: await f.codeFor("wide@example.test") } });
  assert.equal(minimum.status, 200);
  assert.equal(maximum.status, 200);
  const login = await f.request("/api/auth/login", { method: "POST", body: { email: "bounds@example.test", password: "Abcdefg1" } });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.id, minimum.body.user.id);
});

test("resending a login code invalidates the previous code while preserving the new code", async (t) => {
  const f = await fixture(t);
  await f.register("alice@example.test");
  const first = await f.request("/api/auth/send-code", { method: "POST", body: { email: "alice@example.test", purpose: "login" } });
  f.advance(61000);
  const second = await f.request("/api/auth/send-code", { method: "POST", body: { email: "alice@example.test", purpose: "login" } });
  assert.equal(second.status, 200);
  // Random codes may coincide; the test must never depend on their inequality.
  const wrongCode = second.body.devCode === first.body.devCode ? "invalid" : first.body.devCode;
  const old = await f.request("/api/auth/login-code", { method: "POST", body: { email: "alice@example.test", code: wrongCode } });
  assert.equal(old.body.error, "INVALID_CODE");
  const current = await f.request("/api/auth/login-code", { method: "POST", body: { email: "alice@example.test", code: second.body.devCode } });
  assert.equal(current.status, 200);
});

test("public email mode sets secure cookies and never returns verification codes", async (t) => {
  const f = await fixture(t, { config: config({ TANGO_PUBLIC_ORIGIN: "https://tango-donego.udify.fun", EMAIL_TRANSPORT: "resend", RESEND_API_KEY: "test-only", MAIL_FROM: "Tango Done&Go <noreply@example.test>" }) });
  const headers = { origin: "https://tango-donego.udify.fun" };
  const result = await f.request("/api/auth/send-code", { method: "POST", body: { email: "alice@example.test" }, headers });
  assert.equal(result.status, 200);
  assert.equal(result.body.devCode, undefined);
  const registration = await f.request("/api/auth/register", { method: "POST", body: { email: "alice@example.test", password: PASSWORD, confirmPassword: PASSWORD, code: f.sent.at(-1).code }, headers });
  assert.equal(registration.status, 200);
  assert.match(registration.cookie, /; Secure/);
});

test("unconfigured email closes registration because no code can prove the address", async (t) => {
  const f = await fixture(t, { config: config({ EMAIL_TRANSPORT: "disabled" }) });
  const status = await f.request("/api/auth/status");
  assert.equal(status.body.registrationEnabled, false);
  assert.equal(status.body.emailDelivery, "unavailable");
  assert.equal(status.body.codeLogin, false);
  assert.equal(status.body.passwordMinLength, 8);
  assert.equal(status.body.passwordMaxLength, 15);
  assert.equal((await f.request("/api/auth/send-code", { method: "POST", body: { email: "alice@example.test" } })).status, 503);
  assert.equal((await f.request("/api/auth/register", { method: "POST", body: { email: "alice@example.test", password: PASSWORD, confirmPassword: PASSWORD } })).body.error, "INVALID_CODE");
});

test("resend adapter uses the configured sender, does not follow redirects and hides provider failure detail", async () => {
  let request;
  const sender = createEmailSender(config({ EMAIL_TRANSPORT: "resend", RESEND_API_KEY: "test-key", MAIL_FROM: "noreply@example.test" }), { fetchImpl: async (url, options) => { request = { url, options }; return new Response("OK"); } });
  await sender({ email: "alice@example.test", code: "123456", purpose: "register" });
  assert.equal(request.url, "https://api.resend.com/emails");
  assert.equal(request.options.redirect, "error");
  assert.equal(JSON.parse(request.options.body).from, "noreply@example.test");
  const failing = createEmailSender(config({ EMAIL_TRANSPORT: "resend", RESEND_API_KEY: "test-key", MAIL_FROM: "noreply@example.test" }), { fetchImpl: async () => new Response("sensitive provider diagnostic", { status: 500 }) });
  await assert.rejects(failing({ email: "alice@example.test", code: "123456", purpose: "reset" }), { message: "email_delivery_failed" });
});

test("registration requires a valid, unused code sent to that address", async (t) => {
  const f = await fixture(t);
  const body = { email: "carol@example.test", password: PASSWORD, confirmPassword: PASSWORD };
  assert.equal((await f.request("/api/auth/register", { method: "POST", body })).body.error, "INVALID_CODE");
  const code = await f.codeFor("carol@example.test");
  assert.equal((await f.request("/api/auth/register", { method: "POST", body: { ...body, code: code === "000000" ? "111111" : "000000" } })).body.error, "INVALID_CODE");
  assert.equal((await f.request("/api/auth/register", { method: "POST", body: { ...body, email: "mallory@example.test", code } })).body.error, "INVALID_CODE", "a code only proves the address it was sent to");
  const ok = await f.request("/api/auth/register", { method: "POST", body: { ...body, code } });
  assert.equal(ok.status, 200);
  assert.equal((await f.request("/api/auth/register", { method: "POST", body: { ...body, code } })).body.error, "INVALID_CODE", "a code cannot be reused");
});
