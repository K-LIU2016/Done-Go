// M09 分镜轴 + 旁白控件 —— 预演 tab 的「下午会这样进行」时间线分镜与旁白（纯核 + DOM 壳）
// 依据：PRD §5.2.3（时间线分镜：横向时间轴、播放头扫过、agent 小头像、用户触点标出、
//   prefers-reduced-motion 时静态分步；旁白 30–60 秒中文口播、字幕同步）、§5.8（旁白有字幕、
//   动画尊重 reduced motion）、§5.2 末（增量更新：整块重绘会冲掉旁白字幕）、
//   §10.3 storyboard[{at,actor,text,need}] 字段名；
//   prototype.html（唯一视觉/交互标准）：
//   L86-95   .story/.rail/.ev（两行交错 .you/.lit）/.head/.ticks/.narr/.subtitle 结构与样式钩子
//   L407-408 结构原文：<div class="story"><p class="small muted">下午会这样进行</p> + .rail +
//            .ticks(13:30/14:00/15:00/16:00/17:00) + .narr(▶ 听旁白 + .subtitle 默认文案)
//   L415-425 storyEvents + drawRail：x=窗口百分比 toFixed(1)、clampX 8–92、top=i%2?66:8、
//            .head 随点亮事件走（无点亮 left:0）、you 事件类
//   L426-450 narration 六句 + playNarration：speechSynthesis 逐句（zh-CN、rate 1.1、onend 推进、
//            句间 150ms）、无 TTS 2400ms/句降级、onerror 2200ms 兜底、map[i] 点亮、
//            播完 drawRail() 清点亮（head 归 0、字幕留末句）、播放中再点 = cancel 停
// 契约：mount(el, props) → handle { el, update(props), setLine(i), play(), stop(), speaking }
//   props = { events, lines, map, label?, ticks?, subtitle?, from?, to?, reducedMotion?,
//             speech?, schedule?, onEnd? }
//   events: [at, icon, text, you?][] 或 PRD §10.3 对象形 {at, actor, text, you?}；
//   map[i]：字幕行 i → 点亮事件索引（prototype L437）；update({litIdx}) 的 litIdx 是事件索引。
// W11 接缝（DAG M09）：handle.setLine(i) 供外部时间轴驱动字幕与点亮（预演片/时间轴复用同一轴）。
// 与原型的有意差异（均记录在案）：
//   1) 多实例组件去 id（#rail/#phead/#subtitle/#playNarr → 类选择器 + 容器级事件委托）；
//   2) 按钮加 type=button + aria-pressed、.subtitle 加 aria-live=polite（BUILD-PLAN W5.3 a11y 硬性要求）；
//   3) 播放中按钮文案保持「▶ 听旁白」不变（原型如此），状态由 aria-pressed 承载；
//   4) stop() 冻结当前字幕/点亮（原型 cancel 后浏览器是否补发 onend 存在竞态，此处取确定语义，
//      迟到的 onend/定时器一律不推进——epoch 守卫）；
//   5) 时间窗缺省派生自事件 min/max（原型硬编码 13:20–17:10 仅作回退），可用 from/to 覆盖。

// M01 utils.js 已落地为硬依赖：esc/setHTML 直引共享实现，单一来源
//（并行落地期的「动态探测 + 本地同规则兜底」已收编，组件顶层 await 随之移除）。
import { esc, setHTML } from './utils.js';

export { esc, setHTML }; // 保持既有 re-export 导入面（单测/组件页按组件模块导入）

const arr = (v) => (Array.isArray(v) ? v : []);

// ---------- 常量（prototype 原文） ----------
export const CLAMP_MIN = 8; // clampX 下界（prototype L423）
export const CLAMP_MAX = 92; // clampX 上界
export const ROW_TOPS = [8, 66]; // 两行交错：top = i % 2 ? 66 : 8（prototype L424）
export const LANG = 'zh-CN'; // prototype L439
export const RATE = 1.1; // prototype L439
export const GAP_MS = 150; // 句间停顿（prototype L443）
export const NO_TTS_MS = 2400; // 无 TTS 每句降级时长（prototype L447）
export const TTS_ERROR_MS = 2200; // onerror 兜底时长（prototype L446）
export const PLAY_LABEL = '▶ 听旁白'; // prototype L408
export const DEFAULT_SUBTITLE = '点"听旁白"，30 秒听懂下午怎么进行'; // prototype L408
export const DEFAULT_LABEL = '下午会这样进行'; // prototype L407
export const DEFAULT_TICKS = ['13:30', '14:00', '15:00', '16:00', '17:00']; // prototype L407
export const FALLBACK_WINDOW = [13 * 60 + 20, 17 * 60 + 10]; // prototype L421 硬编码窗（13:20–17:10）

/** PRD §10.3 storyboard[].actor → 头像（prototype storyEvents 用的字模）；you 触点 = ✋（§5.2.3「手」） */
export const ACTOR_ICONS = {
  researcher: '🔎', writer: '✍️', verifier: '🧪', verify: '🧪', deliver: '📦', guide: '🧭', you: '✋',
};

/** 事件归一：数组形 [at, icon, text, you?]；对象形 {at, actor|icon, text, you?}（actor=you 即触点）；其余 null */
export function normEvent(e) {
  if (Array.isArray(e)) return { at: e[0], icon: e[1], text: e[2], you: !!e[3] };
  if (e && typeof e === 'object') {
    const actor = typeof e.actor === 'string' ? e.actor : '';
    return {
      at: e.at,
      icon: e.icon ?? ACTOR_ICONS[actor] ?? '·',
      text: e.text,
      you: e.you != null ? !!e.you : actor === 'you',
    };
  }
  return null;
}

// ---------- 纯核：时间与定位（prototype L244 T / L421-424） ----------
const HM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
/** 'HH:MM' → 当日分钟数；非法返回 NaN */
export function parseHM(t) {
  if (typeof t !== 'string') return NaN;
  const m = HM_RE.exec(t.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

/**
 * 时间窗 [from,to]（分钟）：显式 from/to 优先；缺省取合法事件时刻 min/max
 * （首尾事件夹到 8%/92%，中间均匀展开）；合法时刻不足 2 个回退原型窗 13:20–17:10。
 */
export function windowOf(events, from, to) {
  const f = parseHM(from);
  const t = parseHM(to);
  if (!Number.isNaN(f) && !Number.isNaN(t) && t > f) return [f, t];
  const ts = arr(events)
    .map((e) => parseHM(normEvent(e)?.at))
    .filter((x) => !Number.isNaN(x));
  if (ts.length >= 2) {
    const a = Math.min(...ts);
    const b = Math.max(...ts);
    if (b > a) return [a, b];
  }
  return [FALLBACK_WINDOW[0], FALLBACK_WINDOW[1]];
}

/** 窗口内百分比（数值，未夹紧）；非法时刻/退化窗口按 0 计 */
export function xPct(at, win) {
  const t = parseHM(at);
  const a = win?.[0];
  const b = win?.[1];
  if (Number.isNaN(t) || !Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return ((t - a) / (b - a)) * 100;
}

/** 8–92 夹紧（prototype clampX L423 的数值版） */
export function clampPct(p) {
  return Math.min(CLAMP_MAX, Math.max(CLAMP_MIN, p));
}

/** 事件横向位：百分比先 toFixed(1) 再夹紧（prototype L421-423 语义），返回数值 */
export function clampX(at, win) {
  return clampPct(Number(xPct(at, win).toFixed(1)));
}

/** 播放头横向位：null/越界 lit → 0；有效 → clampX(事件时刻)（prototype L424 head） */
export function headLeft(lit, events, win) {
  const e = normEvent(arr(events)[lit]);
  if (e == null) return 0;
  return clampX(e.at, win);
}
/** 播放头内联 left 串：无点亮裸 0（prototype 原样），有点亮 `N%` */
const headLeftCSS = (lit, events, win) => {
  const n = headLeft(lit, events, win);
  return n === 0 ? '0' : `${n}%`;
};

// ---------- 纯核：HTML 构建（prototype L407-408/L424 结构） ----------
const normLit = (lit, n) => (Number.isInteger(lit) && lit >= 0 && lit < n ? lit : null);

/** 单事件节点：.ev[.you][.lit]，left=clampX%、top=两行交错，.av 头像 + `<at> <text>`（全转义） */
export function eventHTML(ev, i, win, lit) {
  const e = normEvent(ev);
  if (!e) return '';
  const cls = ['ev', e.you ? 'you' : '', normLit(lit, Number.MAX_SAFE_INTEGER) === i ? 'lit' : '']
    .filter(Boolean).join(' ');
  return `<div class="${cls}" style="left:${clampX(e.at, win)}%;top:${ROW_TOPS[i % 2]}px">`
    + `<span class="av">${esc(e.icon ?? '')}</span><span>${esc(e.at ?? '')} ${esc(e.text ?? '')}</span></div>`;
}

/** rail 内容：事件序列 + 末尾播放头 .head（aria-hidden；无点亮 left:0，prototype L424） */
export function railHTML(events, opts = {}) {
  const evs = arr(events);
  const win = opts.win ?? windowOf(evs, opts.from, opts.to);
  const lit = normLit('lit' in opts ? opts.lit : opts.litIdx, evs.length);
  return evs.map((e, i) => eventHTML(e, i, win, lit)).join('')
    + `<div class="head" aria-hidden="true" style="left:${headLeftCSS(lit, evs, win)}"></div>`;
}

/** 旁白控件行：▶ 听旁白按钮（aria-pressed）+ .subtitle 字幕（aria-live，a11y 硬性要求） */
export function narrHTML(subtitle) {
  return `<button class="btn" type="button" aria-pressed="false">${PLAY_LABEL}</button>`
    + `<div class="subtitle" aria-live="polite">${esc(subtitle ?? DEFAULT_SUBTITLE)}</div>`;
}

/** 轴题（prototype L407） */
export function labelHTML(label) {
  return `<p class="small muted">${esc(label ?? DEFAULT_LABEL)}</p>`;
}
const ticksInner = (ticks) => arr(ticks).map((t) => `<span>${esc(t)}</span>`).join('');
/** 时间刻度行（prototype L407） */
export function ticksHTML(ticks) {
  return `<div class="ticks">${ticksInner(ticks)}</div>`;
}

/** 整轴块（宿主补 .story 类后作其内容）：label > .rail > .ticks > .narr（prototype L407-408 顺序） */
export function storyHTML(props = {}) {
  const evs = arr(props.events);
  const lit = normLit(props.litIdx, evs.length);
  return `${labelHTML(props.label)}<div class="rail">${railHTML(evs, { lit, from: props.from, to: props.to })}</div>`
    + `${ticksHTML(props.ticks ?? DEFAULT_TICKS)}<div class="narr">${narrHTML(props.subtitle)}</div>`;
}

// ---------- 纯核：旁白 Sequencer（prototype playNarration L434-450，可注入 speech/schedule） ----------
/** 默认定时器适配：返回取消函数（node 与浏览器同形） */
export const defaultSchedule = (fn, ms) => {
  const g = typeof globalThis !== 'undefined' ? globalThis : null;
  const id = g?.setTimeout ? g.setTimeout(fn, ms) : null;
  return () => { if (id != null && g?.clearTimeout) g.clearTimeout(id); };
};

/** 浏览器 speechSynthesis 适配（prototype L444-446：in window 检测 + zh-CN/rate1.1 逐句） */
export function defaultSpeech(win) {
  const w = win ?? (typeof window !== 'undefined' ? window : undefined);
  const syn = w?.speechSynthesis;
  const U = w?.SpeechSynthesisUtterance;
  if (!syn || typeof syn.speak !== 'function' || typeof syn.cancel !== 'function' || typeof U !== 'function') {
    return { available: false, speak() {}, cancel() {} };
  }
  return {
    available: true,
    speak(text, handlers) {
      const u = new U(text);
      u.lang = LANG;
      u.rate = RATE;
      u.onend = handlers.onend;
      u.onerror = handlers.onerror;
      syn.speak(u);
    },
    cancel() { syn.cancel(); },
  };
}

/** prefers-reduced-motion 探测（无 matchMedia/异常一律 false，不阻塞渲染） */
export function prefersReducedMotion(win) {
  const w = win ?? (typeof window !== 'undefined' ? window : undefined);
  if (typeof w?.matchMedia !== 'function') return false;
  try {
    return !!w.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * 旁白逐句推进器（prototype playNarration 的可注入重写）：
 *   start() 同步出第一句（onLine(0)）→ 有 TTS 逐句 speak（onend 推进；onerror 2200ms 兜底），
 *   无 TTS 每句 2400ms；句间 150ms；播完 onEnd() 恰一次。
 *   stop() 取消挂起定时器与语音；epoch 守卫让迟到的 onend/定时器一律不推进（确定语义）。
 */
export function createNarrator(opts = {}) {
  const lines = arr(opts.lines);
  const map = arr(opts.map); // 保留形参对齐（点亮映射由壳经 onLine/setLine 消化）
  const onLine = typeof opts.onLine === 'function' ? opts.onLine : () => {};
  const onEnd = typeof opts.onEnd === 'function' ? opts.onEnd : () => {};
  const speech = opts.speech && typeof opts.speech === 'object' ? opts.speech : { available: false };
  const schedule = typeof opts.schedule === 'function' ? opts.schedule : defaultSchedule;
  const gapMs = Number.isFinite(opts.gapMs) ? opts.gapMs : GAP_MS;
  const noTtsMs = Number.isFinite(opts.noTtsMs) ? opts.noTtsMs : NO_TTS_MS;
  const ttsErrorMs = Number.isFinite(opts.ttsErrorMs) ? opts.ttsErrorMs : TTS_ERROR_MS;
  void map;

  let speaking = false;
  let i = 0;
  let epoch = 0;
  let cancelTimer = null;

  const clearTimer = () => {
    if (cancelTimer) {
      cancelTimer();
      cancelTimer = null;
    }
  };
  const live = (my) => my === epoch && speaking;

  function step(my) {
    if (!live(my)) return;
    if (i >= lines.length) {
      speaking = false;
      clearTimer();
      onEnd();
      return;
    }
    const idx = i;
    onLine(idx); // 先出字幕再播（prototype L441）
    const advance = () => {
      if (!live(my)) return;
      i += 1;
      cancelTimer = schedule(() => step(my), gapMs);
    };
    if (speech.available) {
      speech.speak(lines[idx], {
        onend: advance,
        onerror: () => {
          if (!live(my)) return;
          cancelTimer = schedule(advance, ttsErrorMs);
        },
      });
    } else {
      cancelTimer = schedule(advance, noTtsMs);
    }
  }

  return {
    start() {
      if (speaking) return false;
      speaking = true;
      i = 0;
      epoch += 1;
      step(epoch);
      return true;
    },
    stop() {
      if (!speaking) return false;
      speaking = false;
      epoch += 1; // 迟到的 onend/定时器从此失效
      clearTimer();
      if (speech.available && typeof speech.cancel === 'function') {
        try {
          speech.cancel();
        } catch { /* 上游异常不拖垮 UI */ }
      }
      return true;
    },
    get speaking() {
      return speaking;
    },
  };
}

// ---------- DOM 壳 ----------
const signature = (events) => arr(events).map((e) => JSON.stringify(e ?? null)).join('\u0001');

/**
 * DOM 壳（组件页 ?c=storyboard / demo 装配）：mount(el, props) → handle。
 * 增量纪律（PRD §5.2 末教训）：setLine/update({litIdx}) 只切 class 与 head 内联 left，
 * 绝不重写 rail；events 签名变才重建 rail（字幕/按钮节点不受影响）；label/ticks 变只打各自补丁。
 */
export function mount(el, props = {}) {
  const state = {
    events: [],
    lines: [],
    map: [],
    label: undefined,
    ticks: DEFAULT_TICKS,
    subtitle: undefined,
    from: undefined,
    to: undefined,
    lit: null,
    rm: false,
    onEnd: null,
  };
  let narrator = null;
  let railSig = null;
  let builtOnce = false;

  const q = (sel) => (typeof el?.querySelector === 'function' ? el.querySelector(sel) : null);
  const qRail = () => {
    const rail = q('.rail');
    return typeof rail?.querySelector === 'function' ? rail : null;
  };
  const speech = props.speech && typeof props.speech === 'object'
    ? props.speech
    : defaultSpeech();
  const schedule = typeof props.schedule === 'function' ? props.schedule : defaultSchedule;
  const winSrc = props.win ?? (typeof window !== 'undefined' ? window : undefined);
  state.rm = typeof props.reducedMotion === 'boolean' ? props.reducedMotion : prefersReducedMotion(winSrc);

  const winNow = () => windowOf(state.events, state.from, state.to);

  function applyRm(evs, head) {
    // 静态步进（PRD §5.2.3）：rm 时内联禁过渡作组件级兜底（全局降级在 M01 agentic.css）；
    // rm 关闭时清内联，让样式表的正常过渡回来。
    for (const n of evs) {
      if (!n?.style) continue;
      if (state.rm) n.style.transition = 'none';
      else if (typeof n.style.removeProperty === 'function') n.style.removeProperty('transition');
      else n.style.transition = '';
    }
    if (head?.style) {
      if (state.rm) head.style.transition = 'none';
      else if (typeof head.style.removeProperty === 'function') head.style.removeProperty('transition');
      else head.style.transition = '';
    }
  }

  // 系统偏好变化即时生效（挂后才切 reduced-motion 也静态化，spec rm 断言不依赖 M01 css）
  if (typeof winSrc?.matchMedia === 'function') {
    try {
      const mq = winSrc.matchMedia('(prefers-reduced-motion: reduce)');
      const onRmChange = (e) => {
        state.rm = !!e?.matches;
        const rail = qRail();
        if (rail && typeof rail.querySelectorAll === 'function') {
          applyRm(rail.querySelectorAll('.ev'), rail.querySelector('.head'));
        }
      };
      if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onRmChange);
      else if (typeof mq.addListener === 'function') mq.addListener(onRmChange); // 旧 Safari
    } catch { /* 媒体查询不可用不阻塞渲染 */ }
  }

  /** 只切 class + head 内联 left（spec「只动 class」契约；节点身份永不重建） */
  function applyLit(lit) {
    state.lit = normLit(lit, state.events.length);
    const rail = qRail();
    if (!rail) return;
    const evs = typeof rail.querySelectorAll === 'function' ? rail.querySelectorAll('.ev') : [];
    for (let i = 0; i < evs.length; i += 1) {
      const n = evs[i];
      if (n?.classList && typeof n.classList.toggle === 'function') n.classList.toggle('lit', i === state.lit);
    }
    const head = rail.querySelector('.head');
    if (head?.style) head.style.left = headLeftCSS(state.lit, state.events, winNow());
    applyRm(evs, head);
  }

  function buildAll() {
    setHTML(el, storyHTML(state));
    railSig = signature(state.events);
    builtOnce = true;
    const rail = qRail();
    if (rail) {
      const evs = typeof rail.querySelectorAll === 'function' ? rail.querySelectorAll('.ev') : [];
      applyRm(evs, rail.querySelector('.head'));
    }
  }

  function buildRail() {
    const rail = qRail();
    if (!rail) return;
    setHTML(rail, railHTML(state.events, { lit: state.lit, win: winNow() }));
    railSig = signature(state.events);
    const evs = typeof rail.querySelectorAll === 'function' ? rail.querySelectorAll('.ev') : [];
    applyRm(evs, rail.querySelector('.head'));
  }

  function setPressed(v) {
    const btn = q('.narr button');
    if (btn && typeof btn.setAttribute === 'function') btn.setAttribute('aria-pressed', v ? 'true' : 'false');
  }

  /** 字幕行 i：字幕=lines[i]（textContent），点亮 map[i]（缺行清点亮，prototype drawRail(map[i]) 语义）。
   *  W11 时间轴接缝：外部按自己的节拍调 setLine 即可驱动整轴。 */
  function setLine(i) {
    if (!state.lines.length) return handle;
    let idx = Number.isInteger(i) ? i : 0;
    idx = Math.max(0, Math.min(idx, state.lines.length - 1));
    const sub = q('.subtitle');
    if (sub) sub.textContent = state.lines[idx];
    applyLit(state.map[idx]);
    return handle;
  }

  function endRun() {
    applyLit(null); // prototype L436：播完 drawRail() 清点亮、head 归 0，字幕留末句
    setPressed(false);
    if (typeof state.onEnd === 'function') state.onEnd();
  }

  function play() {
    narrator = createNarrator({
      lines: state.lines,
      map: state.map,
      onLine: (i) => setLine(i),
      onEnd: endRun,
      speech,
      schedule,
    });
    const ok = narrator.start();
    if (ok) setPressed(true);
    return ok;
  }
  function stop() {
    const was = narrator ? narrator.stop() : false;
    if (was) setPressed(false);
    return was;
  }

  function apply(p) {
    if (!p || typeof p !== 'object') return;
    const eventsChanged = 'events' in p && signature(p.events) !== railSig;
    if ('events' in p) state.events = arr(p.events);
    if ('lines' in p) state.lines = arr(p.lines);
    if ('map' in p) state.map = arr(p.map);
    if ('from' in p) state.from = p.from;
    if ('to' in p) state.to = p.to;
    if ('subtitle' in p) state.subtitle = p.subtitle;
    if ('onEnd' in p && typeof p.onEnd === 'function') state.onEnd = p.onEnd;
    if ('label' in p) {
      state.label = p.label;
      const node = q('p.small.muted');
      if (node && eventsChanged) setHTML(node, esc(state.label ?? DEFAULT_LABEL)); // 仅重建时机同步，避免常态重写
    }
    if ('ticks' in p) {
      state.ticks = arr(p.ticks);
      const node = q('.ticks');
      if (node && eventsChanged) setHTML(node, ticksInner(state.ticks));
    }
    if (!builtOnce || eventsChanged) {
      if (builtOnce) buildRail();
      else buildAll();
    }
    if ('litIdx' in p) applyLit(p.litIdx); // 只动 class（spec 契约）
  }

  if (el && el.classList && typeof el.classList.add === 'function') el.classList.add('story');

  // 容器级点击委托（按钮内只有文本，target 即按钮；宿主 innerHTML 重建后监听不丢）
  if (typeof el?.addEventListener === 'function') {
    el.addEventListener('click', (e) => {
      const btn = q('.narr button');
      if (!btn || !e || e.target !== btn) return;
      if (narrator && narrator.speaking) stop();
      else play();
    });
  }

  apply(props);

  const handle = {
    el,
    update(p) {
      apply(p);
      return handle;
    },
    setLine(i) {
      return setLine(i);
    },
    play,
    stop,
    get speaking() {
      return !!(narrator && narrator.speaking);
    },
  };
  return handle;
}
