// Tango Done&Go API plus static dist serving. Without auth, administration stays
// loopback-only. Authenticated deployments may allow an exact public origin.
// Bodies and responses are bounded; upstream secrets stay out of logs.

import { createServer as createHttpServer } from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { isLoopbackHostname, validateCandidate } from "./urlguard.mjs";
import { loadSettings, saveSettings } from "./settingsStore.mjs";
import { fetchModelList, runLlmInference } from "./upstream.mjs";

const CLIENT_HEADER = "x-tango-client";
const CLIENT_VALUE = "tango-settings/1";
const MAX_INPUT_CHARS = 8000;
const MAX_KEY_CHARS = 512;

const TEST_PROMPT = Object.freeze({
  system: "You are a connection test endpoint. Reply with the single word OK.",
  user: "Reply with OK.",
});

// The minimal connectivity request must leave room for a real completion:
// tiny budgets (e.g. 16) can make providers answer HTTP 200 with an empty
// completion, which only proves the budget was too small, not connectivity.
const CONNECTIVITY_MAX_TOKENS = 256;

// A test proof only bridges the test -> save moment; it must expire.
const PROOF_TTL_MS = 10 * 60 * 1000;

const DRAFT_PROMPT_SYSTEM =
  "你是探戈 Done&Go 的草稿助手。基于用户输入整理出一条更清晰的草稿文本。" +
  "不添加虚构内容，不执行任何操作，直接输出草稿正文。";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function hostHostname(hostHeader) {
  if (typeof hostHeader !== "string" || !hostHeader) return "";
  if (hostHeader.startsWith("[")) {
    const end = hostHeader.indexOf("]");
    return end === -1 ? hostHeader.slice(1) : hostHeader.slice(1, end);
  }
  const colon = hostHeader.lastIndexOf(":");
  return colon === -1 ? hostHeader : hostHeader.slice(0, colon);
}

function readBody(req, maxBytes) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    // Delay the typed 413 until a modest oversized upload has drained. An
    // early response with unread socket bytes can become RST on Windows
    // before the peer reads the status. The absolute cap bounds the discard.
    const drainLimit = Math.max(maxBytes * 8, 1024 * 1024);
    let total = 0;
    let discarded = 0;
    let settled = false;
    let oversized = false;
    req.on("data", (chunk) => {
      if (settled || oversized) {
        discarded += chunk.length;
        if (discarded > drainLimit) req.destroy();
        return;
      }
      total += chunk.length;
      if (total > maxBytes) {
        oversized = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (oversized) {
        settled = true;
        rejectBody(Object.assign(new Error("too_large"), { code: "too_large" }));
        return;
      }
      if (settled) return;
      settled = true;
      resolveBody(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      rejectBody(err);
    });
  });
}

function fingerprintOf(hmacKey, candidate, apiKey) {
  return createHmac("sha256", hmacKey)
    .update(JSON.stringify({
      protocol: candidate.protocol,
      baseUrl: candidate.baseUrl,
      messagesUrl: candidate.messagesUrl,
      modelsUrl: candidate.modelsUrl,
      model: candidate.model,
      apiKey,
    }))
    .digest("hex");
}

export function createAppServer({
  host = "127.0.0.1",
  port = 0,
  settingsFile,
  distDir,
  log = () => {},
  upstreamTimeoutMs = 45000,
  maxBodyBytes = 256 * 1024,
  proofTtlMs = PROOF_TTL_MS,
  auth = null,
  publicOrigin = "",
}) {
  if (!settingsFile) throw new Error("settingsFile required");
  const distRoot = distDir ? resolve(distDir) : null;
  const proofs = new Map();
  const hmacKey = randomBytes(32);
  const publicHost = auth && publicOrigin ? new URL(publicOrigin).host : "";

  function guard(req, res) {
    const loopback = isLoopbackHostname(hostHostname(req.headers.host));
    const hostOk = loopback || (publicHost && req.headers.host === publicHost);
    if (!hostOk) {
      sendJson(res, 403, { error: "forbidden" });
      return false;
    }
    if (req.headers[CLIENT_HEADER] !== CLIENT_VALUE) {
      sendJson(res, 403, { error: "forbidden" });
      return false;
    }
    const origin = req.headers.origin;
    if (!loopback && !origin && req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 403, { error: "forbidden" });
      return false;
    }
    if (typeof origin === "string" && origin.length > 0) {
      try {
        const parsed = new URL(origin);
        if (!isLoopbackHostname(parsed.hostname) && !(publicHost && origin === publicOrigin)) {
          sendJson(res, 403, { error: "forbidden" });
          return false;
        }
      } catch {
        sendJson(res, 403, { error: "forbidden" });
        return false;
      }
    }
    return true;
  }

  async function handleSettingsTest(req, res, body) {
    const candidate = body && body.candidate;
    const apiKey = body && body.apiKey;
    const check = validateCandidate(candidate);
    if (!check.ok) {
      sendJson(res, 400, { error: "invalid_candidate", errors: check.errors });
      return;
    }
    if (typeof apiKey !== "string" || apiKey.length === 0 || apiKey.length > MAX_KEY_CHARS) {
      sendJson(res, 400, { error: "missing_key" });
      return;
    }
    const models = await fetchModelList(candidate, apiKey, { timeoutMs: upstreamTimeoutMs }).then(
      (r) => ({ ok: true, models: r.models }),
      (err) => ({ ok: false, error: err.code || "upstream_error", status: err.status }),
    );
    let inference;
    if (models.ok && !models.models.includes(candidate.model)) {
      inference = { ok: false, error: "model_not_listed" };
    } else {
      inference = await runInferenceStage(candidate, apiKey, TEST_PROMPT, CONNECTIVITY_MAX_TOKENS);
    }
    let proofToken;
    if (models.ok && inference.ok) {
      proofToken = randomBytes(24).toString("hex");
      const now = Date.now();
      for (const [key, record] of proofs) {
        if (record.expiresAt <= now) proofs.delete(key);
      }
      proofs.set(proofToken, {
        fingerprint: fingerprintOf(hmacKey, candidate, apiKey),
        expiresAt: now + proofTtlMs,
      });
      if (proofs.size > 32) {
        const oldest = proofs.keys().next().value;
        proofs.delete(oldest);
      }
    }
    log("settings.test models=" + (models.ok ? "ok" : models.error) + " inference=" + (inference.ok ? "ok" : inference.error));
    sendJson(res, 200, { ok: Boolean(models.ok && inference.ok), models, inference, proofToken });
  }

  async function runInferenceStage(candidate, apiKey, prompt, maxTokens, signal) {
    try {
      const r = await runLlmInference(candidate, apiKey, prompt, { maxTokens, timeoutMs: upstreamTimeoutMs, signal });
      const stage = { ok: true, model: r.model };
      if (r.responseModel && r.responseModel !== r.model) stage.responseModel = r.responseModel;
      return stage;
    } catch (err) {
      return { ok: false, error: err.code || "upstream_error", status: err.status };
    }
  }

  async function handleSettingsSave(req, res, body) {
    const candidate = body && body.candidate;
    const apiKey = body && body.apiKey;
    const proofToken = body && body.proofToken;
    const check = validateCandidate(candidate);
    if (!check.ok) {
      sendJson(res, 400, { error: "invalid_candidate", errors: check.errors });
      return;
    }
    if (typeof apiKey !== "string" || apiKey.length === 0 || apiKey.length > MAX_KEY_CHARS) {
      sendJson(res, 400, { error: "missing_key" });
      return;
    }
    const expected = fingerprintOf(hmacKey, candidate, apiKey);
    const recorded = typeof proofToken === "string" ? proofs.get(proofToken) : undefined;
    if (!recorded || recorded.fingerprint !== expected) {
      sendJson(res, 403, { error: "proof_required" });
      return;
    }
    if (Date.now() > recorded.expiresAt) {
      proofs.delete(proofToken);
      sendJson(res, 403, { error: "proof_required" });
      return;
    }
    try {
      await loadSettings(settingsFile);
    } catch (err) {
      sendJson(res, 503, { error: err.code || "settings_unreadable" });
      return;
    }
    const savedFingerprint = fingerprintOf(hmacKey, candidate, apiKey);
    const next = {
      version: 1,
      protocol: candidate.protocol,
      baseUrl: candidate.baseUrl,
      messagesUrl: candidate.messagesUrl,
      modelsUrl: candidate.modelsUrl,
      model: candidate.model,
      apiKey,
      enabled: true,
      verifiedAt: new Date().toISOString(),
      savedFingerprint,
    };
    try {
      await saveSettings(settingsFile, next);
    } catch (err) {
      log("settings.save failed=" + (err.code || "persist_failed"));
      sendJson(res, 500, { error: "persist_failed" });
      return;
    }
    log("settings.save ok");
    sendJson(res, 200, { ok: true, hasApiKey: true, enabled: true });
  }

  async function handleSettingsGet(req, res) {
    let settings;
    try {
      settings = await loadSettings(settingsFile);
    } catch (err) {
      sendJson(res, 503, { error: err.code || "settings_unreadable" });
      return;
    }
    const hasApiKey = typeof settings.apiKey === "string" && settings.apiKey.length > 0;
    sendJson(res, 200, {
      protocol: settings.protocol,
      baseUrl: settings.baseUrl,
      messagesUrl: settings.messagesUrl,
      modelsUrl: settings.modelsUrl,
      model: settings.model,
      hasApiKey,
      enabled: Boolean(settings.enabled),
      verified: Boolean(settings.enabled && hasApiKey && settings.savedFingerprint),
      verifiedAt: settings.verifiedAt ?? null,
    });
  }

  async function handleSettingsDelete(req, res) {
    let settings;
    try {
      settings = await loadSettings(settingsFile);
    } catch (err) {
      // Corrupt/unreadable store: never overwrite the raw file.
      sendJson(res, 503, { error: err.code || "settings_unreadable" });
      return;
    }
    try {
      await saveSettings(settingsFile, { ...settings, apiKey: "", enabled: false, verifiedAt: null, savedFingerprint: null });
    } catch (err) {
      log("settings.disconnect failed=" + (err.code || "persist_failed"));
      sendJson(res, 500, { error: "persist_failed" });
      return;
    }
    log("settings.disconnect ok");
    sendJson(res, 200, { ok: true, hasApiKey: false, enabled: false });
  }

  async function handleGenerate(req, res, body, reqSignal) {
    const purpose = body && body.purpose;
    const input = body && body.input;
    if (purpose !== "draft") {
      sendJson(res, 400, { error: "invalid_purpose" });
      return;
    }
    if (typeof input !== "string" || input.trim().length === 0) {
      sendJson(res, 400, { error: "empty_input" });
      return;
    }
    if (input.length > MAX_INPUT_CHARS) {
      sendJson(res, 400, { error: "input_too_long" });
      return;
    }
    let settings;
    try {
      settings = await loadSettings(settingsFile);
    } catch (err) {
      sendJson(res, 503, { error: err.code || "settings_unreadable" });
      return;
    }
    const hasApiKey = typeof settings.apiKey === "string" && settings.apiKey.length > 0;
    const hasSavedFingerprint =
      typeof settings.savedFingerprint === "string" && settings.savedFingerprint.length > 0;
    const candidateOk = validateCandidate(settings).ok;
    // Fail closed on the same record GET reports as verified: enabled plus a
    // saved fingerprint. A persisted enabled:true object without a saved
    // fingerprint must never reach the provider.
    const verified = settings.enabled && hasApiKey && hasSavedFingerprint;
    if (!verified || !candidateOk) {
      sendJson(res, 409, { error: "not_configured" });
      return;
    }
    const requestId = "gen-" + randomBytes(8).toString("hex");
    try {
      const r = await runLlmInference(
        settings,
        settings.apiKey,
        { system: DRAFT_PROMPT_SYSTEM, user: input },
        { maxTokens: 1024, timeoutMs: upstreamTimeoutMs, signal: reqSignal },
      );
      const payload = { text: r.text, model: r.model, requestId };
      if (r.responseModel && r.responseModel !== r.model) payload.responseModel = r.responseModel;
      log("generate ok requestId=" + requestId + " model=" + r.model);
      sendJson(res, 200, payload);
    } catch (err) {
      const code = err.code || "upstream_error";
      log("generate failed=" + code + " requestId=" + requestId);
      const status = code === "timeout" ? 504 : 502;
      sendJson(res, status, { error: code, requestId });
    }
  }

  async function serveStatic(req, res) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    if (!distRoot) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent((req.url || "/").split("?")[0]);
    } catch {
      sendJson(res, 400, { error: "bad_request" });
      return;
    }
    if (pathname.includes("\0")) {
      sendJson(res, 400, { error: "bad_request" });
      return;
    }
    let filePath = resolve(distRoot, "." + (pathname.startsWith("/") ? pathname : "/" + pathname));
    if (filePath !== distRoot && !filePath.startsWith(distRoot + sep)) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    let st = await stat(filePath).catch(() => null);
    if (st && st.isDirectory()) {
      filePath = join(filePath, "index.html");
      st = await stat(filePath).catch(() => null);
    }
    if ((!st || !st.isFile()) && !extname(filePath)) {
      // SPA fallback for client-side routes without a file extension.
      filePath = join(distRoot, "index.html");
      st = await stat(filePath).catch(() => null);
    }
    if (!st || !st.isFile()) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    const data = await readFile(filePath);
    res.writeHead(200, {
      "content-type": MIME[extname(filePath).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-store",
      "content-length": data.length,
    });
    res.end(req.method === "HEAD" ? undefined : data);
  }

  async function route(req, res) {
    const url = (req.url || "/").split("?")[0];
    if (url === "/api" || url.startsWith("/api/")) {
      const authRoute = url.startsWith("/api/auth/") || url.startsWith("/api/admin/");
      if (!authRoute && !guard(req, res)) return;
      const method = req.method || "GET";
      let body;
      if (method === "POST" || method === "PUT" || method === "PATCH") {
        const contentType = String(req.headers["content-type"] || "");
        if (!contentType.toLowerCase().startsWith("application/json")) {
          sendJson(res, 415, { error: "unsupported_media_type" });
          return;
        }
        try {
          const raw = await readBody(req, maxBodyBytes);
          body = raw.length ? JSON.parse(raw) : {};
        } catch (err) {
          if (err && err.code === "too_large") {
            const payload = JSON.stringify({ error: "body_too_large" });
            res.writeHead(413, {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "no-store",
              "content-length": Buffer.byteLength(payload),
              "connection": "close",
            });
            // Keep the request in flowing mode while the 413 is flushed. If
            // the server stops draining an early response, Windows finishes
            // the half-closed upload with RST before the peer reads it.
            req.resume();
            res.end(payload);
            return;
          }
          sendJson(res, 400, { error: "invalid_json" });
          return;
        }
      }
      if (authRoute) {
        if (!auth) {
          // Disabled auth stays a supported local mode: the SPA must learn
          // that accounts are off instead of reading a guard error as an
          // outage. Every account mutation stays rejected.
          if (url === "/api/auth/status" && (method === "GET" || method === "HEAD")) {
            sendJson(res, 200, { enabled: false, emailDelivery: "unavailable", registrationEnabled: false, passwordMinLength: 8, passwordMaxLength: 15 });
          } else {
            sendJson(res, 403, { error: "auth_disabled" });
          }
          return;
        }
        if (await auth.handle(req, res, body)) return;
        sendJson(res, 404, { error: "not_found" });
        return;
      }
      if (auth) {
        const settingsRoute = (url === "/api/settings/llm" && ["POST", "GET", "DELETE"].includes(method)) ||
          (url === "/api/settings/llm/test" && method === "POST");
        try {
          if (settingsRoute) await auth.requireAdmin(req);
          if (url === "/api/llm/generate" && method === "POST") await auth.authenticate(req);
        } catch (err) {
          if (typeof err?.status !== "number" || typeof err.code !== "string" || typeof err.message !== "string") throw err;
          sendJson(res, err.status, { error: err.code, detail: { code: err.code, message: err.message } });
          return;
        }
      }
      if (method === "POST" && url === "/api/settings/llm/test") return handleSettingsTest(req, res, body);
      if (method === "POST" && url === "/api/settings/llm") return handleSettingsSave(req, res, body);
      if (method === "GET" && url === "/api/settings/llm") return handleSettingsGet(req, res);
      if (method === "DELETE" && url === "/api/settings/llm") return handleSettingsDelete(req, res);
      if (method === "POST" && url === "/api/llm/generate") {
        const reqSignal = new AbortController();
        // res "close" is the lifecycle-correct client-disconnect hook: req
        // "close" can fire once the request body is merely consumed, which
        // must not cancel an otherwise valid inference.
        res.on("close", () => {
          if (!res.writableEnded) reqSignal.abort();
        });
        return handleGenerate(req, res, body, reqSignal.signal);
      }
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    await serveStatic(req, res);
  }

  const server = createHttpServer((req, res) => {
    route(req, res).catch((err) => {
      log("server.error code=" + String((err && err.code) || "internal"));
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
      else res.end();
    });
  });

  return {
    start() {
      return new Promise((resolveStart, rejectStart) => {
        server.once("error", rejectStart);
        server.listen(port, host, () => {
          const address = server.address();
          server.removeListener("error", rejectStart);
          resolveStart(typeof address === "object" && address ? address.port : port);
        });
      });
    },
    close() {
      return new Promise((resolveClose) => {
        if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
        server.close(() => resolveClose());
      });
    },
  };
}
