// web/story/shelf.js — 我的故事书·书架（SPEC design/story-recap/SPEC.md §2）。
//
// 「书架：在『我的用法』里加入『我的故事书』，按时间排列所有章节（封面
// 缩略图），可以重看、重播、导出海报。」封面视觉基准 = 原型 p0 的 book 卡
// （品牌橙渐变、书脊 inset、右侧书签纹、章号+标题+期间+统计行）。
//
// 结构：纯函数（node --test 直接测）——排序（契约注释「书架按时间排列
// 保新」→ 新章在前）、类型标签（周记/月章/年书）、封面主题、书架模型、
// 存储读取视图；浏览器函数——renderShelf/mountShelf（DOM，内联样式，
// 不依赖 story.css——那是别的线的名下文件）。顶层零 DOM。
//
// 契约来源 web/story/contracts.js（fa41b18）：章节形状、sanitizeStoreText
// （unknown 绝不覆盖）。标题派生复用 poster.js 的 posterTitle（同一线的
// 名下文件），封面用第二人称（原型 p0「你」），海报用第一人称（p9「我」）。

import { validateChapter, sanitizeStoreText, CAPTION_MAX } from './contracts.js';
import { posterTitle, formatPeriodRange, sharePoster } from './poster.js';

// SPEC §2 三个书架动作；pages/player 线接线时按此约定 handlers。
export var SHELF_ACTIONS = ['open', 'replay', 'export'];

var TYPE_LABELS = { week: '周记', month: '月章', year: '年书' };

export function chapterTypeLabel(type) {
  return TYPE_LABELS[type] || null;
}

// 封面主题：month = 原型 p0 book 的品牌橙；week = 原型奖章金（#E8B04B→
// #9A6A10，prototype .medal 渐变端点）；year = relay-v2 §3 forest
// (#335D4B) 落到原型封面底 (#1E2B25)。
export var COVER_THEMES = {
  week: { from: '#E8B04B', to: '#9A6A10', ink: '#FFFFFF' },
  month: { from: '#E95432', to: '#B8401F', ink: '#FFFFFF' },
  year: { from: '#335D4B', to: '#1E2B25', ink: '#FFFFFF' },
};

// ---------------------------------------------------------------------------
// 排序与存储视图 — 新章在前（period.from 降序）；并列按章号、id 降序，
// 全程确定性。无效条目丢弃；绝不改动入参。
// ---------------------------------------------------------------------------
export function sortChapters(chapters) {
  if (!Array.isArray(chapters)) return [];
  var valid = [];
  for (var i = 0; i < chapters.length; i += 1) {
    var c = validateChapter(chapters[i]);
    if (c) valid.push(c);
  }
  valid.sort(function (a, b) {
    if (a.period.from !== b.period.from) return a.period.from < b.period.from ? 1 : -1;
    if (a.no !== b.no) return b.no - a.no;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  return valid;
}

export function chaptersFromStore(text) {
  var res = sanitizeStoreText(text);
  if (res.status !== 'ok') return { status: res.status, chapters: [] };
  return { status: 'ok', chapters: sortChapters(res.store.chapters) };
}

// ---------------------------------------------------------------------------
// 书架模型 — 封面缩略图数据（纯函数）。titles: { chapterId: 编辑过的标题 }。
// ---------------------------------------------------------------------------
export function shelfModel(chapters, options) {
  var o = options || {};
  var titles = o.titles && typeof o.titles === 'object' ? o.titles : {};
  var sorted = sortChapters(chapters);
  var items = [];
  for (var i = 0; i < sorted.length; i += 1) {
    var c = sorted[i];
    var override = titles[c.id] == null ? '' : String(titles[c.id]).trim();
    var title = override ? override.slice(0, CAPTION_MAX) : posterTitle(c, { person: 'second' });
    items.push({
      id: c.id,
      no: c.no,
      type: c.type,
      typeLabel: TYPE_LABELS[c.type] + (c.variant === 'short' ? ' · 短章' : ''),
      isShort: c.variant === 'short',
      title: title,
      periodRange: formatPeriodRange(c.period),
      statsLine: c.stats.totals.events + ' 件事 · ' + c.stats.totals.aiRelays + ' 次 AI 接力',
      theme: COVER_THEMES[c.type],
      chapter: c, // 供 重看/重播/导出海报 动作直接使用
    });
  }
  return { empty: items.length === 0, count: items.length, items: items };
}

// ---------------------------------------------------------------------------
// 浏览器渲染 — 全部 textContent（无 innerHTML 注入面），内联样式。
// ---------------------------------------------------------------------------
function el(tag, style, text) {
  var node = document.createElement(tag);
  if (style) {
    var keys = Object.keys(style);
    for (var i = 0; i < keys.length; i += 1) node.style[keys[i]] = style[keys[i]];
  }
  if (text != null) node.textContent = String(text);
  return node;
}

var SERIF = '"Songti SC","Noto Serif SC",STSong,serif';

function bookCover(item, onOpen) {
  var theme = item.theme || COVER_THEMES.month;
  var book = el('div', {
    position: 'relative',
    width: '168px',
    height: '228px',
    borderRadius: '6px 16px 16px 6px',
    background: 'linear-gradient(135deg,' + theme.from + ',' + theme.to + ')',
    boxShadow: 'inset 10px 0 0 rgba(0,0,0,.18), 0 12px 24px rgba(0,0,0,.28)',
    padding: '16px 18px 14px 22px',
    boxSizing: 'border-box',
    color: theme.ink,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    cursor: 'pointer',
  });
  book.setAttribute('role', 'button');
  book.setAttribute('tabindex', '0');
  book.setAttribute('aria-label', '重看第 ' + item.no + ' 章' + item.typeLabel + '：' + item.title);
  book.appendChild(el('div', {
    fontSize: '9px', letterSpacing: '2px', opacity: '.85',
  }, '第 ' + item.no + ' 章 · ' + item.typeLabel));
  var title = el('div', {
    fontFamily: SERIF, fontWeight: '900', fontSize: '15px', lineHeight: '1.3',
    marginTop: '10px', maxHeight: '98px', overflow: 'hidden',
  }, item.title);
  book.appendChild(title);
  book.appendChild(el('div', { flex: '1' }));
  book.appendChild(el('div', { fontSize: '8.5px', opacity: '.85' }, item.periodRange));
  book.appendChild(el('div', { fontSize: '8.5px', opacity: '.7', marginTop: '3px' }, item.statsLine));
  // 原型 .book::after 的右侧书签纹
  book.appendChild(el('div', {
    position: 'absolute', right: '6px', top: '8px', bottom: '8px', width: '4px',
    borderRadius: '2px',
    background: 'repeating-linear-gradient(180deg,rgba(255,255,255,.5) 0 2px,transparent 2px 5px)',
  }));
  function open() { if (onOpen) onOpen(item.chapter, item); }
  book.addEventListener('click', open);
  book.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
  });
  return book;
}

function actionButton(label, handler) {
  var btn = el('button', {
    height: '48px', minWidth: '64px', borderRadius: '10px',
    border: '1px solid #E4E2D8', background: '#FFFFFF',
    color: '#252722', fontSize: '14px', fontWeight: '600',
    cursor: 'pointer', padding: '0 12px',
  }, label);
  btn.addEventListener('click', function (ev) {
    ev.stopPropagation();
    if (handler) handler();
  });
  return btn;
}

export function renderShelf(container, model, handlers) {
  if (!container || typeof document === 'undefined') return null;
  var h = handlers || {};
  var root = el('div', { fontFamily: '"PingFang SC","Hiragino Sans GB","Noto Sans SC",system-ui,sans-serif' });
  container.appendChild(root);

  var header = el('div', { display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '14px' });
  header.appendChild(el('h2', { fontSize: '20px', fontWeight: '700', color: '#252722', margin: '0' }, '我的故事书'));
  header.appendChild(el('span', { fontSize: '12px', color: '#64665D' }, model.count > 0 ? model.count + ' 章 · 新章在前' : ''));
  root.appendChild(header);

  if (model.empty) {
    // 事实性空态：不鸡汤、不硬凑（SPEC §1 求真）
    root.appendChild(el('div', {
      padding: '28px 18px', borderRadius: '14px', background: '#F3F0E8',
      color: '#64665D', fontSize: '14px', lineHeight: '1.7',
    }, '还没有章节。生成第一期后，这里会按时间排好。'));
    return root;
  }

  var list = el('div', { display: 'flex', flexWrap: 'wrap', gap: '18px' });
  for (var i = 0; i < model.items.length; i += 1) {
    var item = model.items[i];
    var cell = el('div', { width: '168px' });
    cell.appendChild(bookCover(item, h.onOpen));
    var actions = el('div', { display: 'flex', gap: '6px', marginTop: '10px' });
    actions.appendChild(actionButton('重看', function (it) {
      return function () { if (h.onOpen) h.onOpen(it.chapter, it); };
    }(item)));
    actions.appendChild(actionButton('重播', function (it) {
      return function () { if (h.onReplay) h.onReplay(it.chapter, it); };
    }(item)));
    actions.appendChild(actionButton('海报', function (it) {
      return function () {
        if (h.onExportPoster) h.onExportPoster(it.chapter, it);
        else sharePoster(it.chapter); // 默认：分享/保存本线海报
      };
    }(item)));
    cell.appendChild(actions);
    list.appendChild(cell);
  }
  root.appendChild(list);
  return root;
}

// 便捷挂载：loadText() → localStorage 原文（或 loadChapters() → 章节数组）。
// unknown 存储绝不覆盖（契约），书架显示空态 + 一行说明。
export function mountShelf(container, options) {
  var o = options || {};
  var res;
  if (typeof o.loadText === 'function') {
    res = chaptersFromStore(o.loadText());
  } else if (typeof o.loadChapters === 'function') {
    res = { status: 'ok', chapters: sortChapters(o.loadChapters()) };
  } else {
    res = { status: 'empty', chapters: [] };
  }
  var model = shelfModel(res.chapters, { titles: o.titles });
  renderShelf(container, model, o.handlers);
  if (res.status === 'unknown' && typeof document !== 'undefined') {
    container.appendChild(el('div', {
      marginTop: '10px', fontSize: '12px', color: '#B4432F',
    }, '本地故事数据暂不可读，为避免覆盖暂未显示章节。'));
  }
  return model;
}
