// web/story/integration.js — 时光故事书正式 app 接缝。
//
// 这一层只负责把一期故事模块接到正式播放器/首页，不重做 lab 的翻页。
// 它把 T5A 的 string 页型与 T6 的 HTMLElement 页型收敛为 player 接受的
// HTML string；播放器仍由 createStoryPlayer 负责手势、进度、口径卡和音频。
//
// 首页/书架接入方可以按需调用 mountStoryBanner；模块本身没有顶层 DOM 触点，
// 章节数据仍由 story/store.js + scheduler.js 读取，避免复制存储契约。

import { STORY_STORE_KEY } from './contracts.js';
import { createStoryPlayer } from './player.js';
import { createAudioAdapter } from './soundtrack.js';
import { bannerFor } from './scheduler.js';
import { createStoryStore } from './store.js';

export const STORY_PAGE_TYPES = Object.freeze([
  'cover', 'numbers', 'timeColors', 'specialDay', 'lessons',
  'savedTime', 'rhythm', 'panels', 'wish', 'poster',
  'yearSpectrum', 'yearFirstLast', 'yearStreak', 'yearGenres',
  'yearKeywords', 'yearWall',
]);

const DOM_RENDERERS = Object.freeze({
  savedTime: 'renderSavedTimePage',
  rhythm: 'renderRhythmPage',
  panels: 'renderPanelsPage',
  wish: 'renderWishPage',
  poster: 'renderPosterPage',
});

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

/**
 * Normalize both page families to the synchronous renderPage contract.
 *
 * T5A returns markup strings. T6 returns a real HTMLElement because its pages
 * use Web Animations. The player only needs the serialized root here; it will
 * mount that markup inside its own stage and retain all navigation ownership.
 */
export function normalizePageRender(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value.outerHTML === 'string') return value.outerHTML;
  return '';
}

function moduleFor(modules, pageType) {
  if (Array.isArray(modules)) {
    for (const mod of modules) {
      if (mod && mod.PAGE_TYPE === pageType) return mod;
    }
    return null;
  }
  return modules && typeof modules === 'object' ? modules[pageType] || null : null;
}

/**
 * Create the one page renderer used by createStoryPlayer.
 *
 * Accepted module surfaces:
 *   - T5A: { PAGE_TYPE, pageModel, pageView }
 *   - T6:  { PAGE_TYPE, renderSavedTimePage/... }
 *   - T9:  { PAGE_TYPE, renderPage }
 */
export function createStoryPageRenderer(modules) {
  return function renderStoryPage(page, index, ctx) { // index retained for player API symmetry
    const current = page || {};
    const context = ctx || {};
    const mod = moduleFor(modules, current.type);
    if (!mod) return '';

    if (typeof mod.renderPage === 'function') {
      return normalizePageRender(mod.renderPage(current, context, index));
    }

    const domName = DOM_RENDERERS[current.type];
    if (domName && typeof mod[domName] === 'function') {
      // T6 renderers are DOM-only and intentionally stay untouched. In the
      // formal player, create a detached host, let the existing renderer own
      // its DOM work, then serialize the resulting root for player.stage.
      const doc = context.doc || (typeof document !== 'undefined' ? document : null);
      if (!doc || typeof doc.createElement !== 'function') return '';
      const host = doc.createElement('div');
      const rendered = mod[domName](context.chapter, {
        ...context,
        doc,
        page: current,
      });
      if (rendered && typeof rendered.outerHTML === 'string') return rendered.outerHTML;
      if (rendered && host.appendChild) {
        host.appendChild(rendered);
        return normalizePageRender(host.firstElementChild || rendered);
      }
      return '';
    }

    if (typeof mod.pageModel === 'function' && typeof mod.pageView === 'function') {
      const model = mod.pageModel(context.chapter, current.params || {});
      return normalizePageRender(mod.pageView(model, context.captions || {}));
    }

    return '';
  };
}

function validChapters(chapters) {
  if (!Array.isArray(chapters)) return [];
  return chapters.filter((chapter) => chapter && typeof chapter === 'object');
}

/**
 * Player-facing audio seam. The soundtrack session intentionally keeps its
 * native `setPage` name; the player only sees `setSegment`. Keeping this
 * adapter here makes the formal route impossible to wire to a silent naked
 * session by accident.
 */
export function createStoryAudioAdapter(options) {
  const opts = options || {};
  const adapter = createAudioAdapter({
    pageCount: opts.pageCount,
    session: opts.session,
    storage: opts.storage,
    audioApi: opts.audioApi,
  });
  return adapter;
}

export function createStoryPlayerRoute(options) {
  const opts = options || {};
  return createStoryPlayer({
    ...opts,
    audio: opts.audio || createStoryAudioAdapter({
      pageCount: opts.chapter && Array.isArray(opts.chapter.pages) ? opts.chapter.pages.length : 1,
      storage: opts.storage,
      audioApi: opts.audioApi,
    }),
    renderPage: opts.renderPage || createStoryPageRenderer(opts.modules || {}),
  });
}

/**
 * Build a factual banner model from the already generated local chapters.
 *
 * `bannerFor` is still consulted so callers can distinguish a readable latest
 * chapter from a due-but-not-yet-generated chapter. We never fabricate a
 * chapter from a scheduler spec: without stored data there is no #/story
 * target to open.
 */
export function storyBannerModel(chapters, options) {
  const opts = options || {};
  const list = validChapters(chapters);
  const latest = list.slice().sort((a, b) => {
    if (a.period.from !== b.period.from) return a.period.from < b.period.from ? -1 : 1;
    return a.no - b.no;
  }).pop() || null;
  const schedule = bannerFor(opts.now == null ? Date.now() : opts.now, {
    ...opts,
    chapters: list,
  });
  if (!latest) {
    return {
      visible: false,
      pending: !!schedule.visible,
      text: '',
      chapter: null,
      nextNo: schedule.nextNo,
      dueCount: schedule.count,
    };
  }
  return {
    visible: true,
    pending: false,
    text: '📖 你的第 ' + latest.no + ' 章到了',
    chapter: latest,
    nextNo: latest.no,
    dueCount: schedule.count,
  };
}

export function renderStoryBanner(model) {
  const current = model || {};
  if (!current.visible || !current.chapter) return '';
  const chapter = current.chapter;
  return '<a class="card story-banner" data-story-banner="1" href="#/story?chapter=' +
    encodeURIComponent(chapter.id) + '" aria-label="' + esc(current.text) + '">' +
    '<strong>' + esc(current.text) + '</strong>' +
    '<span>打开这一章 · ' + esc(chapter.period.from) + ' — ' + esc(chapter.period.to) + '</span>' +
    '</a>';
}

/**
 * Mount the banner into the stable relay-home slot. This is intentionally an
 * opt-in helper so the relay shell can keep its first screen lazy: importing
 * this module happens only after the home slot exists.
 */
export async function mountStoryBanner(container, options) {
  if (!container || typeof container.querySelector !== 'function') return null;
  const opts = options || {};
  const host = container.querySelector('#relay-home-banner') || container;
  const root = opts.root || (typeof window !== 'undefined' ? window : globalThis);
  const store = opts.store || createStoryStore({ root, storage: opts.storage });
  const chapters = typeof store.chapters === 'function' ? store.chapters() : [];
  const model = storyBannerModel(chapters, opts);
  host.innerHTML = renderStoryBanner(model);
  return model;
}

export function storyStorageKey() {
  return STORY_STORE_KEY;
}
