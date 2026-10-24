// scripts/metrics.mjs — AI 接力 v2 漏斗计数（SPEC design/relay-v2/SPEC.md §5.5 / D10）。
//
// Count-only funnel counters: the wire body accepted from clients is exactly
// { event: '<name>' } validated by web/relay/contracts.js sanitizeMetricBody —
// no user ids, no IPs, no text, no timestamps beyond the local calendar day.
// Counts live in memory and are flushed to one JSON file per local day under
// the configured directory (atomic tmp+rename); a restart resumes today's
// file. Without a directory the counters stay in memory only (unit tests,
// local servers without a data dir).
//
// Event name enums come from the shared contracts module — never redefined
// here. The optional apps list (web/relay/external-apps.js ids, owned by
// another line) can be supplied via options.apps to tighten baton_copy /
// graduated slots from "id-shaped" to "known id"; without it the contracts
// APP_ID_RE defensive gate stays in charge.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sanitizeMetricBody } from '../web/relay/contracts.js';

// A funnel POST body is tiny ({"event":"relay_fail:timeout"}); anything larger
// is junk or an attack vector, never a counter.
export const METRICS_BODY_MAX_BYTES = 2048;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// Enough cached days for a month-long admin lookback without unbounded growth.
const MAX_CACHED_DAYS = 40;

export function metricsDay(time) {
  const date = new Date(time);
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}

// Calendar-strict day validation for GET /api/metrics?day= — rejects rollover
// dates like 2026-02-29 (not a leap year) and 2026-13-01.
export function validMetricsDay(value) {
  const day = String(value == null ? '' : value);
  if (!DAY_PATTERN.test(day)) return false;
  const date = new Date(day + 'T00:00:00Z');
  if (Number.isNaN(date.getTime())) return false;
  return date.toISOString().slice(0, 10) === day;
}

function sortedEvents(counts) {
  const entries = [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return Object.fromEntries(entries);
}

export function createMetrics(options = {}) {
  const now = options.now || Date.now;
  const dir = options.dir || null;
  const apps = Array.isArray(options.apps) ? options.apps.map(String) : null;
  const days = new Map(); // day -> Map(event -> count)
  const chains = new Map(); // day -> serialized write chain

  const fileFor = day => join(dir, day + '.json');

  function parseDayFile(text, day) {
    let payload;
    try { payload = JSON.parse(text); } catch { return null; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.day !== day) return null;
    if (!payload.events || typeof payload.events !== 'object' || Array.isArray(payload.events)) return null;
    const counts = new Map();
    for (const [name, value] of Object.entries(payload.events)) {
      const key = String(name);
      const count = Number(value);
      // Only counter names the contracts accept may come back from disk.
      if (sanitizeMetricBody({ event: key }, { apps }) && Number.isInteger(count) && count >= 0) counts.set(key, count);
    }
    return counts;
  }

  function trimCache() {
    if (days.size <= MAX_CACHED_DAYS) return;
    const keep = new Set([...days.keys()].sort().slice(1 - MAX_CACHED_DAYS));
    for (const key of days.keys()) if (!keep.has(key)) { days.delete(key); chains.delete(key); }
  }

  async function loadDay(day) {
    const cached = days.get(day);
    if (cached) return cached;
    let counts = new Map();
    if (dir) {
      try { counts = parseDayFile(await readFile(fileFor(day), 'utf8'), day) || counts; } catch { /* missing or unreadable day file: start fresh */ }
    }
    days.set(day, counts);
    trimCache();
    return counts;
  }

  async function persist(day, counts) {
    if (!dir) return;
    const payload = JSON.stringify({ day: day, events: sortedEvents(counts) });
    // Serialize writes per day so counters never interleave half-written.
    const run = (chains.get(day) || Promise.resolve()).catch(() => {}).then(async () => {
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, '.' + day + '.json.tmp');
      await writeFile(tmp, payload);
      await rename(tmp, fileFor(day));
    });
    chains.set(day, run);
    // A disk failure must not fail the count: the in-memory tally stays right.
    await run.catch(() => {});
  }

  async function record(body) {
    const clean = sanitizeMetricBody(body, { apps });
    if (!clean) return null;
    const day = metricsDay(now());
    const counts = await loadDay(day);
    counts.set(clean.event, (counts.get(clean.event) || 0) + 1);
    await persist(day, counts);
    return clean.event;
  }

  async function snapshot(day) {
    const counts = await loadDay(day);
    return { day: day, events: sortedEvents(counts) };
  }

  return { record, snapshot };
}
