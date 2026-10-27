// S2D-W6 module 5 timeline-projection (.s2d/plan.md:57): the one-way seam
// between the FROZEN Preview persistence contract and the W11 player's
// timeline view-model.
//
// CTO-DECISIONS-2026-10-27 §2.3: the Preview contract owns traceable intent,
// evidence, state and user decisions; the player timeline model owns rendering
// convenience. The two meet ONLY here, through a projection — the frozen
// contract is never extended for player convenience (no timeline/autoplay
// fields grow preview.schema.json; contracts/agentic is read-only input).
//
// Rules enforced by this module (plan.md §2 契约映射, tests timeline.test.mjs):
// - Pure function: reads frozen Preview fields (+ optional store metadata),
//   never mutates the input, never mutates or aliases it in the output, makes
//   no IO/clock/external calls, and adds nothing to persistence.
// - Additive only: shots map 1:1 from storyboard in order (user touchpoints
//   keep their `need`), reel durationSec/tracks pass through, narration is
//   split into sentence segments that reassemble the original byte-for-byte,
//   samples pass through untouched for the player to compose.
// - Unknown shape components degrade to plain text (PRD §10.3 组件目录: 未知
//   类型降级为纯文本) and are listed in `fallbacks` with their source path,
//   so W11 can render a degraded-but-honest view instead of dropping content.
// - Optional store metadata (previewId/revision/…) rides along as `source`
//   verbatim; when absent the VM still projects (source: null) — projection
//   must never require non-contract metadata.
//
// Precondition (not re-checked here): `preview` already passed the frozen
// preview.schema.json gate (scripts/agentic/preview/validate.mjs). Projection
// is deliberately validation-free so it stays a pure read-side transform.

// PRD §10.3 组件目录（首批）— the only shape components W11 knows how to
// render natively. Everything else degrades.
const KNOWN_COMPONENTS = new Set([
  'outline', 'facts', 'table', 'cards', 'checklist',
  'timeline', 'slides', 'diffSummary', 'mapRoute', 'personCard', 'caveat', 'sample',
]);

// Sentence-ending punctuation for narration segmentation. Segments are
// { text } objects keeping their terminator so
// `segments.map(s => s.text).join('') === narration` holds.
const SENTENCE_ENDERS = new Set(['。', '！', '？', '!', '?', '；', ';']);

function deepCopy(value) {
  return structuredClone(value);
}

function projectShot(entry) {
  const shot = { at: entry.at, actor: entry.actor, text: entry.text };
  if (entry.need !== undefined) shot.need = entry.need;
  return shot;
}

function splitNarration(text) {
  const segments = [];
  let current = '';
  for (const char of text) {
    current += char;
    if (SENTENCE_ENDERS.has(char)) {
      segments.push({ text: current });
      current = '';
    }
  }
  if (current !== '') segments.push({ text: current });
  return segments;
}

function projectNarration(text) {
  return { text, segments: splitNarration(text) };
}

function fallbackTextFor(block) {
  return typeof block.text === 'string' && block.text.length > 0
    ? block.text
    : `unsupported component: ${block.type}`;
}

function projectShape(shape) {
  const fallbacks = [];
  const blocks = shape.blocks.map((block, index) => {
    if (KNOWN_COMPONENTS.has(block.type)) {
      return { type: block.type, known: true, data: deepCopy(block) };
    }
    fallbacks.push(`shape.blocks[${index}].type=${block.type}`);
    return { type: block.type, known: false, fallbackText: fallbackTextFor(block) };
  });
  return { kind: shape.kind, title: shape.title, blocks, fallbacks };
}

/**
 * Project a schema-valid Preview into the W11 timeline view-model.
 *
 * @param {object} preview value that passed the frozen preview.schema.json gate
 * @param {object|null} [source] optional store metadata (previewId, revision,
 *   createdAt, …) carried verbatim; callers without metadata omit it
 * @returns {object} JSON-serializable timeline VM:
 *   { missionId, version, shots, durationSec, tracks, narration{text,segments},
 *     samples, shape{kind,title,blocks}, fallbacks, source }
 */
export function projectTimeline(preview, source = null) {
  const shape = projectShape(preview.shape);
  return {
    missionId: preview.missionId,
    version: preview.version,
    shots: preview.storyboard.map(projectShot),
    durationSec: preview.reel.durationSec,
    tracks: deepCopy(preview.reel.tracks ?? []),
    narration: projectNarration(preview.narration),
    samples: deepCopy(preview.samples),
    shape: { kind: shape.kind, title: shape.title, blocks: shape.blocks },
    fallbacks: shape.fallbacks,
    source: source === null ? null : deepCopy(source),
  };
}
