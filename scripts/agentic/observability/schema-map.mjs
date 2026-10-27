/**
 * W10 read-only map from the frozen W0 contracts to observability storage.
 *
 * The map is data, not code: every entry states which frozen schema is consumed,
 * which `obs_*` target it projects into, and whether it touches W0 (never). The
 * only sanctioned extension point in the whole contract set is `span.attributes`,
 * so a schema that tried to project into a top-level W0 field would be a bug here.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { observabilityError, OBS_ERROR_CODES } from './vocabulary.mjs';

/** Frozen baseline shipped with the worktree. Not editable by this stream. */
export const FROZEN_VERSION = 'v1';
export const FROZEN_COMMIT = 'b9d9bdfa0511905a95b729753b82e5734adab6bb';

export const CONTRACTS_DIR = fileURLToPath(new URL('../../../contracts/agentic/', import.meta.url));
export const FROZEN_FILE = fileURLToPath(new URL('../../../contracts/agentic/FROZEN', import.meta.url));

const SNAPSHOT_FILE = fileURLToPath(new URL('./contract-snapshot.json', import.meta.url));

/**
 * Every W0 object observability consumes, its projection target, and its
 * extension points. `modifiesContract` stays false for all of them: W10 reads
 * the frozen schemas and writes only to its own `obs_*` tables.
 */
export const SCHEMA_MAP = Object.freeze([
  {
    contract: 'span',
    schemaFile: 'span.schema.json',
    projection: ['obs_spans'],
    modifiesContract: false,
    extensionPoints: ['attributes'],
  },
  {
    contract: 'run',
    schemaFile: 'run.schema.json',
    projection: ['obs_runs'],
    modifiesContract: false,
    extensionPoints: [],
  },
  {
    contract: 'step',
    schemaFile: 'step.schema.json',
    projection: ['obs_steps'],
    modifiesContract: false,
    extensionPoints: [],
  },
  {
    contract: 'spend',
    schemaFile: 'spend.schema.json',
    projection: ['obs_spend'],
    modifiesContract: false,
    extensionPoints: [],
  },
  {
    contract: 'evidence',
    schemaFile: 'evidence.schema.json',
    projection: ['obs_gates'],
    modifiesContract: false,
    extensionPoints: [],
  },
  {
    contract: 'acceptance',
    schemaFile: 'acceptance.schema.json',
    projection: ['obs_acceptances'],
    modifiesContract: false,
    extensionPoints: [],
  },
  {
    contract: 'need',
    schemaFile: 'need.schema.json',
    projection: ['obs_needs'],
    modifiesContract: false,
    extensionPoints: [],
  },
  {
    contract: 'grant',
    schemaFile: 'grant.schema.json',
    projection: ['obs_grants'],
    modifiesContract: false,
    extensionPoints: [],
  },
]);

export const REQUIRED_CONTRACTS = Object.freeze(SCHEMA_MAP.map((entry) => entry.contract));

/** The single place where a new observation field may legitimately be added. */
export const ATTRIBUTE_EXTENSION_POINT = Object.freeze({ contract: 'span', field: 'attributes' });

const FROZEN_LINE = /^(v\d+)\s+([a-f0-9]{40})$/;

export function parseFrozenContract(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const match = FROZEN_LINE.exec(text);
  if (!match) {
    throw observabilityError(
      OBS_ERROR_CODES.CONTRACT_INVALID,
      'FROZEN must be "<version> <40-hex commit>"',
      { raw: text.slice(0, 64) },
    );
  }
  return { version: match[1], commit: match[2], raw: text };
}

/** Read and parse the shipped FROZEN pin; a missing file is not swallowed. */
export function readFrozenContract(file = FROZEN_FILE) {
  return parseFrozenContract(readFileSync(file, 'utf8'));
}

function hashFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Map of schema filename to SHA-256 of the file bytes as they are on disk. */
export function schemaSnapshots(schemaDir = CONTRACTS_DIR) {
  const dir = schemaDir.endsWith('/') ? schemaDir : `${schemaDir}/`;
  return Object.fromEntries(
    readdirSync(dir)
      .filter((name) => name.endsWith('.schema.json'))
      .sort()
      .map((name) => [name, hashFile(`${dir}${name}`)]),
  );
}

/** The frozen hashes committed next to this module. */
export function loadSnapshot() {
  return JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8'));
}

/**
 * Compare the live contract directory against the frozen hash snapshot.
 *
 * - `mismatches`: same filename, different bytes (real drift, e.g. a W0 edit).
 * - `missing`: live schemas the snapshot does not cover (added after freezing).
 * - `unexpected`: snapshot entries with no live file (removed after freezing).
 */
export function verifyFrozenContracts({ schemaDir = CONTRACTS_DIR, snapshot = loadSnapshot() } = {}) {
  const checked = schemaSnapshots(schemaDir);
  const mismatches = [];
  const missing = [];
  const unexpected = [];

  for (const [file, actual] of Object.entries(checked)) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, file)) {
      missing.push(file);
      continue;
    }
    if (snapshot[file] !== actual) {
      mismatches.push({ file, expected: snapshot[file], actual });
    }
  }
  for (const file of Object.keys(snapshot)) {
    if (!Object.prototype.hasOwnProperty.call(checked, file)) unexpected.push(file);
  }

  mismatches.sort((a, b) => a.file.localeCompare(b.file));
  missing.sort();
  unexpected.sort();

  return {
    ok: mismatches.length === 0 && missing.length === 0 && unexpected.length === 0,
    mismatches,
    missing,
    unexpected,
    checked,
    frozen: readFrozenContract(),
  };
}
