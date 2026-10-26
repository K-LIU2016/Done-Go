// 时间线解析：模型只给语义（日子词、钟点原话、接在谁后面、隔多久、持续多久），具体日期和钟点全由这里确定性推算。
// 依据：模型算日期/钟点不可靠（10-26 实测 4B 把「下周三」算成 10-29）；口述一天安排时「接下来两小时」「之后四小时」要按顺序累加。
import { resolveTimeText } from './time.mjs';

const FILLER_TITLE = /^(?:嗯+|呃+|啊+|哦+|那个|就是|然后|好的?|对了)$/;
const DAY_END = 23 * 60 + 59;
const DEFAULT_SPAN = 60; // 只有开始钟点的事，接续时按一小时算（与 Kira 记录的默认时长一致）
const DAY = 24 * 60;

const str = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
const mins = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; };
const toMin = hm => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
const toHm = t => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
// 「周五下班前」规则引擎只认出日子（date），那就把那天当截止日
const deadlineOf = (text, now) => { const r = resolveTimeText(text.replace(/(?:之前|以前|前)$/, '') + '前', { now }); return r.deadline ?? r.date; };
const addDays = (date, n) => { const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// 绝对分钟（可超过一天）→ 落到哪天几点：过了午夜就顺延到第二天，不堆在 23:59
const norm = (date, min) => ({ date: addDays(date, Math.floor(min / DAY)), min: ((min % DAY) + DAY) % DAY });
export const clampPriority = p => (Number.isInteger(p) && p >= 1 && p <= 5 ? p : 3);

/**
 * @param {Array<{title,day?,clock?,anchor?:'prev'|'now',gapMin?,durationMin?,daypart?,deadline?,repeat?,remind?,priority?}>} raw 模型给的事项（按说话顺序）
 * @param {{now:string}} opts now 为带时区的 ISO（+08:00）
 * @returns {Array<{title,timeText,date,start,end,deadline,recurrence,vague,remind,priority}>}
 */
export function resolveTimeline(raw, { now }) {
  const today = now.slice(0, 10);
  const nowMin = Math.ceil(toMin(now.slice(11, 16)) / 5) * 5;
  let cursor = null; // 上一件有钟点的事结束于 { date, min }（已按午夜顺延）
  const out = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    const title = str(r?.title)?.slice(0, 24);
    if (!title || FILLER_TITLE.test(title)) continue;
    const day = str(r.day), clock = str(r.clock), daypart = str(r.daypart), repeat = str(r.repeat), deadlineText = str(r.deadline);
    const base = resolveTimeText([day, repeat, clock || daypart].filter(Boolean).join(''), { now });
    const item = {
      title,
      timeText: [day, repeat, clock || daypart].filter(Boolean).join(' ') || null,
      date: repeat ? null : base.date ?? (day ? resolveTimeText(day, { now }).date : null),
      start: base.start, end: base.end,
      deadline: deadlineText ? deadlineOf(deadlineText, now) : null,
      recurrence: repeat ? base.recurrence ?? repeat : null,
      vague: !base.start && !!daypart,
      remind: str(r.remind),
      priority: clampPriority(r.priority),
    };
    if (item.deadline && !day && !clock) item.date = null;
    const dur = mins(r.durationMin);
    if (!clock && !repeat) chain(item, r, day);
    let endAbs = item.start && !item.end && dur ? toMin(item.start) + dur : null;
    if (endAbs != null) item.end = toHm(Math.min(DAY_END, endAbs)); // 卡片本身不跨天，接续的下一件照常顺延
    if (item.vague) item.timeText = daypart;
    if (item.start && item.date) {
      const s0 = toMin(item.start), e0 = item.end ? toMin(item.end) : null;
      endAbs ??= e0 == null ? s0 + DEFAULT_SPAN : e0 < s0 ? e0 + DAY : e0; // 「晚上十点到凌晨一点」结束在第二天
      cursor = norm(item.date, endAbs);
    }
    out.push(item);
  }
  return out;

  function chain(item, r, day) {
    let p = null;
    if (r.anchor === 'prev' && cursor && (!day || item.date === cursor.date)) p = norm(cursor.date, cursor.min + mins(r.gapMin));
    else if (r.anchor === 'now' && (!day || item.date === today)) p = norm(today, nowMin + mins(r.gapMin));
    if (!p) return;
    item.date = p.date;
    item.start = toHm(p.min);
    item.vague = false;
  }
}
