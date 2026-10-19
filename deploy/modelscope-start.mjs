// Container-only supervisor. The application itself keeps its loopback listener.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isLoopbackHostname } from "../server/urlguard.mjs";

if (process.env.TANGO_AUTH_DISABLED === "1") {
  throw new Error("Authentication cannot be disabled in the public container.");
}
const publicOrigin = process.env.TANGO_PUBLIC_ORIGIN || "";
const publicUrl = new URL(publicOrigin);
if (publicUrl.origin !== publicOrigin || publicUrl.protocol !== "https:" ||
    publicUrl.username || publicUrl.password || isLoopbackHostname(publicUrl.hostname) ||
    !/^[a-z0-9.-]+(?::[0-9]+)?$/i.test(publicUrl.host)) {
  throw new Error("TANGO_PUBLIC_ORIGIN must be an exact public HTTPS origin.");
}
const dataDir = process.env.TANGO_DATA_DIR || "/app/.tango-donego";
await mkdir(dataDir, { recursive: true, mode: 0o700 });
const env = {
  ...process.env,
  NODE_ENV: "production",
  TANGO_HOST: "127.0.0.1",
  TANGO_PORT: "5200",
  TANGO_TRUST_CLOUDFLARE: "0",
  TANGO_AUTH_DB: process.env.TANGO_AUTH_DB || join(dataDir, "auth.sqlite"),
  TANGO_SETTINGS_FILE: process.env.TANGO_SETTINGS_FILE || join(dataDir, "llm-settings.json"),
};
if (!env.TANGO_AUTH_SECRET && !env.JWT_SECRET) {
  const secretFile = join(dataDir, "auth-secret");
  try {
    await writeFile(secretFile, randomBytes(48).toString("hex"), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  env.TANGO_AUTH_SECRET = await readFile(secretFile, "utf8");
}
// ModelScope's gateway uses an internal Host. This dedicated container routes
// to one operator-configured authority, never a client-supplied forwarded host.
// Origin, client identification and session cookies remain untouched.
const nginxConfig = (await readFile(new URL("./modelscope-nginx.conf", import.meta.url), "utf8"))
  .replace("__TANGO_PUBLIC_HOST__", publicUrl.host);
const nginxConfigPath = "/tmp/tango-donego-nginx/runtime.conf";
await writeFile(nginxConfigPath, nginxConfig, { mode: 0o600 });
const children = [
  spawn(process.execPath, ["server/start.mjs"], { env, stdio: "inherit" }),
  spawn("nginx", ["-c", nginxConfigPath, "-g", "daemon off;"], { stdio: "inherit" }),
];
let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  const timer = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
  }, 5000);
  Promise.all(children.map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", resolve);
  }))).then(() => { clearTimeout(timer); process.exit(code); });
}
for (const child of children) {
  child.once("error", (error) => { console.error(error.message); shutdown(1); });
  child.once("exit", () => shutdown(1));
}
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
