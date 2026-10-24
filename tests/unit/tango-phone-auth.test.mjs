import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAuthService } from "../../server/auth/service.mjs";
import { readAuthConfig } from "../../server/auth/config.mjs";

const PASSWORD = "Phone123456";
const HEADERS = { "x-tango-client": "tango-settings/1", "content-type": "application/json" };

async function fixture(t, extraConfig = {}) {
  const directory = await mkdtemp(join(tmpdir(), "tango-phone-auth-"));
  const databaseFile = join(directory, "auth.sqlite");
  const config = readAuthConfig({
    TANGO_AUTH_SECRET: "phone-auth-test-secret-with-more-than-32-bytes",
    EMAIL_TRANSPORT: "console",
    ADMIN_EMAILS: "admin@example.test",
    ...extraConfig,
  });
  const sentSms = [];
  const sentEmail = [];
  const service = createAuthService({
    databaseFile,
    config,
    sendSms: async (message) => sentSms.push(message),
    sendEmail: async (message) => sentEmail.push(message),
  });
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (!await service.handle(req, res, body)) { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    service.close();
    await rm(directory, { recursive: true, force: true });
  });
  const request = async (path, { method = "GET", body, cookie } = {}) => {
    const response = await fetch(url + path, { method, headers: { ...HEADERS, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie") };
  };
  const issueCode = async (payload) => {
    const result = await request("/api/auth/send-code", { method: "POST", body: payload });
    assert.equal(result.status, 200);
    return result.body.devCode;
  };
  const register = async (payload) => {
    return request("/api/auth/register", { method: "POST", body: { ...payload, password: PASSWORD, confirmPassword: PASSWORD } });
  };
  return { request, register, issueCode, sentSms, sentEmail, databaseFile };
}

test("phone registration normalizes mainland numbers, validates confirmation and stores no plaintext secrets", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/api/auth/send-code", { method: "POST", body: { phone: "not-a-phone" } })).body.error, "INVALID_PHONE");
  const mismatch = await f.request("/api/auth/register", { method: "POST", body: { phone: "138 0013 8000", password: PASSWORD, confirmPassword: PASSWORD + "!" } });
  assert.equal(mismatch.body.error, "PASSWORD_MISMATCH");
  const missingConfirmation = await f.request("/api/auth/register", { method: "POST", body: { phone: "13800138000", password: PASSWORD } });
  assert.equal(missingConfirmation.body.error, "PASSWORD_MISMATCH");
  const created = await f.request("/api/auth/register", { method: "POST", body: { phone: "+8613800138000", password: PASSWORD, confirmPassword: PASSWORD } });
  assert.equal(created.status, 200);
  assert.equal(created.body.user.phone, "+8613800138000");
  assert.equal(created.body.user.email, null);
  assert.equal(created.body.user.phoneVerified, true);
  assert.equal(created.body.user.emailVerified, false);
  const login = await f.request("/api/auth/login", { method: "POST", body: { phone: "8613800138000", password: PASSWORD } });
  assert.equal(login.status, 200);
  assert.match(login.cookie, /HttpOnly/);
  assert.equal((await f.request("/api/auth/me", { cookie: login.cookie })).body.user.phone, "+8613800138000");
  const minimal = await f.request("/api/auth/register", { method: "POST", body: { phone: "13900139001", password: "Abcdefg1", confirmPassword: "Abcdefg1" } });
  assert.equal(minimal.status, 200);
  assert.equal(minimal.body.user.phone, "+8613900139001");
  const raw = await readFile(f.databaseFile);
  assert.equal(raw.includes(Buffer.from(PASSWORD)), false);
  assert.equal(f.sentSms.length, 0);
});

test("phone placeholder collisions return an actionable error", async (t) => {
  const f = await fixture(t);
  const reserved = await f.register({ email: "8613800138002@phone.tango.invalid" });
  assert.equal(reserved.status, 200);
  const collision = await f.request("/api/auth/register", { method: "POST", body: { phone: "13800138002", password: PASSWORD, confirmPassword: PASSWORD } });
  assert.equal(collision.status, 400);
  assert.equal(collision.body.error, "REGISTRATION_FAILED");
});

test("phone code login issues one session, burns the code and suppresses unknown accounts", async (t) => {
  const f = await fixture(t);
  const created = await f.register({ phone: "13800138000" });
  assert.equal(created.status, 200);
  assert.equal(f.sentSms.length, 0);
  const loginCode = await f.issueCode({ phone: "13800138000", purpose: "login" });
  const login = await f.request("/api/auth/login-code", { method: "POST", body: { phone: "13800138000", code: loginCode } });
  assert.equal(login.status, 200);
  assert.ok(login.cookie);
  assert.equal((await f.request("/api/auth/me", { cookie: login.cookie })).body.user.id, created.body.user.id);
  const replay = await f.request("/api/auth/login-code", { method: "POST", body: { phone: "13800138000", code: loginCode } });
  assert.equal(replay.body.error, "INVALID_CODE");
  const unknown = await f.request("/api/auth/send-code", { method: "POST", body: { phone: "13900139000", purpose: "login" } });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.devCode, undefined);
  assert.equal(f.sentSms.length, 1);
});

test("email code login works with the same endpoint and keeps verified email accounts compatible", async (t) => {
  const f = await fixture(t);
  const created = await f.register({ email: "member@example.test" });
  assert.equal(created.status, 200);
  assert.equal(created.body.user.emailVerified, true);
  const code = await f.issueCode({ email: "member@example.test", purpose: "login" });
  const login = await f.request("/api/auth/login-code", { method: "POST", body: { email: "member@example.test", code } });
  assert.equal(login.status, 200);
  assert.equal((await f.request("/api/auth/me", { cookie: login.cookie })).body.user.id, created.body.user.id);
  const password = await f.request("/api/auth/login", { method: "POST", body: { email: "member@example.test", password: PASSWORD } });
  assert.equal(password.status, 200);
});

test("phone password reset revokes sessions and analytics is admin-only with masked identifiers", async (t) => {
  const f = await fixture(t);
  await f.register({ email: "admin@example.test" });
  await f.register({ phone: "13800138000" });
  const adminLogin = await f.request("/api/auth/login", { method: "POST", body: { email: "admin@example.test", password: PASSWORD } });
  const userLogin = await f.request("/api/auth/login", { method: "POST", body: { phone: "13800138000", password: PASSWORD } });
  assert.equal(adminLogin.body.user.role, "admin");
  assert.equal((await f.request("/api/admin/analytics", { cookie: userLogin.cookie })).status, 403);
  const analytics = await f.request("/api/admin/analytics", { cookie: adminLogin.cookie });
  assert.equal(analytics.status, 200);
  assert.equal(analytics.body.totals.users, 2);
  assert.equal(analytics.body.totals.emailAccounts, 1);
  assert.equal(analytics.body.totals.phoneAccounts, 1);
  const byType = Object.fromEntries(analytics.body.eventsByType.map((row) => [row.type, row.count]));
  assert.equal(byType.register_success, 2);
  assert.equal(byType.login_password_success, 2);
  assert.ok(analytics.body.recentEvents.length > 0);
  assert.equal(JSON.stringify(analytics.body).includes("admin@example.test"), false);
  assert.equal(JSON.stringify(analytics.body).includes("+8613800138000"), false);
  const resetCode = await f.issueCode({ phone: "13800138000", purpose: "reset" });
  const reset = await f.request("/api/auth/reset-password", { method: "POST", body: { phone: "13800138000", code: resetCode, newPassword: "Reset98765" } });
  assert.equal(reset.status, 200);
  assert.equal((await f.request("/api/auth/me", { cookie: userLogin.cookie })).status, 401);
  assert.equal((await f.request("/api/auth/login", { method: "POST", body: { phone: "13800138000", password: "Reset98765" } })).status, 200);
});

test("status advertises channel delivery and direct registration while phone codes stay unavailable outside console mode", async (t) => {
  const f = await fixture(t, { EMAIL_TRANSPORT: "resend", RESEND_API_KEY: "test-only", MAIL_FROM: "noreply@example.test" });
  const status = await f.request("/api/auth/status");
  assert.equal(status.body.codeLogin, false);
  assert.equal(status.body.passwordMinLength, 8);
  assert.equal(status.body.passwordMaxLength, 15);
  assert.equal(status.body.registrationEnabled, true);
  assert.equal(status.body.emailDelivery, "email");
  assert.equal(status.body.phoneDelivery, "unavailable");
  const phone = await f.request("/api/auth/send-code", { method: "POST", body: { phone: "13800138000" } });
  assert.equal(phone.body.error, "PHONE_UNAVAILABLE");
});

