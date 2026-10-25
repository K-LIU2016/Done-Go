// web/story/pages/wish.js — ⑧ 写给下一章（SPEC §3 ⑧，原型 p8；SPEC：动效无）。
//
// 页型接口（本线五页统一）：
//   buildWishModel(chapter)           → 纯 view-model（node 可测，不改 chapter）
//   renderWishPage(chapter, ctx)      → HTMLElement（含输入框与保存按钮）
//     ctx.reducedMotion?: boolean     — 本页无入场动效，字段保持接口一致
//     ctx.replay?: boolean            — 书架重播：输入只读、保存按钮隐藏
//     ctx.onSaveWish?: (wish:{text,category}) => void
//                                       「存进下一章」触发；category 由
//                                       classifyWishText 规则判定（可解释）
//
// 心愿分类规则（SPEC §3 ⑧「规则匹配：早睡、运动、学习、陪伴等可量化的心愿
// 会给出数据；不可量化的只做温柔复述」）：关键词命中即归类，判定顺序 =
// 契约 WISH_CATEGORIES 列序（sleep → exercise → learning → company → other）；
// 一句心愿只取第一个命中的类别，保证下一章回应口径唯一。
// 红线：回应与引导文案只呈现事实（wishEcho.reply 由 narrative 线按模板生成），
// 不鸡汤、不夸大、不使用「留白」。

import { WISH_TEXT_MAX } from '../contracts.js';

export var PAGE_TYPE = 'wish';

// 关键词表（可解释；按类别列序判定）。
export var WISH_KEYWORDS = {
  sleep: ['早睡', '早点睡', '睡', '熬夜', '作息'],
  exercise: ['跑步', '跑', '运动', '健身', '锻炼', '走路', '步行'],
  learning: ['学习', '学', '读书', '读', '书', '课', '英语', '技能', '论文'],
  company: ['陪', '陪伴', '家人', '妈妈', '爸爸', '朋友', '电话', '回家'],
};

export function classifyWishText(text) {
  var t = String(text == null ? '' : text);
  if (!t.trim()) return 'other';
  var order = ['sleep', 'exercise', 'learning', 'company'];
  for (var i = 0; i < order.length; i += 1) {
    var words = WISH_KEYWORDS[order[i]];
    for (var w = 0; w < words.length; w += 1) if (t.includes(words[w])) return order[i];
  }
  return 'other';
}

// 下一期间的称呼（原型 p8「写给十一月的自己」）。
export function nextPeriodName(period, type) {
  var from = period && String(period.from || '');
  var m = /^(\d{4})-(\d{2})-/.exec(from);
  if (type === 'year' || !m) return '明年';
  if (type === 'week') return '下一周';
  var names = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
  var next = parseInt(m[2], 10) % 12; // 12 月 → 1 月
  return names[next];
}

// 没有上一章心愿可回应时的引导：事实性，不鸡汤。不自称「第一章」——
// echo 为空也可能是上一章没写心愿，是否第一章并不由此可知（求真红线）。
export var FIRST_CHAPTER_NOTE = '上一章没有留下心愿。这一章写一句，下一章会用数据回应它。';

export function buildWishModel(chapter) {
  var stats = chapter && chapter.stats;
  var echoStored = stats && stats.wishEcho ? stats.wishEcho : null;
  var echo = echoStored
    ? {
        quote: '“' + echoStored.text + '”',
        reply: echoStored.reply,
        matched: echoStored.matched === true,
        facts: Array.isArray(echoStored.facts) ? echoStored.facts : [],
      }
    : null;
  var nextName = nextPeriodName(chapter && chapter.period, chapter && chapter.type);
  var existing = chapter && chapter.wish ? chapter.wish : null;
  return {
    pageType: PAGE_TYPE,
    echoKicker: '上一章你写下的心愿',
    echo: echo,
    firstChapterNote: FIRST_CHAPTER_NOTE,
    inputHeading: '写给' + nextName + '的自己',
    placeholder: '一句就好，下个月我们一起看看',
    saveLabel: '存进下一章',
    savedLabel: '已存进下一章',
    maxLen: WISH_TEXT_MAX,
    existingWish: existing,
  };
}

// ---------------------------------------------------------------------------
// DOM 渲染（原型 p8：.pg.p8 → inner → k, .callback, k, .wish, button.save）。
// SPEC §3 ⑧ 动效列 = 无：本页不做入场动画（reducedMotion 无需分支）。
// ---------------------------------------------------------------------------

function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function renderWishPage(chapter, ctx) {
  ctx = ctx || {};
  var model = buildWishModel(chapter);
  var page = el('section', 'pg p8');
  page.dataset.storyPage = PAGE_TYPE;

  var inner = el('div', 'inner');
  page.appendChild(inner);

  if (model.echo) {
    inner.appendChild(el('span', 'k', model.echoKicker));
    var callback = el('div', 'callback');
    callback.style.marginTop = '16px';
    var quote = el('p');
    quote.appendChild(el('em', null, model.echo.quote));
    quote.style.fontStyle = 'normal';
    var arrow = el('p', null, '→ ' + model.echo.reply);
    arrow.style.marginTop = '6px';
    callback.appendChild(quote);
    callback.appendChild(arrow);
    // 可量化心愿的口径事实（SPEC §3 ⑧：可量化的心愿给出数据）。
    model.echo.facts.forEach(function (fact) {
      var row = el('p');
      row.dataset.metric = 'wishEcho.fact.' + fact.label;
      row.style.cssText = 'margin-top:6px;font-size:12.5px;opacity:.85';
      row.textContent = fact.label + '：' + fact.value;
      callback.appendChild(row);
    });
    inner.appendChild(callback);
  } else {
    inner.appendChild(el('span', 'k', model.echoKicker));
    var first = el('div', 'callback');
    first.style.marginTop = '16px';
    first.textContent = model.firstChapterNote;
    inner.appendChild(first);
  }

  var heading = el('span', 'k', model.inputHeading);
  heading.style.marginTop = '26px';
  inner.appendChild(heading);

  var box = el('div', 'wish');
  box.style.marginTop = '22px';
  var em = el('em', null, model.placeholder);
  box.appendChild(em);
  var input = document.createElement('textarea');
  input.className = 'wish-input';
  input.maxLength = model.maxLen;
  input.setAttribute('aria-label', '写给下一章的心愿');
  input.rows = 2;
  input.style.cssText =
    'width:100%;background:transparent;border:0;outline:none;color:rgba(255,255,255,.95);font:inherit;font-size:15px;line-height:1.7;resize:none;margin-top:4px';
  if (model.existingWish) input.value = model.existingWish.text;
  box.appendChild(input);
  inner.appendChild(box);

  var save = el('button', 'save', model.saveLabel);
  save.type = 'button';
  if (ctx.replay || typeof ctx.onSaveWish !== 'function') {
    // 重播或无宿主回调：只读展示，不产生新写入。
    input.readOnly = true;
    if (model.existingWish) {
      save.textContent = model.savedLabel;
      save.disabled = true;
    } else {
      save.disabled = true;
    }
  } else {
    var saved = false;
    save.addEventListener('click', function () {
      var text = input.value.trim();
      if (!text || saved) return;
      saved = true;
      save.disabled = true;
      save.textContent = model.savedLabel;
      ctx.onSaveWish({ text: text, category: classifyWishText(text) });
    });
    input.addEventListener('input', function () {
      if (!saved) {
        save.disabled = !input.value.trim();
      }
    });
    save.disabled = !input.value.trim();
  }
  inner.appendChild(save);

  return page;
}
