import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createAppServer } from "../../server/app.mjs";
import { readAuthConfig } from "../../server/auth/config.mjs";
import { createAuthService } from "../../server/auth/service.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLIENT = { "x-tango-client": "tango-settings/1", "content-type": "application/json" };
const PUBLIC_ORIGIN = "https://tango-donego.example.test";
const SECRET = "test-only-auth-secret-at-least-32-bytes";

function request(port, path, { method = "GET", body, raw, headers = {}, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", port, path, method, headers: { ...CLIENT, ...headers, ...(cookie ? { cookie } : {}) } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()), cookie: res.headers["set-cookie"]?.[0].split(";")[0] }));
    });
    req.on("error", reject);
    req.end(raw ?? (body === undefined ? undefined : JSON.stringify(body)));
  });
}

async function fixture(t, { publicOrigin = "", ...options } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "tango-donego-app-auth-"));
  const config = readAuthConfig({
    TANGO_AUTH_SECRET: SECRET,
    TANGO_PUBLIC_ORIGIN: publicOrigin,
    EMAIL_TRANSPORT: publicOrigin ? "resend" : "console",
    RESEND_API_KEY: "test-only",
    MAIL_FROM: "noreply@example.test",
    ADMIN_EMAILS: "admin@example.test",
  });
  const sent = [];
  const auth = createAuthService({ databaseFile: join(directory, "auth.sqlite"), config, sendEmail: async (message) => { sent.push(message); } });
  const app = createAppServer({ settingsFile: join(directory, "settings.json"), auth, publicOrigin, ...options });
  const port = await app.start();
  t.after(async () => { await app.close(); auth.close(); await rm(directory, { recursive: true, force: true }); });
  const headers = publicOrigin ? { host: new URL(publicOrigin).host, origin: publicOrigin } : {};
  const api = (path, options = {}) => request(port, path, { ...options, headers: { ...headers, ...options.headers } });
  const register = async (email) => {
    assert.equal((await api("/api/auth/send-code", { method: "POST", body: { email } })).status, 200);
    const response = await api("/api/auth/register", { method: "POST", body: { email, password: "LocalPass123", confirmPassword: "LocalPass123", code: sent.at(-1).code } });
    assert.equal(response.status, 200);
    return response.cookie;
  };
  return { api, register, port };
}

async function upstream(t) {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url === "/v1/models" ? { data: [{ id: "test-model" }] } : { model: "test-model", choices: [{ message: { content: "OK" } }] }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.closeIdleConnections(); server.close(resolve); }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { protocol: "openai", baseUrl, modelsUrl: `${baseUrl}/v1/models`, messagesUrl: `${baseUrl}/v1/chat/completions`, model: "test-model" };
}

test("authenticated app exposes status and rejects anonymous settings and generation", async (t) => {
  const f = await fixture(t);
  const status = await f.api("/api/auth/status");
  assert.equal(status.status, 200);
  assert.equal(status.body.enabled, true);
  for (const [method, path] of [["GET", "/api/settings/llm"], ["POST", "/api/settings/llm"], ["POST", "/api/settings/llm/test"], ["DELETE", "/api/settings/llm"], ["POST", "/api/llm/generate"]]) {
    const response = await f.api(path, { method, ...(method === "POST" ? { body: {} } : {}) });
    assert.equal(response.status, 401, `${method} ${path}`);
    assert.equal(response.body.error, "AUTH_REQUIRED");
    assert.equal(response.body.detail.code, "AUTH_REQUIRED");
  }
  assert.equal((await f.api("/api/unknown")).status, 404);
  assert.equal((await f.api("/api/auth/unknown")).status, 404);
});

test("public Host requires an Origin for writes and matching Origin lets an admin save verified settings", async (t) => {
  const f = await fixture(t, { publicOrigin: PUBLIC_ORIGIN });
  const candidate = await upstream(t);
  const cookie = await f.register("admin@example.test");
  const settings = { candidate, apiKey: "test-only-upstream-key" };
  for (const path of ["/api/auth/logout", "/api/settings/llm", "/api/settings/llm/test", "/api/llm/generate"]) {
    const denied = await request(f.port, path, { method: "POST", body: settings, cookie, headers: { host: new URL(PUBLIC_ORIGIN).host } });
    assert.equal(denied.status, 403, path);
  }
  assert.equal((await f.api("/api/settings/llm", { cookie, headers: { origin: "https://attacker.example.test" } })).status, 403);
  assert.equal((await f.api("/api/settings/llm", { cookie, headers: { host: "tango-donego.example.test:8443" } })).status, 403);
  const tested = await f.api("/api/settings/llm/test", { method: "POST", cookie, body: settings });
  assert.equal(tested.status, 200);
  assert.equal(tested.body.ok, true);
  const saved = await f.api("/api/settings/llm", { method: "POST", cookie, body: { ...settings, proofToken: tested.body.proofToken } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.enabled, true);
  assert.equal((await f.api("/api/settings/llm", { cookie })).body.verified, true);
});

test("non-admin users can generate but cannot use any settings operation", async (t) => {
  const f = await fixture(t);
  const cookie = await f.register("member@example.test");
  for (const [method, path] of [["GET", "/api/settings/llm"], ["POST", "/api/settings/llm"], ["POST", "/api/settings/llm/test"], ["DELETE", "/api/settings/llm"]]) {
    const response = await f.api(path, { method, cookie, ...(method === "POST" ? { body: {} } : {}) });
    assert.equal(response.status, 403);
    assert.equal(response.body.error, "ADMIN_REQUIRED");
  }
  const generated = await f.api("/api/llm/generate", { method: "POST", cookie, body: { purpose: "draft", input: "A useful draft" } });
  assert.equal(generated.status, 409);
  assert.equal(generated.body.error, "not_configured");
});

test("auth routes preserve JSON content-type, syntax and body limits", async (t) => {
  const f = await fixture(t, { maxBodyBytes: 128 });
  assert.equal((await f.api("/api/auth/send-code", { method: "POST", raw: "{}", headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal((await f.api("/api/auth/send-code", { method: "POST", raw: "{" })).status, 400);
  assert.equal((await f.api("/api/auth/send-code", { method: "POST", body: { email: "a".repeat(256) } })).status, 413);
});

test("startup fails closed without an auth secret", () => {
  const result = spawnSync(process.execPath, ["server/start.mjs"], { cwd: ROOT, env: { ...process.env, TANGO_DEV: "1", TANGO_HOST: "127.0.0.1", TANGO_AUTH_DISABLED: "0", TANGO_AUTH_SECRET: "", JWT_SECRET: "" }, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TANGO_AUTH_SECRET/);
  assert.doesNotMatch(result.stdout, /API\+dist/);
});

test("TANGO_AUTH_DISABLED=1 preserves loopback settings access and skips sqlite initialization", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tango-donego-start-disabled-"));
  const child = spawn(process.execPath, ["server/start.mjs"], { cwd: ROOT, env: { ...process.env, TANGO_DEV: "1", TANGO_HOST: "127.0.0.1", TANGO_PORT: "0", TANGO_AUTH_DISABLED: "1", TANGO_AUTH_SECRET: "", TANGO_SETTINGS_FILE: join(directory, "settings.json"), TANGO_AUTH_DB: join(directory, "auth.sqlite") }, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => { if (child.exitCode === null) child.kill("SIGTERM"); await closed; await rm(directory, { recursive: true, force: true }); });
  const port = await new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error(`Startup timed out: ${stderr}`)), 10000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", () => { clearTimeout(timer); reject(new Error(`Startup exited: ${stderr}`)); });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/API\+dist on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
  });
  assert.match(stderr, /authentication is DISABLED/);
  assert.doesNotMatch(stderr, /SQLite/);
  assert.equal((await request(port, "/api/settings/llm")).status, 200);
  assert.equal((await request(port, "/api/settings/llm", { method: "DELETE" })).status, 200);
  assert.equal((await request(port, "/api/settings/llm", { headers: { host: "tango-donego.example.test" } })).status, 403);
  const status = await request(port, "/api/auth/status");
  assert.equal(status.status, 200);
  assert.deepEqual(status.body, { enabled: false, emailDelivery: "unavailable", registrationEnabled: false, passwordMinLength: 8, passwordMaxLength: 15 });
  assert.equal((await request(port, "/api/auth/login", { method: "POST", body: { email: "a@b.test", password: "x".repeat(12) } })).status, 403);
  assert.equal((await request(port, "/api/admin/unknown")).status, 403);
});
