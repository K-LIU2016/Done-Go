// Run after npm run build: node tests/unit/auth-start-smoke.mjs
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "tango-donego-auth-smoke-"));
const origin = "http://127.0.0.1:5231";
const cookieFile = join(directory, "cookies.txt");
let child;
let closed;
let stdout = "";
let stderr = "";
try {
  // npm start runs "node scripts/serve-tango.mjs"; spawn the interpreter directly so
  // Windows does not need a shell to launch npm.cmd (blocked with EINVAL since Node 18.20).
  child = spawn(process.execPath, ["scripts/serve-tango.mjs"], {
    cwd: root,
    detached: true,
    env: { ...process.env, TANGO_DEV: "0", TANGO_AUTH_DISABLED: "0", TANGO_HOST: "127.0.0.1", TANGO_PORT: "5231", TANGO_AUTH_SECRET: randomBytes(48).toString("base64url"), TANGO_AUTH_DB: join(directory, "auth.sqlite"), TANGO_SETTINGS_FILE: join(directory, "settings.json"), TANGO_PUBLIC_ORIGIN: "", NODE_ENV: "development", ENV: "development", EMAIL_TRANSPORT: "console", ADMIN_EMAILS: "smoke@example.com" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  closed = once(child, "exit");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Startup timed out: ${stderr}`)), 10000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", () => { clearTimeout(timer); reject(new Error(`Startup exited: ${stderr}`)); });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes(`Tango local server: ${origin}`)) { clearTimeout(timer); resolve(); }
    });
  });
  const curl = async (path, { method = "GET", body, expected = 200, cookie = cookieFile, headers = {} } = {}) => {
    const args = ["--silent", "--show-error", "--max-time", "10", "--write-out", "\n%{http_code}", "--cookie-jar", cookieFile, "--header", "x-tango-client: tango-settings/1", "--header", `Origin: ${origin}`, "--header", "Content-Type: application/json"];
    if (cookie) args.push("--cookie", cookie);
    for (const [name, value] of Object.entries(headers)) args.push("--header", `${name}: ${value}`);
    args.push("--request", method, origin + path);
    if (body !== undefined) args.push("--data-binary", JSON.stringify(body));
    const result = await exec("curl", args);
    const index = result.stdout.lastIndexOf("\n");
    const status = Number(result.stdout.slice(index + 1));
    const response = JSON.parse(result.stdout.slice(0, index));
    assert.equal(status, expected, `${method} ${path}: ${JSON.stringify(response)}`);
    console.log(`${method} ${path} -> ${status}`);
    return response;
  };
  const status = await curl("/api/auth/status");
  assert.equal(status.enabled, true);
  assert.equal(status.codeLogin, false);
  assert.equal(status.registrationEnabled, true);
  const email = "smoke@example.com";
  const password = "SmokePass123";
  const registration = await curl("/api/auth/register", { method: "POST", body: { email, password, confirmPassword: password } });
  assert.equal(registration.user.role, "admin");
  // requireLoginAfterRegistration keeps the first registration response session-free.
  const login = await curl("/api/auth/login", { method: "POST", body: { email, password } });
  assert.equal(login.user.id, registration.user.id);
  const me = await curl("/api/auth/me");
  assert.equal(me.user.id, registration.user.id);
  // serve-tango exposes the authenticated assistant config instead of /api/settings/llm.
  await curl("/api/assistant/config");
  // Phone accounts register directly with a password and sign in with the same identifier.
  const phone = "+86138000000" + String(Math.floor(Math.random() * 90) + 10);
  const phoneRegistration = await curl("/api/auth/register", { method: "POST", body: { phone, password, confirmPassword: password } });
  assert.equal(phoneRegistration.user.phone, phone);
  const phoneLogin = await curl("/api/auth/login", { method: "POST", body: { identifier: phone, password } });
  assert.equal(phoneLogin.user.id, phoneRegistration.user.id);
  const sessionRow = (await readFile(cookieFile, "utf8")).split("\n").find((line) => line.includes("\ttango_collaboration_session\t"));
  assert.ok(sessionRow, "The signed session must be present in the curl cookie jar");
  const sessionCookie = "tango_collaboration_session=" + sessionRow.split("\t")[6];
  await curl("/api/auth/logout", { method: "POST", body: {} });
  assert.equal((await curl("/api/auth/me", { expected: 401 })).error, "AUTH_REQUIRED");
  await curl("/api/assistant/config", { expected: 401 });
  const revoked = await fetch(origin + "/api/auth/me", { headers: { "x-tango-client": "tango-settings/1", origin: origin, cookie: sessionCookie } });
  assert.equal(revoked.status, 401);
  assert.equal((await revoked.json()).error, "AUTH_INVALID");
  console.log("VERIFIED: npm start, direct email/phone registration, password login, admin session, logout and revoked access.");
} finally {
  if (child && child.exitCode === null) {
    // Windows has no POSIX process groups; the child is the server process itself.
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
    await closed;
  }
  await rm(directory, { recursive: true, force: true });
  console.log("Temporary auth database, settings, cookie jar and server processes cleaned up.");
}
