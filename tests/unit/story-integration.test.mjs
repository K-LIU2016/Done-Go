import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  STORY_PAGE_TYPES,
  normalizePageRender,
  createStoryPageRenderer,
  createStoryAudioAdapter,
  storyBannerModel,
  renderStoryBanner,
} from '../../web/story/integration.js';
import { renderPassport, buildPassportModel } from '../../web/relay/passport.js';

function passportMarkup() {
  return renderPassport(buildPassportModel([], {}));
}

test('story integration exposes one page renderer contract for both page families', () => {
  assert.deepEqual(STORY_PAGE_TYPES, [
    'cover', 'numbers', 'timeColors', 'specialDay', 'lessons',
    'savedTime', 'rhythm', 'panels', 'wish', 'poster',
    'yearSpectrum', 'yearFirstLast', 'yearStreak', 'yearGenres',
    'yearKeywords', 'yearWall',
  ]);

  const renderer = createStoryPageRenderer({
    numbers: {
      pageModel: () => ({ ok: true }),
      pageView: (model, captions) => '<p data-kind="string">' + model.ok + ':' + captions.x + '</p>',
    },
    savedTime: {
      renderPage: () => ({ outerHTML: '<section data-kind="dom">saved</section>' }),
    },
  });

  assert.equal(renderer({ type: 'numbers', params: {} }, 1, { captions: { x: 'caption' } }), '<p data-kind="string">true:caption</p>');
  assert.equal(renderer({ type: 'savedTime', params: {} }, 5, {}), '<section data-kind="dom">saved</section>');
});

test('normalizePageRender keeps HTML strings and serializes DOM page roots without object coercion', () => {
  assert.equal(normalizePageRender('<div>ok</div>'), '<div>ok</div>');
  assert.equal(normalizePageRender({ outerHTML: '<section>ok</section>' }), '<section>ok</section>');
  assert.equal(normalizePageRender(null), '');
  assert.equal(normalizePageRender({}), '');
});

test('story audio adapter maps player start/setSegment to soundtrack start/setPage without restarting', () => {
  const calls = [];
  const session = {
    start: (page) => { calls.push(['start', page]); return { ok: true }; },
    setPage: (page) => calls.push(['setPage', page]),
    setMuted: (muted) => calls.push(['setMuted', muted]),
    stop: () => calls.push(['stop']),
  };
  const adapter = createStoryAudioAdapter({ pageCount: 10, session });
  assert.deepEqual(adapter.start({ chapterSeed: 7 }), { ok: true });
  adapter.setSegment(4);
  adapter.setMuted(true);
  adapter.stop();
  assert.deepEqual(calls, [['start', 0], ['setPage', 4], ['setMuted', true], ['stop']]);
});

test('story banner stays factual and links the latest stored chapter', () => {
  const hidden = storyBannerModel([], { now: Date.now(), utcOffsetMinutes: 480 });
  assert.equal(hidden.visible, false);
  assert.equal(renderStoryBanner(hidden), '');

  const chapter = {
    id: '00000000-0000-4000-8000-000000000001',
    no: 10,
    type: 'month',
    variant: 'short',
    period: { from: '2026-10-01', to: '2026-10-31' },
  };
  const visible = storyBannerModel([chapter]);
  assert.equal(visible.visible, true);
  assert.match(renderStoryBanner(visible), /href="#\/story\?chapter=/);
  assert.match(renderStoryBanner(visible), /第 10 章/);
});

test('my usages reserves a story bookshelf mount point', () => {
  const html = passportMarkup();
  assert.match(html, /id="relay-story-shelf"/);
  assert.match(html, /data-slot="story-shelf"/);
});
