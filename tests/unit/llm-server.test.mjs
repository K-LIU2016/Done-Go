import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import net from "node:net";
import { mkdtemp, mkdir, writeFile, readFile, stat, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { request as httpRequest } from "node:http";
import { createAppServer } from "../../server/app.mjs";
import { runLlmInference } from "../../server/upstream.mjs";
import { validateUpstreamUrl, validateCandidate } from "../../server/urlguard.mjs";

const CLIENT = "tango-settings/1";
const FAKE_KEY = "sk-tango-donego-fake-server-key-0042";

function startFixture() {
  const state = { requests: [], hang: [] };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const auth = req.headers["x-api-key"] || req.headers["authorization"] || "";
      const authed = auth === FAKE_KEY || auth === "Bearer " + FAKE_KEY;
      state.requests.push({ method: req.method, path: req.url, authed });
      const send = (status, obj) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.url === "/v1/models" && req.method === "GET") {
        if (!authed) return send(401, { error: { type: "authentication_error", message: "invalid x-api-key " + FAKE_KEY } });
        return send(200, { data: [{ id: "model-a" }, { id: "model-b" }] });
      }
      if (req.url === "/v1/messages" && req.method === "POST") {
        if (!authed) return send(401, { error: { type: "authentication_error", message: "invalid x-api-key " + FAKE_KEY } });
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        state.requests[state.requests.length - 1].maxTokens = body.max_tokens;
        if (body.model !== "model-a") return send(404, { error: { type: "not_found_error", message: "model: " + body.model + " not found" } });
        // Real providers can answer HTTP 200 with an empty completion when
        // the max_tokens budget is too small to emit any text at all.
        if ((body.max_tokens ?? 0) < 256) {
          return send(200, { id: "msg_truncated", model: body.model, content: [] });
        }
        return send(200, { id: "msg_1", model: body.model, content: [{ type: "text", text: "OK-测试" }] });
      }
      if (req.url === "/v1/messages/hang" && req.method === "POST") {
        const entry = { closed: false };
        state.hang.push(entry);
        req.on("close", () => {
          entry.closed = true;
        });
        // Never responds: used to observe downstream disconnect cancellation.
        return;
      }
      if (req.url === "/v1/chat/completions" && req.method === "POST") {
        if (!authed) return send(401, { error: { message: "Incorrect API key provided: " + FAKE_KEY } });
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        return send(200, { id: "chatcmpl_1", model: body.model, choices: [{ message: { role: "assistant", content: "OK-测试" } }] });
      }
      if (req.url === "/v1/messages/slow" && req.method === "POST") {
        setTimeout(() => send(200, { content: [{ type: "text", text: "late" }] }), 2000);
        return;
      }
      if (req.url === "/v1/models-redirect") {
        res.writeHead(302, { location: "/v1/redirect-target" });
        return res.end();
      }
      if (req.url === "/v1/messages-redirect") {
        res.writeHead(302, { location: "/v1/redirect-target" });
        return res.end();
      }
      if (req.url === "/v1/redirect-target") {
        state.requests.push({ method: req.method, path: req.url, authed });
        return send(200, { data: [] });
      }
      send(404, { error: { message: "no route" } });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, state }));
  });
}

function rawRequest(port, method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function makeApp(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "tango-donego-srv-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const distDir = join(dir, "dist");
  await mkdir(distDir);
  await writeFile(join(distDir, "index.html"), "<html>tango-donego-test-dist</html>");
  const logLines = [];
  const app = createAppServer({
    host: "127.0.0.1",
    port: 0,
    settingsFile: join(dir, "settings", "llm.json"),
    distDir,
    log: (line) => logLines.push(line),
    ...options,
  });
  const port = await app.start();
  t.after(() => app.close());
  return { app, port, dir, logLines, settingsFile: join(dir, "settings", "llm.json") };
}

function candidateFor(port, overrides = {}) {
  const base = "http://127.0.0.1:" + port;
  return {
    protocol: "anthropic",
    baseUrl: base,
    messagesUrl: base + "/v1/messages",
    modelsUrl: base + "/v1/models",
    model: "model-a",
    ...overrides,
  };
}

function api(port, method, path, body, extraHeaders = {}) {
  return fetch("http://127.0.0.1:" + port + path, {
    method,
    headers: {
      "content-type": "application/json",
      "x-tango-client": CLIENT,
      origin: "http://127.0.0.1:" + port,
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.text() }));
}

async function writePersistedRecord(settingsFile, candidate, overrides = {}) {
  const record = {
    version: 1,
    protocol: candidate.protocol,
    baseUrl: candidate.baseUrl,
    messagesUrl: candidate.messagesUrl,
    modelsUrl: candidate.modelsUrl,
    model: candidate.model,
    apiKey: FAKE_KEY,
    enabled: true,
    verifiedAt: "2026-09-12T00:00:00.000Z",
    savedFingerprint: "stored-fingerprint",
    ...overrides,
  };
  await writeFile(settingsFile, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
}

let fx;

beforeEach(async () => {
  fx = await startFixture();
});

afterEach(() => {
  fx.server.close();
});

test("test endpoint runs models and inference stages and issues a bounded proof", async (t) => {
  const { port } = await makeApp(t);
  const res = await api(port, "POST", "/api/settings/llm/test", { candidate: candidateFor(fx.port), apiKey: FAKE_KEY });
  const body = JSON.parse(res.body);
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.models.ok, true);
  assert.deepEqual(body.models.models, ["model-a", "model-b"]);
  assert.equal(body.inference.ok, true);
  assert.equal(body.inference.model, "model-a");
  assert.match(body.proofToken, /^[0-9a-f]{32,}$/);
});

test("save requires matching proof; verified save persists safe settings with 0600/0700 modes", async (t) => {
  const { port, settingsFile } = await makeApp(t);
  const candidate = candidateFor(fx.port);
  const noProof = await api(port, "POST", "/api/settings/llm", { candidate, apiKey: FAKE_KEY });
  assert.equal(noProof.status, 403);
  const tested = JSON.parse((await api(port, "POST", "/api/settings/llm/test", { candidate, apiKey: FAKE_KEY })).body);
  const saved = await api(port, "POST", "/api/settings/llm", { candidate, apiKey: FAKE_KEY, proofToken: tested.proofToken });
  assert.equal(saved.status, 200);
  assert.ok(!saved.body.includes(FAKE_KEY));
  const got = JSON.parse((await api(port, "GET", "/api/settings/llm", undefined)).body);
  assert.equal(got.hasApiKey, true);
  assert.equal(got.enabled, true);
  assert.equal(got.verified, true);
  assert.equal(got.apiKey, undefined);
  if (process.platform !== "win32") {
    const fileStat = await stat(settingsFile);
    assert.equal(fileStat.mode & 0o777, 0o600);
    const dirStat = await stat(join(settingsFile, ".."));
    assert.equal(dirStat.mode & 0o777, 0o700);
  }
  const stored = JSON.parse(await readFile(settingsFile, "utf8"));
  assert.equal(stored.apiKey, FAKE_KEY);
});

test("editing model or key after a successful test invalidates the green proof", async (t) => {
  const { port } = await makeApp(t);
  const candidate = candidateFor(fx.port);
  const tested = JSON.parse((await api(port, "POST", "/api/settings/llm/test", { candidate, apiKey: FAKE_KEY })).body);
  const editedModel = await api(port, "POST", "/api/settings/llm", {
    candidate: candidateFor(fx.port, { model: "model-b" }),
    apiKey: FAKE_KEY,
    proofToken: tested.proofToken,
  });
  assert.equal(editedModel.status, 403);
  const editedKey = await api(port, "POST", "/api/settings/llm", {
    candidate,
    apiKey: "sk-tango-donego-fake-other-key-0009",
    proofToken: tested.proofToken,
  });
  assert.equal(editedKey.status, 403);
  const editedBase = await api(port, "POST", "/api/settings/llm", {
    candidate: candidateFor(fx.port, { baseUrl: "http://127.0.0.1:1", messagesUrl: "http://127.0.0.1:1/v1/messages", modelsUrl: "http://127.0.0.1:1/v1/models" }),
    apiKey: FAKE_KEY,
    proofToken: tested.proofToken,
  });
  assert.equal(editedBase.status, 403);
});

test("restart keeps verified config and generate returns model text with requestId", async (t) => {
  const first = await makeApp(t);
  const candidate = candidateFor(fx.port);
  const tested = JSON.parse((await api(first.port, "POST", "/api/settings/llm/test", { candidate, apiKey: FAKE_KEY })).body);
  await api(first.port, "POST", "/api/settings/llm", { candidate, apiKey: FAKE_KEY, proofToken: tested.proofToken });
  await first.app.close();
  const dir = first.dir;
  const second = createAppServer({
    host: "127.0.0.1",
    port: 0,
    settingsFile: first.settingsFile,
    distDir: join(dir, "dist"),
    log: () => {},
  });
  const port2 = await second.start();
  t.after(() => second.close());
  const got = JSON.parse((await api(port2, "GET", "/api/settings/llm", undefined)).body);
  assert.equal(got.enabled, true);
  assert.equal(got.verified, true);
  assert.equal(got.hasApiKey, true);
  const gen = await api(port2, "POST", "/api/llm/generate", { purpose: "draft", input: "帮我把这句话整理成草稿" });
  assert.equal(gen.status, 200);
  const genBody = JSON.parse(gen.body);
  assert.equal(genBody.text, "OK-测试");
  assert.equal(genBody.model, "model-a");
  assert.match(genBody.requestId, /^gen-/);
  assert.ok(!gen.body.includes(FAKE_KEY));
});

test("wrong key reports auth errors per stage without leaking upstream raw message", async (t) => {
  const { port } = await makeApp(t);
  const res = await api(port, "POST", "/api/settings/llm/test", { candidate: candidateFor(fx.port), apiKey: "sk-wrong" });
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.models.ok, false);
  assert.equal(body.models.error, "auth_error");
  assert.equal(body.inference.ok, false);
  assert.equal(body.inference.error, "auth_error");
  assert.ok(!res.body.includes("invalid x-api-key"));
  assert.ok(!res.body.includes(FAKE_KEY));
});

test("model missing from list fails distinctly from list and inference errors", async (t) => {
  const { port } = await makeApp(t);
  const res = await api(port, "POST", "/api/settings/llm/test", {
    candidate: candidateFor(fx.port, { model: "model-z" }),
    apiKey: FAKE_KEY,
  });
  const body = JSON.parse(res.body);
  assert.equal(body.models.ok, true);
  assert.deepEqual(body.models.models, ["model-a", "model-b"]);
  assert.equal(body.inference.ok, false);
  assert.equal(body.inference.error, "model_not_listed");
  assert.equal(body.ok, false);
});

test("slow upstream inference is bounded and reported as timeout", async (t) => {
  const { port } = await makeApp(t, { upstreamTimeoutMs: 400 });
  const started = Date.now();
  const res = await api(port, "POST", "/api/settings/llm/test", {
    candidate: candidateFor(fx.port, { messagesUrl: "http://127.0.0.1:" + fx.port + "/v1/messages/slow" }),
    apiKey: FAKE_KEY,
  });
  const body = JSON.parse(res.body);
  assert.equal(body.inference.ok, false);
  assert.equal(body.inference.error, "timeout");
  assert.ok(Date.now() - started < 1500);
});

test("redirects are blocked and credentials never reach the redirect target", async (t) => {
  const { port } = await makeApp(t);
  const res = await api(port, "POST", "/api/settings/llm/test", {
    candidate: candidateFor(fx.port, { modelsUrl: "http://127.0.0.1:" + fx.port + "/v1/models-redirect" }),
    apiKey: FAKE_KEY,
  });
  const body = JSON.parse(res.body);
  assert.equal(body.models.ok, false);
  assert.equal(body.models.error, "redirect_blocked");
  const targetCalls = fx.state.requests.filter((r) => r.path === "/v1/redirect-target");
  assert.equal(targetCalls.length, 0);
});

test("url guard rejects non-loopback http, credentials, query, hash and metadata hosts", () => {
  assert.throws(() => validateUpstreamUrl("http://example.com/v1/messages"), /https_required/);
  assert.throws(() => validateUpstreamUrl("https://user:pass@example.com/v1"), /credentials_in_url/);
  assert.throws(() => validateUpstreamUrl("https://example.com/v1/messages?x=1"), /query_not_allowed/);
  assert.throws(() => validateUpstreamUrl("https://example.com/v1/messages#frag"), /hash_not_allowed/);
  assert.throws(() => validateUpstreamUrl("http://169.254.169.254/latest/meta-data"), /blocked_host/);
  assert.throws(() => validateUpstreamUrl("http://fe80::1/v1"), /blocked_host/);
  assert.doesNotThrow(() => validateUpstreamUrl("http://127.0.0.1:65396/v1/messages"));
  assert.doesNotThrow(() => validateUpstreamUrl("http://localhost:65396/v1/messages"));
  assert.doesNotThrow(() => validateUpstreamUrl("https://api.example.com/v1/messages"));
});

test("endpoint origins must share the base origin", () => {
  const bad = validateCandidate({
    protocol: "anthropic",
    baseUrl: "http://127.0.0.1:65396",
    messagesUrl: "http://127.0.0.2:65396/v1/messages",
    modelsUrl: "http://127.0.0.1:65396/v1/models",
    model: "model-a",
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.join(" ").includes("origin_mismatch"));
  const good = validateCandidate(candidateFor(65396));
  assert.equal(good.ok, true);
});

test("mutations enforce client header, loopback host, trusted origin and json body", async (t) => {
  const { port } = await makeApp(t);
  const payload = JSON.stringify({ candidate: candidateFor(fx.port), apiKey: FAKE_KEY });
  const noClient = await rawRequest(port, "POST", "/api/settings/llm/test", { "content-type": "application/json", host: "127.0.0.1:" + port }, payload);
  assert.equal(noClient.status, 403);
  const evilOrigin = await rawRequest(port, "POST", "/api/settings/llm/test", {
    "content-type": "application/json",
    "x-tango-client": CLIENT,
    origin: "https://evil.example",
    host: "127.0.0.1:" + port,
  }, payload);
  assert.equal(evilOrigin.status, 403);
  const evilHost = await rawRequest(port, "POST", "/api/settings/llm/test", {
    "content-type": "application/json",
    "x-tango-client": CLIENT,
    host: "evil.example",
  }, payload);
  assert.equal(evilHost.status, 403);
  const notJson = await rawRequest(port, "POST", "/api/settings/llm/test", {
    "content-type": "text/plain",
    "x-tango-client": CLIENT,
    host: "127.0.0.1:" + port,
  }, payload);
  assert.equal(notJson.status, 415);
});

test("oversized request bodies are rejected", async (t) => {
  const { port } = await makeApp(t, { maxBodyBytes: 1024 });
  const big = await api(port, "POST", "/api/llm/generate", { purpose: "draft", input: "x".repeat(5000) });
  assert.equal(big.status, 413);
});

test("generate guards purpose, empty input and unconfigured state", async (t) => {
  const { port } = await makeApp(t);
  const notConfigured = await api(port, "POST", "/api/llm/generate", { purpose: "draft", input: "hello" });
  assert.equal(notConfigured.status, 409);
  assert.ok(JSON.parse(notConfigured.body).error === "not_configured");
  const badPurpose = await api(port, "POST", "/api/llm/generate", { purpose: "email", input: "hello" });
  assert.equal(badPurpose.status, 400);
  const emptyInput = await api(port, "POST", "/api/llm/generate", { purpose: "draft", input: "  " });
  assert.equal(emptyInput.status, 400);
});

test("disconnect clears the key, disables generate and persists", async (t) => {
  const { port, settingsFile } = await makeApp(t);
  const candidate = candidateFor(fx.port);
  const tested = JSON.parse((await api(port, "POST", "/api/settings/llm/test", { candidate, apiKey: FAKE_KEY })).body);
  await api(port, "POST", "/api/settings/llm", { candidate, apiKey: FAKE_KEY, proofToken: tested.proofToken });
  const off = await api(port, "DELETE", "/api/settings/llm", undefined);
  assert.equal(off.status, 200);
  const got = JSON.parse((await api(port, "GET", "/api/settings/llm", undefined)).body);
  assert.equal(got.hasApiKey, false);
  assert.equal(got.enabled, false);
  assert.equal(got.verified, false);
  const gen = await api(port, "POST", "/api/llm/generate", { purpose: "draft", input: "hello" });
  assert.equal(gen.status, 409);
  const stored = JSON.parse(await readFile(settingsFile, "utf8"));
  assert.equal(stored.apiKey, "");
});

test("static serving blocks traversal and api unknown routes return json 404", async (t) => {
  const { port } = await makeApp(t);
  const home = await rawRequest(port, "GET", "/", { host: "127.0.0.1:" + port });
  assert.equal(home.status, 200);
  assert.ok(home.body.includes("tango-donego-test-dist"));
  const traversal = await rawRequest(port, "GET", "/../server/app.mjs", { host: "127.0.0.1:" + port });
  assert.equal(traversal.status, 403);
  const encoded = await rawRequest(port, "GET", "/%2e%2e/server/app.mjs", { host: "127.0.0.1:" + port });
  assert.ok(encoded.status === 403 || encoded.status === 404);
  assert.ok(!encoded.body.includes("createAppServer"));
  const apiMiss = await api(port, "GET", "/api/nope", undefined);
  assert.equal(apiMiss.status, 404);
  assert.equal(JSON.parse(apiMiss.body).error, "not_found");
});

test("save failure keeps previous settings and returns sanitized error", async (t) => {
  const { port, settingsFile } = await makeApp(t);
  const candidate = candidateFor(fx.port);
  const tested = JSON.parse((await api(port, "POST", "/api/settings/llm/test", { candidate, apiKey: FAKE_KEY })).body);
  const firstSave = await api(port, "POST", "/api/settings/llm", { candidate, apiKey: FAKE_KEY, proofToken: tested.proofToken });
  assert.equal(firstSave.status, 200);
  if (process.platform !== "win32") {
    await chmod(join(settingsFile, ".."), 0o500);
    try {
      const second = await api(port, "POST", "/api/settings/llm", { candidate, apiKey: FAKE_KEY, proofToken: tested.proofToken });
      assert.equal(second.status, 500);
      assert.equal(JSON.parse(second.body).error, "persist_failed");
      assert.ok(!second.body.includes(FAKE_KEY));
    } finally {
      await chmod(join(settingsFile, ".."), 0o700);
    }
  }
});

test("server logs never contain the candidate key", async (t) => {
  const { port, logLines } = await makeApp(t);
  const candidate = candidateFor(fx.port);
  await api(port, "POST", "/api/settings/llm/test", { candidate, apiKey: FAKE_KEY });
  const testedBody = JSON.parse((await api(port, "POST", "/api/settings/llm/test", { candidate, apiKey: FAKE_KEY })).body);
  await api(port, "POST", "/api/settings/llm", { candidate, apiKey: FAKE_KEY, proofToken: testedBody.proofToken });
  await api(port, "POST", "/api/llm/generate", { purpose: "draft", input: "test input" });
  const joined = logLines.join("\n");
  assert.ok(!joined.includes(FAKE_KEY));
  assert.ok(!joined.includes("authorization"));
  assert.ok(!joined.includes("x-api-key"));
});

test("connectivity test uses a bounded 256 completion; tiny budgets truncate to a typed failure", async (t) => {
  const { port } = await makeApp(t);
  const res = await api(port, "POST", "/api/settings/llm/test", { candidate: candidateFor(fx.port), apiKey: FAKE_KEY });
  const body = JSON.parse(res.body);
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.inference.ok, true);
  const inferenceCalls = fx.state.requests.filter((r) => r.path === "/v1/messages");
  assert.ok(inferenceCalls.length >= 1);
  assert.equal(inferenceCalls[inferenceCalls.length - 1].maxTokens, 256);
  // A 16-token completion against a provider that truncates to empty text
  // must fail as a typed upstream error, never pass as a green proof.
  await assert.rejects(
    runLlmInference(candidateFor(fx.port), FAKE_KEY, { system: "s", user: "u" }, { maxTokens: 16 }),
    (err) => err.code === "bad_response",
  );
});

test("connection proof expires after its bounded validity window", async (t) => {
  const { port } = await makeApp(t, { proofTtlMs: 30 });
  const candidate = candidateFor(fx.port);
  const tested = JSON.parse((await api(port, "POST", "/api/settings/llm/test", { candidate, apiKey: FAKE_KEY })).body);
  await new Promise((resolveTimer) => setTimeout(resolveTimer, 60));
  const expired = await api(port, "POST", "/api/settings/llm", { candidate, apiKey: FAKE_KEY, proofToken: tested.proofToken });
  assert.equal(expired.status, 403);
  assert.equal(JSON.parse(expired.body).error, "proof_required");
  // A fresh proof inside the window still saves: expiry, not the token, was the cause.
  const fresh = JSON.parse((await api(port, "POST", "/api/settings/llm/test", { candidate, apiKey: FAKE_KEY })).body);
  const saved = await api(port, "POST", "/api/settings/llm", { candidate, apiKey: FAKE_KEY, proofToken: fresh.proofToken });
  assert.equal(saved.status, 200);
});

test("generate fails closed for an enabled-but-unverified persisted record", async (t) => {
  const { port, settingsFile } = await makeApp(t);
  const candidate = candidateFor(fx.port);
  await mkdir(dirname(settingsFile), { recursive: true, mode: 0o700 });
  await writePersistedRecord(settingsFile, candidate, { savedFingerprint: null, verifiedAt: null });
  const gen = await api(port, "POST", "/api/llm/generate", { purpose: "draft", input: "hello" });
  assert.equal(gen.status, 409);
  assert.equal(JSON.parse(gen.body).error, "not_configured");
  const upstreamCalls = fx.state.requests.filter((r) => r.path === "/v1/messages");
  assert.equal(upstreamCalls.length, 0);
  const got = JSON.parse((await api(port, "GET", "/api/settings/llm", undefined)).body);
  assert.equal(got.enabled, true);
  assert.equal(got.verified, false);
  // With the saved fingerprint present the record matches the GET verified
  // contract and generate proceeds against the fake upstream.
  await writePersistedRecord(settingsFile, candidate);
  const gen2 = await api(port, "POST", "/api/llm/generate", { purpose: "draft", input: "hello" });
  assert.equal(gen2.status, 200);
  assert.equal(JSON.parse(gen2.body).text, "OK-测试");
});

test("oversized bodies receive the typed 413 response instead of a connection reset", async (t) => {
  const { port } = await makeApp(t, { maxBodyBytes: 1024 });
  const total = 512 * 1024;
  const outcome = await new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const chunks = [];
    const headers = [
      "POST /api/llm/generate HTTP/1.1",
      "Host: 127.0.0.1:" + port,
      "Content-Type: application/json",
      "x-tango-client: " + CLIENT,
      "Content-Length: " + total,
      "Connection: close",
      "",
      "",
    ].join("\r\n");
    socket.on("connect", () => {
      socket.write(headers);
      const chunk = Buffer.alloc(16 * 1024, 0x61);
      for (let written = 0; written < total; written += chunk.length) socket.write(chunk);
      socket.end();
    });
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", (err) => resolve({ status: 0, body: "", error: err.code }));
    socket.on("close", () => resolve({ status: 0, body: Buffer.concat(chunks).toString("utf8"), error: null }));
  });
  assert.equal(outcome.error, null);
  const statusLine = outcome.body.split("\r\n", 1)[0];
  assert.equal(statusLine, "HTTP/1.1 413 Payload Too Large");
  const payloadStart = outcome.body.indexOf("\r\n\r\n") + 4;
  assert.equal(JSON.parse(outcome.body.slice(payloadStart)).error, "body_too_large");
});

test("closing the response stops outstanding upstream inference work", async (t) => {
  const { port, settingsFile } = await makeApp(t);
  const candidate = candidateFor(fx.port, { messagesUrl: "http://127.0.0.1:" + fx.port + "/v1/messages/hang" });
  await mkdir(dirname(settingsFile), { recursive: true, mode: 0o700 });
  await writePersistedRecord(settingsFile, candidate);
  await new Promise((resolve) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/api/llm/generate",
      headers: {
        "content-type": "application/json",
        "x-tango-client": CLIENT,
      },
    }, () => resolve());
    req.on("error", () => resolve());
    req.end(JSON.stringify({ purpose: "draft", input: "hello" }));
    const waitOpen = setInterval(() => {
      if (fx.state.hang.length > 0) {
        clearInterval(waitOpen);
        req.destroy();
      }
    }, 10);
  });
  assert.ok(fx.state.hang.length >= 1, "upstream hang request was never opened");
  await new Promise((resolveTimer) => setTimeout(resolveTimer, 300));
  assert.equal(fx.state.hang[0].closed, true, "upstream work continued after the client disconnected");
  const meta = await api(port, "GET", "/api/settings/llm", undefined);
  assert.equal(meta.status, 200);
});
