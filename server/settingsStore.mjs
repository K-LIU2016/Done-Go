// Private, atomic local settings persistence.
// Directory 0700, file 0600, write-to-temp + rename so partial writes never
// replace good data. Missing settings are a valid empty state; a malformed or
// unreadable existing file is an explicit error that preserves the raw data.

import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  protocol: "anthropic",
  baseUrl: "",
  messagesUrl: "",
  modelsUrl: "",
  model: "",
  apiKey: "",
  enabled: false,
  verifiedAt: null,
  savedFingerprint: null,
});

const STORE_FIELDS = [
  "version",
  "protocol",
  "baseUrl",
  "messagesUrl",
  "modelsUrl",
  "model",
  "apiKey",
  "enabled",
  "verifiedAt",
  "savedFingerprint",
];

export class SettingsStoreError extends Error {
  constructor(code) {
    super(code);
    this.name = "SettingsStoreError";
    this.code = code;
  }
}

export async function loadSettings(file) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { ...DEFAULT_SETTINGS };
    // Unreadable (permissions/IO) or otherwise inaccessible: explicit, never
    // silently treated as empty, raw file left untouched.
    throw new SettingsStoreError("settings_unreadable");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SettingsStoreError("settings_corrupt");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SettingsStoreError("settings_corrupt");
  }
  const merged = { ...DEFAULT_SETTINGS };
  for (const field of STORE_FIELDS) {
    if (parsed[field] !== undefined) merged[field] = parsed[field];
  }
  return merged;
}

export async function saveSettings(file, data) {
  const dir = dirname(file);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch {
    throw new SettingsStoreError("persist_failed");
  }
  // POSIX modes are contractual on Linux and macOS. NTFS reports synthetic
  // modes, so Windows still performs the atomic write but skips the raw-mode
  // assertions that production checks on deploy targets.
  if (process.platform !== "win32") {
    const dirStat = await stat(dir).catch(() => null);
    if (!dirStat || (dirStat.mode & 0o777) !== 0o700) {
      throw new SettingsStoreError("persist_failed");
    }
  }
  const tmp = join(dir, "." + basename(file) + "." + randomBytes(6).toString("hex") + ".tmp");
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    // chmod without catch: a failure here is reported, never swallowed.
    if (process.platform !== "win32") {
      await chmod(tmp, 0o600);
      const tmpStat = await stat(tmp);
      if ((tmpStat.mode & 0o777) !== 0o600) throw new SettingsStoreError("persist_failed");
    }
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err instanceof SettingsStoreError ? err : new SettingsStoreError("persist_failed");
  }
}
