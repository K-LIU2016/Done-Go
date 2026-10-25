// web/relay/next-up.js — 首页「接下来的事」接缝。
//
// 数据只读自现有 tango-donego.web.v1 账本：不另建事项存储，兼容旧账本的
// entries/drafts 与 prio 字段。渲染保持纯函数可测，mountNextUp 只负责把结果
// 放进 I0 预留的 #relay-home-next 插槽。

const STORE_KEY = 'tango-donego.web.v1';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const VALID_KINDS = new Set(['necessary', 'create', 'connect', 'explore', 'restore', 'stillness']);

export const PRIORITY_META = Object.freeze({
  1: Object.freeze({ label: '最优先', color: '#C2412D', background: '#FCE8E3' }),
  2: Object.freeze({ label: '优先', color: '#C7701F', background: '#FDF0E1' }),
  3: Object.freeze({ label: '一般', color: '#5E6158', background: '#EFEEE8' }),
  4: Object.freeze({ label: '稍缓', color: '#4C7A93', background: '#E6EFF4' }),
  5: Object.freeze({ label: '不急', color: '#3E7B5B', background: '#E5F1EA' }),
});

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function safePriority(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 3;
}

function safeTime(value) {
  return typeof value === 'string' && (value === '' || TIME_RE.test(value)) ? value : '';
}

function safeDate(value) {
  return typeof value === 'string' && (value === '' || DATE_RE.test(value)) ? value : '';
}

export function normalizeNextTask(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const title = String(value.title == null ? '' : value.title).trim();
  if (!title) return null;
  const kind = VALID_KINDS.has(value.kind) ? value.kind : 'necessary';
  const id = String(value.id == null ? '' : value.id).trim();
  if (!id) return null;
  return {
    id,
    title: title.slice(0, 200),
    kind,
    date: safeDate(value.date),
    start: safeTime(value.start),
    end: safeTime(value.end),
    priority: safePriority(value.priority ?? value.prio),
    done: value.done === true,
  };
}

export function readAgendaTasks(storage, key = STORE_KEY) {
  if (!storage || typeof storage.getItem !== 'function') return [];
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const state = JSON.parse(raw);
    const values = [
      ...(Array.isArray(state?.entries) ? state.entries : []),
      ...(Array.isArray(state?.drafts) ? state.drafts : []),
    ];
    const seen = new Set();
    return values.map(normalizeNextTask).filter((task) => {
      if (!task || task.done || seen.has(task.id)) return false;
      seen.add(task.id);
      return true;
    });
  } catch {
    return [];
  }
}

function dateSortValue(date) {
  return DATE_RE.test(date) ? date : '9999-99-99';
}

function timeSortValue(time) {
  return TIME_RE.test(time) ? time : '99:99';
}

export function sortNextTasks(tasks) {
  return (Array.isArray(tasks) ? tasks : []).slice().sort((a, b) => {
    const pa = safePriority(a?.priority ?? a?.prio);
    const pb = safePriority(b?.priority ?? b?.prio);
    return pa - pb
      || dateSortValue(a?.date || '').localeCompare(dateSortValue(b?.date || ''))
      || timeSortValue(a?.start || '').localeCompare(timeSortValue(b?.start || ''))
      || String(a?.id || '').localeCompare(String(b?.id || ''));
  });
}

export function canHandoffToAI(task) {
  return !!task && task.done !== true && task.kind !== 'stillness' && String(task.title || '').trim().length > 0;
}

function shortDate(date, today = new Date()) {
  if (!DATE_RE.test(date)) return '时间待定';
  const ymd = (value) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  const todayText = ymd(today);
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (date === todayText) return '今天';
  if (date === ymd(tomorrow)) return '明天';
  const [, month, day] = date.split('-');
  return `${Number(month)}月${Number(day)}日`;
}

export function formatNextTaskTime(task, { today = new Date() } = {}) {
  const date = shortDate(task?.date || '', today);
  if (task?.start && task?.end) return `${date} ${task.start}–${task.end}`;
  if (task?.start) return `${date} ${task.start}`;
  return date;
}

export function nextUpStyles(doc = globalThis.document) {
  if (!doc || doc.getElementById('relay-next-up-styles')) return;
  const style = doc.createElement('style');
  style.id = 'relay-next-up-styles';
  style.textContent = `
.rv2 .next-up{margin-top:26px;padding:16px;background:var(--surface);border-radius:var(--r-lg);box-shadow:var(--shadow)}
.rv2 .next-up-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:4px}
.rv2 .next-up-head h2{font-size:18px;line-height:1.35}
.rv2 .next-up-head span{font-size:12px;color:var(--ink3);white-space:nowrap}
.rv2 .next-up-list{list-style:none;margin:0;padding:0}
.rv2 .next-up-item{display:flex;align-items:stretch;gap:11px;padding:12px 0;border-top:1px solid var(--line);min-height:64px}
.rv2 .next-up-item:first-child{border-top:0}
.rv2 .next-up-bar{width:4px;flex:none;border-radius:4px;background:var(--next-priority);align-self:stretch}
.rv2 .next-up-body{min-width:0;flex:1;display:flex;flex-direction:column;justify-content:center;gap:3px}
.rv2 .next-up-body strong{font-size:15px;line-height:1.45;overflow-wrap:anywhere}
.rv2 .next-up-body small{font-size:12px;color:var(--ink2);line-height:1.4}
.rv2 .next-up-ai{align-self:center;flex:none;min-height:40px;padding:0 12px;border-radius:10px;background:var(--ink);color:var(--bg);font-size:12.5px;font-weight:600;display:inline-flex;align-items:center;justify-content:center;white-space:nowrap}
.rv2 .next-up-ai:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
@media (max-width:420px){.rv2 .next-up{padding:14px}.rv2 .next-up-item{gap:9px}.rv2 .next-up-ai{padding:0 10px}}
`;
  doc.head.appendChild(style);
}

export function renderNextUp(tasks, { today = new Date(), limit = 8 } = {}) {
  const rows = sortNextTasks(tasks).map(normalizeNextTask).filter(Boolean).slice(0, Math.max(0, Number(limit) || 0));
  if (!rows.length) return '';
  const items = rows.map((task) => {
    const meta = PRIORITY_META[task.priority] || PRIORITY_META[3];
    const ai = canHandoffToAI(task)
      ? `<a class="next-up-ai" href="#/relay?event=${encodeURIComponent(task.title)}">交给 AI</a>`
      : '';
    return `<li class="next-up-item" data-priority="${task.priority}" style="--next-priority:${meta.color}">`
      + `<span class="next-up-bar" aria-hidden="true"></span>`
      + `<div class="next-up-body"><strong>${esc(task.title)}</strong>`
      + `<small>${esc(formatNextTaskTime(task, { today }))} · ${esc(meta.label)}</small></div>${ai}</li>`;
  }).join('');
  return `<div class="next-up" data-next-up><div class="next-up-head"><h2>接下来的事</h2><span>按优先级</span></div><ol class="next-up-list">${items}</ol></div>`;
}

export function mountNextUp(target, storage, options = {}) {
  if (!target) return [];
  const doc = target.ownerDocument || (typeof document !== 'undefined' ? document : null);
  nextUpStyles(doc);
  const tasks = Array.isArray(options.tasks) ? options.tasks.map(normalizeNextTask).filter(Boolean) : readAgendaTasks(storage, options.key || STORE_KEY);
  target.innerHTML = renderNextUp(tasks, options);
  return sortNextTasks(tasks);
}
