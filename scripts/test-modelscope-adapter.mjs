// Run against the isolated Docker container, never a public deployment.
import assert from "node:assert/strict";
import { request } from "node:http";

const port = Number(process.argv[2] || "17861");
const publicOrigin = "https://tango-donego-test.example";
const clientHeader = { "x-tango-client": "tango-settings/1" };

function probe(path, headers = clientHeader, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: "127.0.0.1", port, path, method, timeout: 5000,
      headers: { host: "21.0.10.49:7860", ...(method === "POST" ? { "content-type": "application/json" } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Adapter request timed out")));
    req.end(method === "POST" ? "{}" : undefined);
  });
}

const status = await probe("/api/auth/status");
assert.equal(status.status, 200, "platform-rewritten Host must reach authenticated bootstrap");
assert.equal(status.body.enabled, true);
assert.equal(status.body.registrationEnabled, false);
for (const path of ["/api/auth/me", "/api/admin/users", "/api/settings/llm"]) {
  const result = await probe(path, { ...clientHeader, origin: publicOrigin });
  assert.equal(result.status, 401, path);
  assert.equal(result.body.error, "AUTH_REQUIRED", path);
}
for (const headers of [
  {}, { "x-tango-client": "wrong" },
  { ...clientHeader, origin: "https://evil.example" },
  { ...clientHeader, origin: "null" },
  { origin: publicOrigin, "x-forwarded-host": "localhost", "cf-connecting-ip": "127.0.0.1" },
  { ...clientHeader, origin: "https://evil.example", forwarded: "host=localhost", "x-forwarded-host": "tango-donego-test.example" },
]) {
  assert.equal((await probe("/api/auth/status", headers)).status, 403);
}
const forged = await probe("/api/auth/me", { ...clientHeader, origin: publicOrigin, cookie: "tango_session=forged-test-cookie" });
assert.equal(forged.status, 401);
for (const origin of [undefined, "null", "https://evil.example"]) {
  assert.equal((await probe("/api/llm/generate", { ...clientHeader, ...(origin ? { origin } : {}) }, "POST")).status, 403);
}
assert.equal((await probe("/api/llm/generate", { ...clientHeader, origin: publicOrigin }, "POST")).status, 401);
console.log("ModelScope adapter: bootstrap 200, anonymous APIs 401, missing/foreign source 403; authentication enabled.");
