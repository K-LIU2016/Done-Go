import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function startServer(extraEnv) {
  const child = spawn(process.execPath, [join(repoRoot, "server", "start.mjs")], {
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  return { child, output: () => output };
}

test("start refuses a non-loopback TANGO_HOST instead of binding a public interface", async () => {
  for (const host of ["0.0.0.0", "192.168.1.10"]) {
    const { child, output } = startServer({ TANGO_HOST: host, TANGO_DEV: "1", TANGO_AUTH_DISABLED: "1" });
    const result = await Promise.race([
      new Promise((r) => child.on("close", (code) => r({ code }))),
      new Promise((r) => setTimeout(() => r({ timeout: true }), 8000)),
    ]);
    if (result.timeout) child.kill("SIGKILL");
    assert.ok(!result.timeout, "server kept running with TANGO_HOST=" + host);
    assert.equal(result.code, 1, "output: " + output());
    assert.match(output(), /loopback/i);
    assert.ok(output().includes(host), "rejection message should name " + host + ": " + output());
  }
});

test("loopback TANGO_HOST starts, reports the bound port and exits cleanly on SIGTERM", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "tango-donego-start-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { child, output } = startServer({
    TANGO_HOST: "127.0.0.1",
    TANGO_PORT: "0",
    TANGO_DEV: "1",
    TANGO_AUTH_DISABLED: "1",
    TANGO_SETTINGS_FILE: join(dir, "settings", "llm.json"),
  });
  const ready = await Promise.race([
    new Promise((r) => {
      const timer = setInterval(() => {
        if (/API\+dist/.test(output())) {
          clearInterval(timer);
          r(true);
        }
      }, 50);
      setTimeout(() => {
        clearInterval(timer);
        r(false);
      }, 8000);
    }),
  ]);
  assert.ok(ready, "server did not report ready: " + output());
  assert.match(output(), /127\.0\.0\.1/);
  const closed = new Promise((r) => child.on("close", (code, signal) => r({ code, signal })));
  child.kill("SIGTERM");
  const result = await Promise.race([
    closed,
    new Promise((r) => setTimeout(() => r({ timeout: true }), 8000)),
  ]);
  if (result.timeout) child.kill("SIGKILL");
  assert.ok(!result.timeout, "server ignored SIGTERM: " + output());
  if (process.platform === "win32") {
    assert.ok(result.code === 0 || (result.code === null && result.signal === "SIGTERM"));
  } else {
    assert.equal(result.code, 0);
  }
});
