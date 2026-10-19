// Run after npm run build: node tests/unit/auth-start-smoke.mjs
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "tango-donego-auth-smoke-"));
const origin = "http://127.0.0.1:5231";
const cookieFile = join(directory, "cookies.txt");
const upstream = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/v1/models" ? { data: [{ id: "smoke-model" }] } : { model: "smoke-model", choices: [{ message: { content: "OK" } }] }));
  });
});
let child;
let closed;
let stdout = "";
let stderr = "";
try {
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  child = spawn("npm", ["start"], {
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
      if (stdout.includes(`API+dist on ${origin}`)) { clearTimeout(timer); resolve(); }
    });
  });
  const curl = async (path, { method = "GET", body, expected = 200, cookie = cookieFile } = {}) => {
    const args = ["--silent", "--show-error", "--max-time", "10", "--write-out", "\n%{http_code}", "--cookie", cookie, "--cookie-jar", cookieFile, "--header", "x-tango-client: tango-settings/1", "--header", `Origin: ${origin}`, "--header", "Content-Type: application/json", "--request", method, origin + path];
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
  await curl("/api/auth/send-code", { method: "POST", body: { email: "smoke@example.com" } });
  const code = stdout.match(/\[Tango Done&Go local verification\] smoke@example\.com register (\d{6})/)?.[1];
  assert.ok(code, "Console email code must be observed in npm start stdout");
  const registration = await curl("/api/auth/register", { method: "POST", body: { email: "smoke@example.com", code, password: "Local smoke password 123456" } });
  assert.equal(registration.user.role, "admin");
  const me = await curl("/api/auth/me");
  assert.equal(me.user.id, registration.user.id);
  const sessionRow = (await readFile(cookieFile, "utf8")).split("\n").find((line) => line.includes("\ttango_session\t"));
  assert.ok(sessionRow, "The signed session must be present in the curl cookie jar");
  const sessionCookie = "tango_session=" + sessionRow.split("\t")[6];
  const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
  const settings = { candidate: { protocol: "openai", baseUrl, modelsUrl: `${baseUrl}/v1/models`, messagesUrl: `${baseUrl}/v1/chat/completions`, model: "smoke-model" }, apiKey: "test-only-smoke-key" };
  const proof = await curl("/api/settings/llm/test", { method: "POST", body: settings });
  assert.equal(proof.ok, true);
  const saved = await curl("/api/settings/llm", { method: "POST", body: { ...settings, proofToken: proof.proofToken } });
  assert.equal(saved.enabled, true);
  assert.equal((await stat(join(directory, "settings.json"))).isFile(), true);
  await curl("/api/auth/logout", { method: "POST", body: {} });
  assert.equal((await curl("/api/auth/me", { expected: 401 })).error, "AUTH_REQUIRED");
  await curl("/api/settings/llm", { expected: 401 });
  assert.equal((await curl("/api/auth/me", { expected: 401, cookie: sessionCookie })).error, "AUTH_INVALID");
  console.log("VERIFIED: npm start, console-code registration, admin session, local upstream proof/save, logout and revoked access.");
} finally {
  if (child && child.exitCode === null) {
    process.kill(-child.pid, "SIGTERM");
    await closed;
  }
  upstream.closeIdleConnections();
  await new Promise((resolve) => upstream.close(resolve));
  await rm(directory, { recursive: true, force: true });
  console.log("Temporary auth database, settings, cookie jar and server processes cleaned up.");
}
