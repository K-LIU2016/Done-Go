// S2D-W6 module 2 preview-validate (.s2d/plan.md:51): the single gate through
// which a Preview payload enters or leaves persistence.
//
// - Pre-store check: assertValidPreview / validatePreview against the FROZEN
//   W0 preview.schema.json (with same-directory $ref resolution for
//   samples/reel/scene).
// - Read-out round trip: assertPreviewRoundTrip re-parses stored JSON text and
//   re-validates it against the frozen schema; corrupted JSON fails closed
//   with CONTRACT_INVALID instead of leaking a SyntaxError.
// - Sub-validators expose the three nested frozen schemas individually so
//   stores can check a replaced sample/reel/scene without validating a whole
//   Preview.
//
// Hard rules (CTO-DECISIONS-2026-10-27 §2.3, plan §2):
// - This module is a thin wrapper over the W0 validator
//   (scripts/agentic/contracts.mjs). It must NOT reimplement schema rules or
//   soften them; W0 schemas are read-only inputs and are never written here.
// - W11 playback/timeline fields are NOT part of the frozen Preview contract.
//   Payloads carrying such fields fail via additionalProperties:false; the
//   player consumes Previews through the projection seam
//   (scripts/agentic/preview/timeline.mjs), never via schema growth.
// - Validation is pure: the value under validation is never mutated, and no
//   external calls, clock reads, or writes happen here.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertValid, loadSchema, validate } from '../contracts.mjs';

const CONTRACTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..',
  'contracts', 'agentic',
);

const SCHEMA_BY_KIND = {
  preview: 'preview.schema.json',
  sample: 'preview-sample.schema.json',
  reel: 'preview-reel.schema.json',
  scene: 'preview-scene.schema.json',
};

// contracts/agentic is FROZEN (W0 b9d9bdf), so caching the parsed schema per
// process is safe and keeps request-path validation free of filesystem reads.
const schemaCache = new Map();

function schemaFor(kind) {
  if (!schemaCache.has(kind)) {
    schemaCache.set(kind, loadSchema(SCHEMA_BY_KIND[kind], CONTRACTS_DIR));
  }
  return schemaCache.get(kind);
}

function checkWith(kind, value) {
  return validate(value, schemaFor(kind), { schemaDir: CONTRACTS_DIR });
}

/** Validate a Preview object against the frozen schema. Returns {valid, errors}. */
export function validatePreview(preview) {
  return checkWith('preview', preview);
}

/** Validate a nested PreviewSample against preview-sample.schema.json. */
export function validateSample(sample) {
  return checkWith('sample', sample);
}

/** Validate a nested PreviewReel against preview-reel.schema.json. */
export function validateReel(reel) {
  return checkWith('reel', reel);
}

/** Validate a nested PreviewScene against preview-scene.schema.json. */
export function validateScene(scene) {
  return checkWith('scene', scene);
}

/**
 * Pre-store gate: validate and return the Preview unchanged, or throw an
 * error with code CONTRACT_INVALID and a structured .errors list. Nothing is
 * persisted by this module — callers must call this before any write.
 */
export function assertValidPreview(preview) {
  return assertValid(preview, schemaFor('preview'), { schemaDir: CONTRACTS_DIR });
}

/**
 * Read-out gate: parse serialized Preview JSON text and re-validate it against
 * the frozen schema. Fails closed on unparseable JSON (corruption / torn
 * write) with CONTRACT_INVALID so a damaged row can never reach a client as a
 * plausible Preview. Returns the parsed (validated) value.
 */
export function assertPreviewRoundTrip(serialized) {
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    const failure = new Error(`CONTRACT_INVALID: stored preview is not parseable JSON (${error.message})`);
    failure.code = 'CONTRACT_INVALID';
    failure.errors = [{ path: '$', message: `stored preview is not parseable JSON: ${error.message}` }];
    throw failure;
  }
  return assertValidPreview(parsed);
}
