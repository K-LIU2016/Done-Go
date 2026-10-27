// S2D-W6 module 2: preview-validate — the only gate through which a Preview
// enters or leaves persistence. Must use the FROZEN W0 schemas; W11 playback
// fields must be rejected (CTO-DECISIONS 2026-10-27 §2.3: projection consumes,
// the contract never grows player fields).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTRACTS_DIR, makePreview } from './_helpers.mjs';

async function loadValidate() {
  return import('../../../../scripts/agentic/preview/validate.mjs');
}

function loadFixtures(name) {
  return JSON.parse(readFileSync(join(CONTRACTS_DIR, 'fixtures', `${name}.fixtures.json`), 'utf8'));
}

test('every W0 preview fixture valid entry passes assertValidPreview', async () => {
  const { assertValidPreview } = await loadValidate();
  const fixtures = loadFixtures('preview');
  assert.ok(fixtures.valid.length >= 2);
  for (const preview of fixtures.valid) {
    assert.deepEqual(assertValidPreview(preview), preview);
  }
});

test('every W0 preview fixture invalid entry fails with CONTRACT_INVALID details', async () => {
  const { validatePreview } = await loadValidate();
  const fixtures = loadFixtures('preview');
  assert.ok(fixtures.invalid.length >= 1);
  for (const preview of fixtures.invalid.flat()) {
    const result = validatePreview(preview);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length >= 1);
  }
});

test('rich golden-scenario fixture passes the frozen schema', async () => {
  const { assertValidPreview } = await loadValidate();
  assertValidPreview(makePreview());
});

test('W11 playback fields are rejected at the top level (additionalProperties: false)', async () => {
  const { validatePreview } = await loadValidate();
  const injected = makePreview({ timeline: { shots: [], playback: { autoplay: true } } });
  const result = validatePreview(injected);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.path.includes('timeline')), JSON.stringify(result.errors));
});

test('assertValidPreview throws error.code CONTRACT_INVALID and never stores', async () => {
  const { assertValidPreview } = await loadValidate();
  assert.throws(
    () => assertValidPreview(makePreview({ version: 0 })),
    error => error.code === 'CONTRACT_INVALID' && Array.isArray(error.errors) && error.errors.length >= 1,
  );
});

test('assertPreviewRoundTrip accepts canonical JSON of a valid preview and returns it parsed', async () => {
  const { assertPreviewRoundTrip } = await loadValidate();
  const preview = makePreview();
  const parsed = assertPreviewRoundTrip(JSON.stringify(preview));
  assert.deepEqual(parsed, preview);
});

test('assertPreviewRoundTrip fails closed on corrupted JSON and schema-invalid payloads', async () => {
  const { assertPreviewRoundTrip } = await loadValidate();
  assert.throws(
    () => assertPreviewRoundTrip('{"missionId": "m1", oops'),
    error => error.code === 'CONTRACT_INVALID',
  );
  // Parses as JSON but violates the frozen schema (confidence out of range).
  assert.throws(
    () => assertPreviewRoundTrip(JSON.stringify(makePreview({ confidence: 3 }))),
    error => error.code === 'CONTRACT_INVALID',
  );
});

test('sub-validators accept and reject the W0 sample/reel/scene fixtures', async () => {
  const validate = await loadValidate();
  for (const [validatorName, fixtureName] of [['validateSample', 'preview-sample'], ['validateReel', 'preview-reel'], ['validateScene', 'preview-scene']]) {
    const validator = validate[validatorName];
    assert.equal(typeof validator, 'function', `${validatorName} must be exported`);
    const fixtures = loadFixtures(fixtureName);
    for (const valid of fixtures.valid) assert.equal(validator(valid).valid, true, `${fixtureName} valid entry`);
    for (const invalid of fixtures.invalid.flat()) assert.equal(validator(invalid).valid, false, `${fixtureName} invalid entry`);
  }
});

test('sub-validators catch injected player fields on nested objects too', async () => {
  const { validateReel } = await loadValidate();
  const preview = makePreview();
  const reel = { ...preview.reel, autoplay: true };
  assert.equal(validateReel(reel).valid, false);
});
