import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateUpstreamUrl } from "../../server/urlguard.mjs";
import { loadSettings, saveSettings, SettingsStoreError } from "../../server/settingsStore.mjs";
import { fetchModelList, runLlmInference } from "../../server/upstream.mjs";
import { createAppServer } from "../../server/app.mjs";

const FAKE_KEY = "sk-tango-donego-fake-security-key-0001";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
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

test("url guard canonicalizes ipv4-mapped ipv6 and blocks private ranges", () => {
  assert.throws(() => validateUpstreamUrl("http://[::ffff:169.254.169.254]/v1/messages"), /blocked_host/);
  assert.throws(() => validateUpstreamUrl("http://[::ffff:a9fe:a9fe]/v1/messages"), /blocked_host/);
  assert.throws(() => validateUpstreamUrl("https://10.0.0.5/v1/messages"), /blocked_host/);
  assert.throws(() => validateUpstreamUrl("https://192.168.1.5/v1/messages"), /blocked_host/);
  assert.throws(() => validateUpstreamUrl("https://[fd00::1]/v1/messages"), /blocked_host/);
  assert.doesNotThrow(() => validateUpstreamUrl("http://[::ffff:127.0.0.1]/v1/messages"));
  assert.doesNotThrow(() => validateUpstreamUrl("https://api.example.com/v1/messages"));
});

test("store: missing is empty; corrupt is explicit and raw preserved", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "tango-donego-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "llm.json");
  const empty = await loadSettings(file);
  assert.equal(empty.enabled, false);
  const corruptText = "{ this is not json";
  await writeFile(file, corruptText);
  await assert.rejects(
    () => loadSettings(file),
    (err) => err instanceof SettingsStoreError && err.code === "settings_corrupt",
  );
  if (process.platform !== "win32") {
    await chmod(dir, 0o500);
    try {
      await assert.rejects(
        () => saveSettings(file, { ...JSON.parse(JSON.stringify({})) }),
        (err) => err instanceof SettingsStoreError && err.code === "persist_failed",
      );
    } finally {
      await chmod(dir, 0o700);
    }
  }
  assert.equal(await readFile(file, "utf8"), corruptText);
});

test("store: unreadable file is an explicit error, not an empty config", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "tango-donego-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "llm.json");
  await writeFile(file, JSON.stringify({ apiKey: "x" }));
  if (process.platform !== "win32") {
    await chmod(file, 0o000);
    try {
      await assert.rejects(
        () => loadSettings(file),
        (err) => err instanceof SettingsStoreError && err.code === "settings_unreadable",
      );
    } finally {
      await chmod(file, 0o600);
    }
  }
});

test("upstream: oversized response body is bounded and cancelled", async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    const chunk = Buffer.alloc(128 * 1024, 0x61);
    let sent = 0;
    const timer = setInterval(() => {
      sent += chunk.length;
      if (sent > 3 * 1024 * 1024) {
        clearInterval(timer);
        res.end();
        return;
      }
      res.write(chunk);
    }, 1);
    res.on("close", () => clearInterval(timer));
  });
  const port = await listen(server);
  t.after(() => server.close());
  await assert.rejects(
    () => fetchModelList(candidateFor(port), FAKE_KEY, { timeoutMs: 8000 }),
    (err) => err.code === "response_too_large",
  );
});

test("upstream: timeout while reading the body stays timeout", async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"data": [');
  });
  const port = await listen(server);
  t.after(() => server.close());
  await assert.rejects(
    () => fetchModelList(candidateFor(port), FAKE_KEY, { timeoutMs: 350 }),
    (err) => err.code === "timeout",
  );
});

test("upstream: configured model and upstream-reported model stay separate", async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "msg_1", model: "served-by-upstream", content: [{ type: "text", text: "OK" }] }));
  });
  const port = await listen(server);
  t.after(() => server.close());
  const result = await runLlmInference(candidateFor(port, { model: "requested-model" }), FAKE_KEY, {
    system: "s",
    user: "u",
  });
  assert.equal(result.model, "requested-model");
  assert.equal(result.responseModel, "served-by-upstream");
});

test("upstream: generated text is capped", async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ content: [{ type: "text", text: "x".repeat(25000) }] }));
  });
  const port = await listen(server);
  t.after(() => server.close());
  await assert.rejects(
    () => runLlmInference(candidateFor(port), FAKE_KEY, { system: "s", user: "u" }),
    (err) => err.code === "text_too_large",
  );
});

test("app: corrupt settings file returns explicit 503 and keeps raw data", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "tango-donego-app-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const settingsFile = join(dir, "llm.json");
  const corruptText = "[[[";
  await writeFile(settingsFile, corruptText);
  const app = createAppServer({
    host: "127.0.0.1",
    port: 0,
    settingsFile,
    distDir: join(dir, "dist"),
    log: () => {},
  });
  const port = await app.start();
  t.after(() => app.close());
  const headers = { "content-type": "application/json", "x-tango-client": "tango-settings/1" };
  const got = await fetch("http://127.0.0.1:" + port + "/api/settings/llm", { headers });
  assert.equal(got.status, 503);
  assert.equal(JSON.parse(await got.text()).error, "settings_corrupt");
  const gen = await fetch("http://127.0.0.1:" + port + "/api/llm/generate", {
    method: "POST",
    headers,
    body: JSON.stringify({ purpose: "draft", input: "hello" }),
  });
  assert.equal(gen.status, 503);
  const off = await fetch("http://127.0.0.1:" + port + "/api/settings/llm", { method: "DELETE", headers });
  assert.equal(off.status, 503);
  assert.equal(await readFile(settingsFile, "utf8"), corruptText);
});
