// M17 预演片全屏播放器 —— 「▶ 今日预演」点开的全屏 role=dialog 播放器（纯核 + DOM 壳）
// 依据：PRD §5.2.4（预演片：全屏播放、字幕 aria-live、3px 进度、暂停/继续/重播/关闭 + Esc、
//   旁白 speechSynthesis 逐句 + 无 TTS 降级 + 9s 兜底、「示意」水印、reduced-motion 全降级）、
//   §5.8（动画尊重 reduced motion）、§5.2 末（增量更新教训——字幕/进度只打补丁不重绘舞台）、
//   §10.3 reel 字段；prototype.html（唯一视觉/交互标准）：
//   L165-177  .reel 全屏遮罩(fixed inset 0 z40) / .stage 16:9 / .shot opacity .6s 切换 /
//             .on img kb 7s ease-out forwards 推近 / .cap 渐变字幕(small at + 正文) / .prog 3px / .ctl
//   L171-172  @keyframes kb：scale(1)→scale(1.09) translate(-2%,-1%)
//   L184-185  prefers-reduced-motion：animation/transition 全 none !important（rm 全降级）
//   L539-560  openReel 结构原文：role=dialog aria-label=今日预演片、.wm 示意在 stage 内、
//             .cap aria-live=polite、.ctl 两钮（暂停/关闭）
//   L562-576  nextShot 驱动：.on 唯一切换、字幕 at+text、prog=(i+1)/n*100%、TTS 逐句
//             （先 cancel 再 speak、zh-CN、rate 1.1、onend→250ms 推进、onerror→3500ms、
//              9s 硬兜底 fin 单次守卫）、无 TTS 4500ms/句；播完冻结末镜只变「重播」
//   L577      closeReel：清定时器 + speechSynthesis.cancel + 移除遮罩（幂等）
//   L623      暂停钮：暂停↔继续；播完点击 = 重播（openReel 重开）；暂停 cancel、继续重放当前镜
//   L648      Esc 关闭（document keydown）
// 契约：mount(el, props) → handle { el, update(props), next(), pause(), resume(), close(),
//   get idx, get paused, get finished }
//   props = { shots: [{ at, body, text }], onClose, speech?, schedule?, win?, doc? }
//   at/text 为外部字符串，入 HTML 必经 esc；body 是宿主（demo/W11 合成运行时）已合成的
//   受信 HTML 原样入镜（W11 薄接缝，见 shotHTML）。
// W11 薄接缝（plan §1.5/DAG M17）：本组件只吃静态 shots 轮播；
//   TODO(W11)：当 shots[].body 内携带 data-start/data-duration 时间轴属性时，优先按其
//   节拍驱动（合成运行时归 web/agentic/reel/，届时经 handle.next()/sequencer 注入即可）。
// 与原型的有意差异（记录在案，同 M09 storyboard 模式）：
//   1) 多实例组件去 id（#reelProg/#reelAt/#reelTxt/#reelPause/#reelClose → 类/数据属性 +
//      容器级事件委托 + data-reel-ctl）；document Esc 监听在 close() 时移除（两实例不串扰）；
//   2) 按钮加 type=button（表单内不触发提交）；
//   3) 播完冻结末镜画面（原型 nextShot 越界 return 语义），仅首钮变「重播」。
// esc/setHTML 探测 M01 web/agentic/ui/utils.js（同 M03-M16 并行落地模式），未落地本地兜底。
let escShared = null;
let setHTMLShared = null;
try {
  const utils = await import('./utils.js');
  if (typeof utils.esc === 'function') escShared = utils.esc;
  if (typeof utils.setHTML === 'function') setHTMLShared = utils.setHTML;
} catch {
  // utils.js 不存在（M01 未落地）：本地兜底，规则与 prototype L328-329 五实体/内容比对一致
}

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** 五实体转义（M01 XSS 基线）：外部字符串入 HTML/属性必经 */
export const esc = escShared ?? ((s) => String(s).replace(/[&<>"']/g, (c) => ESC_MAP[c]));
/** 内容没变就不重写 DOM（prototype L328：增量更新基石——舞台/字幕不被冲掉） */
export const setHTML = setHTMLShared ?? ((el, html) => {
  if (!el || el._h === html) return false;
  el._h = html;
  el.innerHTML = html;
  return true;
});

const arr = (v) => (Array.isArray(v) ? v : []);

// ---------- 常量（prototype 原文） ----------
export const WATERMARK = '示意'; // L558：生成画面示意水印（PRD §5.2.1/§5.2.4）
export const DIALOG_LABEL = '今日预演片'; // L556 aria-label
export const BTN_PAUSE = '暂停'; // L559/L623
export const BTN_RESUME = '继续'; // L623
export const BTN_REPLAY = '重播'; // L565：播完首钮变重播
export const BTN_CLOSE = '关闭'; // L559
export const LANG = 'zh-CN'; // L568
export const RATE = 1.1; // L568
export const ADVANCE_MS = 250; // L565 go()：句读完 250ms 切下一镜
export const NO_TTS_MS = 4500; // L575：无 TTS 4.5s/句降级
export const TTS_ERROR_MS = 3500; // L568：onerror 3.5s 兜底
export const HARD_FIN_MS = 9000; // L570：9s 硬兜底（onend 永不来也推进）

// ---------- 纯核：镜头归一与 HTML 构建（prototype L553-561 openReel 结构） ----------

/** 镜头归一：{at, body, text} 缺字段补空串、值归字符串；非对象（null/字符串/数组）→ null */
export function normShot(shot) {
  if (!shot || typeof shot !== 'object' || Array.isArray(shot)) return null;
  const s = (v) => (v == null ? '' : String(v));
  return { at: s(shot.at), body: s(shot.body), text: s(shot.text) };
}

/**
 * 单镜节点：.shot[data-i] > body 原样（W11 薄接缝：body 为宿主已合成受信 HTML，
 * 不二次转义——demo 装配走 M08 frameInner（模板+示意水印），合成运行时走 W11 时间轴）。
 */
export function shotHTML(shot, i) {
  const s = normShot(shot);
  if (!s) return '';
  // TODO(W11)：识别 body 内 data-start/data-duration 时间轴属性时改按其节拍驱动（见文件头）。
  return `<div class="shot" data-i="${i}">${s.body}</div>`;
}

/** 字幕内核：small 时间小标 + span 正文（at/text 外部字符串必经 esc；L558 结构） */
export function capHTML(shot) {
  const s = normShot(shot) ?? {};
  return `<small>${esc(s.at)}</small><span>${esc(s.text)}</span>`;
}

/** 控制排：暂停/继续/重播（data-reel-ctl=toggle）+ 关闭（L559/L623/L565 三态归属首钮） */
export function ctlHTML() {
  return `<button type="button" data-reel-ctl="toggle">${BTN_PAUSE}</button>`
    + `<button type="button" data-reel-ctl="close">${BTN_CLOSE}</button>`;
}

/**
 * 整播放器：<div class=reel role=dialog aria-label> > div > .stage(.prog + shots +
 * .cap[aria-live=polite] 首镜字幕已入 + .wm 示意) + .ctl（prototype L556-559 顺序）。
 * 空集合出空壳（cap 空串仍渲染，aria-live 常驻）。
 */
export function reelHTML(shots) {
  const list = arr(shots).map(normShot).filter(Boolean);
  const cap = list.length ? capHTML(list[0]) : capHTML({});
  return `<div class="reel" role="dialog" aria-label="${DIALOG_LABEL}">`
    + `<div><div class="stage"><div class="prog"></div>`
    + list.map((s, i) => shotHTML(s, i)).join('')
    + `<div class="cap" aria-live="polite">${cap}</div><span class="wm">${WATERMARK}</span></div>`
    + `<div class="ctl">${ctlHTML()}</div></div></div>`;
}

/** 进度百分比：(i+1)/len*100，越界钳 100，len≤0 归 0（prototype L566 原式） */
export function progressPct(i, len) {
  if (!Number.isFinite(len) || len <= 0) return 0;
  const n = (Number(i) + 1) / len * 100;
  return Math.max(0, Math.min(100, n));
}

/** 首钮三态文案：播完（idx≥len）→重播 优先；暂停→继续；默认暂停（L565/L623） */
export function ctlLabel({ idx, len, paused } = {}) {
  if (Number(idx) >= Number(len)) return BTN_REPLAY;
  return paused ? BTN_RESUME : BTN_PAUSE;
}

// ---------- 纯核：样式兜底（prototype L165-185 视觉标准；M01 agentic.css 落地前组件级自足） ----------

export const REEL_CSS = `
.reel { position: fixed; inset: 0; z-index: 40; background: rgba(12, 18, 15, .86); display: grid; place-items: center; padding: 16px; }
.reel > div { width: min(960px, 100%); }
.reel .stage { position: relative; width: 100%; aspect-ratio: 16 / 9; border-radius: 16px; overflow: hidden; background: #000; }
.reel .shot { position: absolute; inset: 0; opacity: 0; transition: opacity .6s; }
.reel .shot.on { opacity: 1; }
.reel .shot img { width: 100%; height: 100%; object-fit: cover; }
.reel .shot.on img { animation: kb 7s ease-out forwards; }
@keyframes kb { from { transform: scale(1) translate(0, 0); } to { transform: scale(1.09) translate(-2%, -1%); } }
.reel .cap { position: absolute; left: 0; right: 0; bottom: 0; padding: 18px 22px 20px; color: #fff; background: linear-gradient(transparent, rgba(0,0,0,.72)); font-size: clamp(14px, 2.2vw, 19px); }
.reel .cap small { display: block; opacity: .75; font-size: 12px; margin-bottom: 2px; letter-spacing: .08em; }
.reel .prog { position: absolute; left: 0; top: 0; height: 3px; background: var(--you, #E95432); width: 0; }
.reel .wm { position: absolute; right: 8px; bottom: 6px; font-size: 11px; color: #fff; background: rgba(0,0,0,.38); border-radius: 6px; padding: 1px 6px; letter-spacing: .1em; }
.reel .ctl { display: flex; gap: 10px; margin-top: 12px; justify-content: center; }
.reel .ctl button { background: rgba(255,255,255,.12); color: #fff; border: 1px solid rgba(255,255,255,.25); border-radius: 10px; padding: 8px 16px; cursor: pointer; font: inherit; }
.reel .ctl button:focus-visible { outline: 2px solid var(--you, #E95432); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .reel *, .reel *::before, .reel *::after { animation: none !important; transition: none !important; } }
`;

/** 幂等注入样式（boundaries ensureStyles 同款；无 doc 安全跳过不炸） */
export function ensureStyles(doc) {
  if (!doc || typeof doc.createElement !== 'function') return false;
  if (typeof doc.querySelector === 'function' && doc.querySelector('style[data-agentic-reel]')) return false;
  const st = doc.createElement('style');
  if (typeof st.setAttribute === 'function') st.setAttribute('data-agentic-reel', '');
  st.textContent = REEL_CSS;
  const head = doc.head || doc.documentElement;
  if (!head || typeof head.appendChild !== 'function') return false;
  head.appendChild(st);
  return true;
}

// ---------- Sequencer：旁白驱动（prototype L562-576 nextShot 的可注入重写） ----------

/** 默认定时器适配：返回取消函数（node 与浏览器同形） */
export const defaultSchedule = (fn, ms) => {
  const g = typeof globalThis !== 'undefined' ? globalThis : null;
  const id = g?.setTimeout ? g.setTimeout(fn, ms) : null;
  return () => { if (id != null && g?.clearTimeout) g.clearTimeout(id); };
};

/** 浏览器 speechSynthesis 适配（prototype L564-569：in window 检测 + zh-CN/rate1.1 逐句） */
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

/**
 * 预演片推进器：start/next/pause/resume/stop（prototype openReel/nextShot/pause 分支/closeReel）。
 *   drive(i)：出镜 onShot(i) → 有 TTS 先 cancel 再逐句 speak（onend→250ms 推进；onerror→
 *   3500ms 兜底；9s 硬兜底，fin 单次守卫防双推）；无 TTS 每镜 4500ms。
 *   pause：换代(epoch)+清定时器+cancel——迟到的 onend/定时器一律不推进（确定语义）。
 *   resume：重放当前镜（prototype reelIdx-=1 + nextShot）。
 *   越过末镜：finished、onFinish 恰一次，画面冻结由壳承载（onShot 不再触发）。
 */
export function createSequencer(opts = {}) {
  const shots = arr(opts.shots).map(normShot).filter(Boolean);
  const onShot = typeof opts.onShot === 'function' ? opts.onShot : () => {};
  const onFinish = typeof opts.onFinish === 'function' ? opts.onFinish : () => {};
  const speech = opts.speech && typeof opts.speech === 'object' && opts.speech.available
    ? opts.speech
    : { available: false, speak() {}, cancel() {} };
  const schedule = typeof opts.schedule === 'function' ? opts.schedule : defaultSchedule;

  let idx = 0;
  let started = false;
  let paused = false;
  let finished = false;
  let epoch = 0;
  let cancels = [];

  const clearTimers = () => {
    for (const c of cancels) {
      try { c(); } catch { /* 取消器异常不拖垮 UI */ }
    }
    cancels = [];
  };
  const pushTimer = (fn, ms) => { cancels.push(schedule(fn, ms)); };
  const cancelSpeech = () => {
    if (!speech.available) return;
    try { speech.cancel(); } catch { /* 上游异常不拖垮 UI */ }
  };

  function drive(my) {
    if (my !== epoch || paused) return;
    if (idx >= shots.length) {
      finished = true;
      clearTimers();
      onFinish();
      return;
    }
    onShot(idx); // 先出镜再念（prototype L567-569）
    let done = false;
    const fin = () => { // 单次守卫（prototype L567 done 标志：onend/onerror/9s 三路只走第一）
      if (done || my !== epoch || paused) return;
      done = true;
      pushTimer(() => {
        if (my !== epoch || paused) return;
        idx += 1;
        drive(my);
      }, ADVANCE_MS);
    };
    if (speech.available) {
      cancelSpeech(); // prototype L568：nextShot 开口前先 cancel
      speech.speak(shots[idx].text ?? '', {
        onend: fin,
        onerror: () => {
          if (my !== epoch || paused) return;
          pushTimer(fin, TTS_ERROR_MS); // L568：onerror→3500ms 兜底
        },
      });
      pushTimer(fin, HARD_FIN_MS); // L570：9s 硬兜底
    } else {
      pushTimer(fin, NO_TTS_MS); // L575：无 TTS 4500ms/句
    }
  }

  return {
    start() { // 开场/重播（prototype openReel 全量重置语义）
      epoch += 1;
      clearTimers();
      idx = 0;
      started = true;
      paused = false;
      finished = false;
      drive(epoch);
      return true;
    },
    next() { // 手动切镜（spec handle.next()；未开场/已播完不推进）
      if (!started || finished) return false;
      epoch += 1;
      clearTimers();
      idx += 1;
      drive(epoch);
      return true;
    },
    pause() { // prototype L623 暂停分支：清定时器 + cancel
      if (!started || paused || finished) return false;
      paused = true;
      epoch += 1;
      clearTimers();
      cancelSpeech();
      return true;
    },
    resume() { // prototype L623 继续分支：reelIdx-=1 + nextShot → 重放当前镜
      if (!started || !paused || finished) return false;
      paused = false;
      epoch += 1;
      clearTimers();
      drive(epoch);
      return true;
    },
    stop() { // prototype L577 closeReel 清理：一切停
      epoch += 1;
      clearTimers();
      started = false;
      paused = false;
      cancelSpeech();
      return true;
    },
    get idx() { return idx; },
    get paused() { return paused; },
    get finished() { return finished; },
  };
}

// ---------- DOM 壳 ----------

/**
 * 壳（组件页 ?c=reel-player / demo 装配）：mount(el, props) → handle。
 * mount 即自动开场（prototype openReel 后立即 nextShot）；播放全程只打补丁——
 * .on 切 class、字幕 textContent、进度 style.width、首钮文案，绝不重绘舞台（PRD §5.2 末教训）。
 * close()：stop 旁白/定时器 → 移除 Esc 监听 → onClose() 恰一次 → 清空宿主（幂等）。
 */
export function mount(el, props = {}) {
  const state = { shots: [], onClose: null };
  let seq = null;
  let sig = null;
  let closed = false;
  let onKey = null;

  const doc = props.doc ?? (typeof document !== 'undefined' ? document : null);
  const win = props.win ?? (typeof window !== 'undefined' ? window : undefined);
  const speech = props.speech && typeof props.speech === 'object' ? props.speech : defaultSpeech(win);
  const schedule = typeof props.schedule === 'function' ? props.schedule : defaultSchedule;

  const q = (sel) => (typeof el?.querySelector === 'function' ? el.querySelector(sel) : null);
  const qAll = (sel) => (typeof el?.querySelectorAll === 'function' ? el.querySelectorAll(sel) : []);

  /** 出镜 i：.on 唯一、字幕、进度、首钮文案（sequencer 保证 i<len；播完冻结末镜由其
   *  不再触发 onShot + refreshLabel 变「重播」承载，prototype L565 越界 return 语义） */
  function applyShot(i) {
    const len = state.shots.length;
    const nodes = qAll('.reel .shot') || [];
    for (let k = 0; k < nodes.length; k += 1) {
      try { nodes[k]?.classList?.toggle?.('on', k === i); } catch { /* 节点被剥不炸 */ }
    }
    const sm = q('.reel .cap small');
    const sp = q('.reel .cap span');
    if (sm) sm.textContent = state.shots[i]?.at ?? '';
    if (sp) sp.textContent = state.shots[i]?.text ?? '';
    const prog = q('.reel .prog');
    if (prog) prog.style.width = `${progressPct(i, len)}%`;
    const btn = q('.reel .ctl button[data-reel-ctl="toggle"]');
    if (btn) btn.textContent = ctlLabel({ idx: i, len, paused: !!(seq && seq.paused) });
  }

  /** 首钮文案按当前状态刷新（暂停/继续/播完三态，L623/L565） */
  function refreshLabel() {
    const btn = q('.reel .ctl button[data-reel-ctl="toggle"]');
    if (btn && seq) btn.textContent = ctlLabel({ idx: seq.idx, len: state.shots.length, paused: seq.paused });
  }

  function build() {
    setHTML(el, reelHTML(state.shots));
    if (doc) ensureStyles(doc);
    if (seq) seq.stop();
    closed = false;
    seq = createSequencer({
      shots: state.shots,
      speech,
      schedule,
      onShot: applyShot,
      onFinish: refreshLabel,
    });
    seq.start(); // mount/换片即开场（prototype openReel → nextShot）
  }

  function close() {
    if (closed) return;
    closed = true;
    if (seq) seq.stop();
    if (onKey && doc && typeof doc.removeEventListener === 'function') {
      try { doc.removeEventListener('keydown', onKey); } catch { /* 移除失败不拖垮关闭 */ }
      onKey = null;
    }
    if (typeof state.onClose === 'function') {
      try { state.onClose(); } catch { /* 宿主回调异常不阻塞关闭 */ }
    }
    setHTML(el, ''); // 移除遮罩（prototype L577 remove 语义；spec：.reel count 0）
  }

  function toggle() {
    if (!seq) return;
    if (seq.finished) {
      seq.start(); // 播完点击 = 重播（prototype L623 openReel 重开）
      return;
    }
    if (seq.paused) seq.resume();
    else seq.pause();
    refreshLabel();
  }

  function apply(p) {
    if (!p || typeof p !== 'object') return;
    if ('onClose' in p && typeof p.onClose === 'function') state.onClose = p.onClose;
    if ('shots' in p) {
      const list = arr(p.shots).map(normShot).filter(Boolean);
      const next = JSON.stringify(list);
      if (next !== sig) {
        sig = next;
        state.shots = list;
        build(); // 换片重开新片（同集合零写，播放不动）
      }
    }
  }

  if (typeof el?.addEventListener === 'function') {
    // 容器级点击委托（prototype document click 的组件内版；宿主重建后监听不丢）
    el.addEventListener('click', (e) => {
      const btn = e?.target?.closest?.('button[data-reel-ctl]');
      const act = btn?.dataset?.reelCtl;
      if (act === 'toggle') toggle();
      else if (act === 'close') close();
    });
  }

  // Esc 关闭（prototype L648 document keydown；close 时移除，多实例不串扰）
  if (doc && typeof doc.addEventListener === 'function') {
    onKey = (e) => { if (e?.key === 'Escape') close(); };
    try { doc.addEventListener('keydown', onKey); } catch { onKey = null; }
  }

  // 初始装配：props.shots/onClose 先入 state，无条件首建一次（缺 props 出零镜空壳）；
  // 后续 update 走 apply 的签名变更检测（同集合零写）。
  if (props && typeof props === 'object') {
    if (typeof props.onClose === 'function') state.onClose = props.onClose;
    if ('shots' in props) state.shots = arr(props.shots).map(normShot).filter(Boolean);
  }
  sig = JSON.stringify(state.shots);
  build();

  const handle = {
    el,
    update(p) {
      apply(p);
      return handle;
    },
    next() {
      return seq ? seq.next() : false;
    },
    pause() {
      const r = seq ? seq.pause() : false;
      refreshLabel();
      return r;
    },
    resume() {
      const r = seq ? seq.resume() : false;
      refreshLabel();
      return r;
    },
    close,
    get idx() { return seq ? seq.idx : 0; },
    get paused() { return !!(seq && seq.paused); },
    get finished() { return !!(seq && seq.finished); },
  };
  return handle;
}
