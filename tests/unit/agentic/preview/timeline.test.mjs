// S2D-W6 module 5: timeline-projection — the Preview→Timeline seam.
// Pure function over the FROZEN preview fields only (CTO-DECISIONS §2.3):
// it must never mutate the preview, never require non-contract metadata,
// and degrade unknown shape components to plain text (PRD §10.3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makePreview, deepFreeze } from './_helpers.mjs';

async function loadTimeline() {
  return import('../../../../scripts/agentic/preview/timeline.mjs');
}

const KNOWN_COMPONENTS = [
  'outline', 'facts', 'table', 'cards', 'checklist',
  'timeline', 'slides', 'diffSummary', 'mapRoute', 'personCard', 'caveat', 'sample',
];

test('maps storyboard 1:1 into shots preserving order and the need touchpoint', async () => {
  const { projectTimeline } = await loadTimeline();
  const preview = makePreview();
  const timeline = projectTimeline(preview);
  assert.equal(timeline.missionId, preview.missionId);
  assert.equal(timeline.version, preview.version);
  assert.equal(timeline.shots.length, preview.storyboard.length);
  preview.storyboard.forEach((entry, index) => {
    assert.equal(timeline.shots[index].at, entry.at);
    assert.equal(timeline.shots[index].actor, entry.actor);
    assert.equal(timeline.shots[index].text, entry.text);
    if (entry.need) assert.equal(timeline.shots[index].need, entry.need);
  });
  // The user touchpoint is identifiable (PRD §5.2.3: 用户触点用"手"标出).
  assert.equal(timeline.shots[1].need, 'n_1');
});

test('durationSec comes from the frozen reel and tracks pass through verbatim', async () => {
  const { projectTimeline } = await loadTimeline();
  const preview = makePreview();
  const timeline = projectTimeline(preview);
  assert.equal(timeline.durationSec, preview.reel.durationSec);
  assert.deepEqual(timeline.tracks, preview.reel.tracks);
  // A reel without optional tracks projects an empty track list, not an error.
  const reelless = makePreview({ reel: { composition: '/r', durationSec: 8, narrationAudio: '/n', mp4: null } });
  assert.deepEqual(projectTimeline(reelless).tracks, []);
});

test('narration is split into sentence segments that reassemble the original', async () => {
  const { projectTimeline } = await loadTimeline();
  const preview = makePreview();
  const timeline = projectTimeline(preview);
  assert.equal(timeline.narration.text, preview.narration);
  assert.equal(timeline.narration.segments.length, 4);
  for (const segment of timeline.narration.segments) {
    assert.ok(typeof segment.text === 'string' && segment.text.length > 0, 'no empty segments');
  }
  assert.equal(timeline.narration.segments.map(segment => segment.text).join(''), preview.narration);
});

test('samples pass through untouched for the player to compose', async () => {
  const { projectTimeline } = await loadTimeline();
  const preview = makePreview();
  assert.deepEqual(projectTimeline(preview).samples, preview.samples);
});

test('pure: the frozen input preview is never mutated and the VM is a new object', async () => {
  const { projectTimeline } = await loadTimeline();
  const preview = deepFreeze(makePreview());
  const snapshot = JSON.parse(JSON.stringify(preview));
  const timeline = projectTimeline(preview);
  assert.deepEqual(JSON.parse(JSON.stringify(preview)), snapshot);
  assert.notEqual(timeline, preview);
  assert.notEqual(timeline.shots, preview.storyboard);
});

test('unknown shape components degrade to plain text and are listed in fallbacks', async () => {
  const { projectTimeline } = await loadTimeline();
  const preview = makePreview({
    shape: {
      kind: 'report',
      title: '降级测试',
      blocks: [
        { type: 'outline', items: [] },
        { type: 'hologram', text: '神秘全息块' },
        { type: 'quantum' },
      ],
    },
  });
  const timeline = projectTimeline(preview);
  const blocks = timeline.shape.blocks;
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].type, 'outline');
  assert.equal(blocks[0].known, true);
  assert.deepEqual(blocks[0].data, { type: 'outline', items: [] });
  assert.equal(blocks[1].known, false);
  assert.equal(blocks[1].fallbackText, '神秘全息块');
  assert.equal(blocks[2].known, false);
  assert.ok(typeof blocks[2].fallbackText === 'string' && blocks[2].fallbackText.length > 0);
  assert.ok(blocks[2].fallbackText.includes('quantum'));
  assert.deepEqual(timeline.fallbacks, ['shape.blocks[1].type=hologram', 'shape.blocks[2].type=quantum']);
});

test('every component named in PRD §10.3 is recognized as known', async () => {
  const { projectTimeline } = await loadTimeline();
  const preview = makePreview({
    shape: {
      kind: 'report',
      title: '全组件',
      blocks: KNOWN_COMPONENTS.map(type => ({ type })),
    },
  });
  const timeline = projectTimeline(preview);
  assert.equal(timeline.shape.blocks.filter(block => block.known).length, KNOWN_COMPONENTS.length);
  assert.deepEqual(timeline.fallbacks, []);
});

test('optional frozen fields (diff) are not required; store metadata rides along as source', async () => {
  const { projectTimeline } = await loadTimeline();
  const preview = makePreview(); // no diff field
  assert.equal(preview.diff, undefined);
  const bare = projectTimeline(preview);
  assert.equal(bare.source, null);

  const meta = { previewId: 'pv_9', revision: 3, createdAt: '2026-10-27T10:00:00Z' };
  const withMeta = projectTimeline(preview, meta);
  assert.deepEqual(withMeta.source, meta);
});

test('projection output is JSON-serializable end to end', async () => {
  const { projectTimeline } = await loadTimeline();
  const round = JSON.parse(JSON.stringify(projectTimeline(makePreview())));
  assert.equal(round.shots.length, 4);
  assert.equal(round.durationSec, 42);
});
