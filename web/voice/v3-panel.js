// 语音面板 v3（豆包式）：边说边出字 → 停顿定稿 → 即时整理（可编辑）→ 随说随出事项卡片 → 全部加入。
// 服务端协议见 design/voice-pipeline/SPEC.md §2.1（WS /api/voice/v3）。样式见 voice/v3-panel.css。
import { createVoiceCapture } from './capture.js';

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const pad = n => String(n).padStart(2, '0');
const parseDay = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const dayDiff = (a, b) => Math.round((parseDay(a) - parseDay(b)) / 86400000);

/** 卡片上的时间说明：「明天 15:00–16:00 · 10/27」「10/30 前」「每天 07:00」「今晚」 */
export function timeLabel(item, today) {
  const clock = item.start ? item.start + (item.end ? '–' + item.end : '') : '';
  if (item.recurrence) return [item.recurrence, clock].filter(Boolean).join(' ');
  if (item.deadline && !item.date) { const d = parseDay(item.deadline); return `${d.getMonth() + 1}/${d.getDate()} 前`; }
  if (!item.date) return clock || '时间待定';
  const diff = dayDiff(item.date, today);
  const d = parseDay(item.date);
  const rel = diff === 0 ? '今天' : diff === 1 ? '明天' : diff === 2 ? '后天' : `周${WEEK[d.getDay()]}`;
  const vague = !clock && item.vague && item.timeText ? item.timeText : '';
  return [rel, clock || vague].filter(Boolean).join(' ') + (diff > 1 ? ` · ${d.getMonth() + 1}/${d.getDate()}` : '');
}

/** v3 事项 → Kira 记录（{title, kind?, prio, date, start, end}）；没有钟点的交给「待补时间」草稿。 */
export function toEntryDraft(item, today) {
  return {
    title: String(item.title || '').slice(0, 30),
    prio: [1, 2, 3, 4, 5].includes(item.priority) ? item.priority : 3,
    date: item.date || item.deadline || today,
    start: item.start || '',
    end: item.end || (item.start ? addHour(item.start) : ''),
    note: [item.remind, item.recurrence ? '重复：' + item.recurrence : '', item.deadline && !item.date ? '截止 ' + item.deadline : ''].filter(Boolean).join('；'),
  };
}
function addHour(hm) { // 只有开始时间时默认一小时，最晚到 23:59
  const [h, m] = hm.split(':').map(Number);
  const t = Math.min(23 * 60 + 59, h * 60 + m + 60);
  return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

/**
 * 打开面板。opts: { onAdd(drafts) → 返回 Promise<string>（结果提示）, onClose() }
 */
export function openVoicePanel({ onAdd, onClose } = {}) {
  ensureStyles();
  const today = todayStr();
  const root = document.createElement('div');
  root.className = 'v3-overlay';
  root.innerHTML = `
    <div class="v3-sheet" role="dialog" aria-modal="true" aria-label="语音记录">
      <header class="v3-head"><span class="v3-dot" aria-hidden="true"></span><b class="v3-status" role="status">准备话筒…</b><span class="v3-clock">0:00</span><button type="button" class="v3-x" aria-label="关闭">×</button></header>
      <div class="v3-meter" aria-hidden="true"><i></i></div>
      <div class="v3-text" aria-label="识别的文字，可以直接改"><span class="v3-placeholder">说说今天要做的事，可以一次说好几件</span></div>
      <p class="v3-hint">停顿会自动断句 · 文字可以直接点开改</p>
      <section class="v3-cards" aria-live="polite"></section>
      <footer class="v3-foot"><button type="button" class="v3-btn v3-primary" data-v3="stop">说完了</button></footer>
    </div>`;
  document.body.appendChild(root);
  const $ = sel => root.querySelector(sel);
  const textBox = $('.v3-text'), cardsBox = $('.v3-cards'), status = $('.v3-status'), foot = $('.v3-foot'), meter = $('.v3-meter i'), clock = $('.v3-clock');
  const segs = new Map(); // seg → { el, edited }
  let items = [], ws = null, capture = null, phase = 'connecting', closed = false, t0 = 0, timer = null;

  const setStatus = (s, cls) => { status.textContent = s; root.dataset.phase = cls || ''; };
  function segEl(seg) {
    let s = segs.get(seg);
    if (!s) {
      $('.v3-placeholder')?.remove();
      const el = document.createElement('span');
      el.className = 'v3-seg partial'; el.dataset.seg = seg;
      el.addEventListener('focus', () => { el.dataset.before = el.textContent; });
      el.addEventListener('blur', () => {
        if (el.textContent !== el.dataset.before && ws?.readyState === 1) { s.edited = true; el.classList.add('edited'); ws.send(JSON.stringify({ type: 'edit', seg, text: el.textContent })); setCardsPending(); }
      });
      el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
      textBox.appendChild(el);
      s = { el, edited: false }; segs.set(seg, s);
    }
    return s;
  }
  function setSegText(seg, text, kind) {
    const s = segEl(seg);
    if (s.edited) return;
    if (document.activeElement === s.el) return; // 正在改的那句不打断
    s.el.textContent = text;
    s.el.className = 'v3-seg ' + kind;
    s.el.contentEditable = kind === 'partial' ? 'false' : 'true';
    if (kind === 'clean') { s.el.classList.add('flash'); setTimeout(() => s.el.classList.remove('flash'), 700); }
  }
  // 说完：没定稿的实时字（尾巴）清掉；文字换成云端整理稿（含近音纠错），用户改过的句子保留原样
  function showFinalText(clean) {
    textBox.querySelectorAll('.v3-seg.partial').forEach(el => el.remove());
    const edited = [...segs.values()].some(s => s.edited);
    if (clean && !edited) {
      textBox.innerHTML = '';
      const el = document.createElement('span');
      el.className = 'v3-seg clean flash'; el.textContent = clean;
      textBox.appendChild(el);
      setTimeout(() => el.classList.remove('flash'), 700);
    } else textBox.querySelectorAll('.v3-seg').forEach(el => { el.contentEditable = 'false'; });
    $('.v3-hint').textContent = items.length ? '确认无误点「全部加入」，不要的点 ×' : '';
  }
  function setCardsPending() { cardsBox.innerHTML = '<div class="v3-pending"><i></i><i></i><span>正在整理成日程…</span></div>'; }
  function renderCards(final) {
    if (!items.length) { cardsBox.innerHTML = final ? '<p class="v3-empty">没听出要做的事，可以改改上面的文字或重新说</p>' : ''; return renderFoot(); }
    cardsBox.innerHTML = items.map((it, i) => `
      <article class="v3-card p${it.priority || 3}">
        <div class="v3-card-main"><b>${esc(it.title)}</b><span class="v3-when">${esc(timeLabel(it, today))}</span>${it.remind ? `<span class="v3-remind">${esc(it.remind)}</span>` : ''}</div>
        <button type="button" class="v3-del" data-v3="del" data-i="${i}" aria-label="不要「${esc(it.title)}」">×</button>
      </article>`).join('');
    renderFoot();
  }
  function renderFoot() {
    if (phase === 'listening') foot.innerHTML = '<button type="button" class="v3-btn v3-primary" data-v3="stop">说完了</button>';
    else if (phase === 'done') foot.innerHTML = `<button type="button" class="v3-btn" data-v3="again">重新说</button><button type="button" class="v3-btn v3-primary" data-v3="add" ${items.length ? '' : 'disabled'}>全部加入${items.length ? ' ' + items.length + ' 项' : ''}</button>`;
    else foot.innerHTML = '<button type="button" class="v3-btn" disabled>整理中…</button>';
  }

  function stop() {
    if (phase !== 'listening') return;
    phase = 'thinking'; setStatus('整理中', 'thinking'); renderFoot(); setCardsPending();
    clearInterval(timer);
    try { capture?.stop(); } catch {}
    if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'stop' }));
  }
  function close() {
    if (closed) return;
    closed = true; clearInterval(timer);
    try { capture?.stop(); } catch {}
    try { ws?.close(); } catch {}
    root.remove(); onClose?.();
  }
  function restart() { close(); openVoicePanel({ onAdd, onClose }); }

  root.addEventListener('click', async e => {
    const act = e.target.closest('[data-v3]')?.dataset.v3 || (e.target.classList.contains('v3-x') ? 'close' : e.target === root ? 'close' : '');
    if (act === 'close') close();
    else if (act === 'stop') stop();
    else if (act === 'again') restart();
    else if (act === 'del') { items.splice(Number(e.target.dataset.i), 1); renderCards(true); }
    else if (act === 'add' && items.length) {
      foot.innerHTML = '<button type="button" class="v3-btn" disabled>加入中…</button>';
      const msg = await onAdd?.(items.map(it => toEntryDraft(it, today)));
      close();
      return msg;
    }
  });
  root.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

  // 采集必须在点击的同步调用栈里开始（Safari 的 AudioContext 规则），所以先建采集、再连 WS，音频先排队
  const queue = [];
  capture = createVoiceCapture({
    workletURL: new URL('./pcm-worklet.js', import.meta.url),
    silenceTimeoutMs: 1200,
    onFrame: pcm => { const buf = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength); if (ws?.readyState === 1 && phase === 'listening') ws.send(buf); else if (phase !== 'thinking' && phase !== 'done') queue.push(buf); },
    onLevel: level => { meter.style.transform = `scaleX(${Math.min(1, level * 6).toFixed(3)})`; },
    onAutoStop: () => stop(),
  });
  capture.start().catch(error => { setStatus(error?.message || '无法使用话筒 · 检查设备后重试', 'error'); phase = 'done'; renderFoot(); });

  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/voice/v3`);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'start', sampleRate: 16000 }));
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.type === 'ready') {
      phase = 'listening'; setStatus('正在听', 'listening'); renderFoot();
      t0 = Date.now(); timer = setInterval(() => { const s = Math.floor((Date.now() - t0) / 1000); clock.textContent = `${Math.floor(s / 60)}:${pad(s % 60)}`; }, 250);
      while (queue.length) ws.send(queue.shift());
    } else if (m.type === 'partial') setSegText(m.seg, m.text, 'partial');
    else if (m.type === 'final') setSegText(m.seg, m.text, 'final');
    else if (m.type === 'clean') setSegText(m.seg, m.text, 'clean');
    else if (m.type === 'items') {
      if (phase === 'listening' || m.final) { items = m.items; renderCards(!!m.final); }
      if (m.final) {
        phase = 'done'; setStatus(items.length ? `听出 ${items.length} 件事` : '说完了', 'done');
        showFinalText(m.clean);
        renderFoot();
      }
    } else if (m.type === 'error') { setStatus(m.code === 'session-too-long' ? '一次最多说 60 秒' : '语音整理出了点问题，可以重新说', 'error'); }
  };
  ws.onerror = () => { if (phase !== 'done') { setStatus('连不上语音服务，可以直接打字', 'error'); phase = 'done'; renderFoot(); } };
  ws.onclose = () => { if (phase === 'thinking') { phase = 'done'; renderFoot(); } };

  return { close, stop };
}

function ensureStyles() {
  if (document.getElementById('v3-panel-css')) return;
  const link = document.createElement('link');
  link.id = 'v3-panel-css'; link.rel = 'stylesheet'; link.href = new URL('./v3-panel.css', import.meta.url).href;
  document.head.appendChild(link);
}
