#!/usr/bin/env node
// Production entry: serves built dist plus the loopback API on 5200.
// Dev ("npm run server") sets TANGO_DEV=1 so dist is optional.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAppServer } from "./app.mjs";
import { isLoopbackHostname } from "./urlguard.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(root, "dist");
const dev = process.env.TANGO_DEV === "1";
const settingsFile = process.env.TANGO_SETTINGS_FILE || join(root, ".tango-donego", "llm-settings.json");
const port = Number(process.env.TANGO_PORT || 5200);
const host = process.env.TANGO_HOST || "127.0.0.1";

// Public access must go through a reverse proxy; the listener stays local.
if (!isLoopbackHostname(host)) {
  console.error(
    "Refusing to start: TANGO_HOST='" + host + "' is not a loopback address. " +
      "This server is loopback only and is not hardened for public exposure.",
  );
  process.exit(1);
}
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error("Refusing to start: TANGO_PORT must be an integer in [0, 65535].");
  process.exit(1);
}

if (!dev && !existsSync(join(distDir, "index.html"))) {
  console.error("dist/index.html missing; run 'npm run build' first (or use 'npm run server' for dev).");
  process.exit(1);
}

let auth = null;
let publicOrigin = "";
if (process.env.TANGO_AUTH_DISABLED === "1") {
  console.warn("[tango-donego] WARNING: authentication is DISABLED; loopback-only local administration mode.");
} else {
  try {
    const { readAuthConfig } = await import("./auth/config.mjs");
    const config = readAuthConfig(process.env);
    const { createAuthService } = await import("./auth/service.mjs");
    auth = createAuthService({
      databaseFile: process.env.TANGO_AUTH_DB || join(root, ".tango-donego", "auth.sqlite"),
      config,
      // Business resources currently live in the browser, not on this server.
      resourceHooks: { countUserResources: async () => 0, onUserDeleted: async () => {} },
    });
    publicOrigin = config.publicOrigin;
  } catch (err) {
    console.error("Refusing to start: authentication initialization failed: " + err.message);
    process.exit(1);
  }
}

const app = createAppServer({
  host,
  port,
  settingsFile,
  distDir,
  auth,
  publicOrigin,
  log: (line) => console.log("[tango-donego] " + line),
});

const boundPort = await app.start();
console.log("[tango-donego] API+dist on http://" + host + ":" + boundPort + " (loopback only)");

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close();
  auth?.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
