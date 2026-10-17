import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("S07 left panel and ring do not stretch with the long right-hand checkpoint", () => {
  const css = read("../s07-session/s07-session.css");
  assert.ok(/\.s07-checkpoint\s*\{[^}]*align-self:\s*start/.test(css), "checkpoint needs start alignment");
  assert.ok(css.includes("min-height: var(--reference-session-height)"), "desktop checkpoint uses reference height");
  assert.ok(/\.s07-ring\s*\{[^}]*flex:\s*0 0 var\(--reference-session-ring\)/.test(css), "ring must not take excess right-panel height");
});

test("S08 porcelain CTA geometry is scoped and still wraps on narrow layouts", () => {
  const css = read("../s08-stillness/s08-stillness.css");
  assert.ok(/html:not\(\[data-theme="ink"\]\) \.s08-actions \.s08-btn-primary\s*\{[^}]*min-width:\s*var\(--reference-quiet-primary\)/.test(css), "primary width must be porcelain-scoped");
  assert.ok(/html:not\(\[data-theme="ink"\]\) \.s08-actions \.s08-btn-ghost\s*\{[^}]*min-width:\s*var\(--reference-quiet-secondary\)/.test(css), "secondary width must be porcelain-scoped");
  assert.ok(/\.s08-actions\s*\{[^}]*flex-wrap:\s*wrap/.test(css));
});

test("S12 has two right cards, value-first rows and body-sized unknowns without removing feedback handlers", () => {
  const source = read("./S12Review.tsx");
  const side = source.slice(source.indexOf('<div className="s12-side">'));
  assert.equal((side.match(/<article\b/g) ?? []).length, 2);
  assert.ok(source.includes('className="s12-ledger-description"'));
  assert.ok(source.includes('"is-numeric" : "is-unknown"'));
  assert.ok(source.includes('type: "upsertWeeklyFeedback"'));
  assert.ok(source.includes('aria-pressed={feeling?.value === item.value}'));
  const css = read("./s12-review.css");
  assert.ok(css.includes("grid-template-columns: var(--reference-review-value-width) minmax(0, 1fr)"));
  assert.ok(/\.s12-ledger-value\.is-numeric\s*\{[^}]*font-size:\s*var\(--reference-review-value-size\)/.test(css));
  assert.ok(/\.s12-ledger-value\.is-unknown\s*\{[^}]*font-size:\s*16px/.test(css));
});
