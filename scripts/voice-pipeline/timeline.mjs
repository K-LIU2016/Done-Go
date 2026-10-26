// 时间线解析：模型只给语义（日子词、钟点原话、接在谁后面、隔多久、持续多久），具体日期和钟点全由这里确定性推算。
// 依据：模型算日期/钟点不可靠（10-26 实测 4B 把「下周三」算成 10-29）；口述一天安排时「接下来两小时」「之后四小时」要按顺序累加。
import { resolveTimeText } from './time.mjs';

const FILLER_TITLE = /^(?:嗯+|呃+|啊+|哦+|那个|就是|然后|好的?|对了)$/;
const DAY_END = 23 * 60 + 59;
const DEFAULT_SPAN = 60; // 只有开始钟点的事，接续时按一小时算（与 Kira 记录的默认时长一致）

const str = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
const mins = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; };
const toMin = hm => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
const toHm = t => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
// 「周五下班前」规则引擎只认出日子（date），那就把那天当截止日
const deadlineOf = (text, now) => { const r = resolveTimeText(text.replace(/(?:之前|以前|前)$/, '') + '前', { now }); return r.deadline ?? r.date; };
export const clampPriority = p => (Number.isInteger(p) && p >= 1 && p <= 5 ? p : 3);

/**
 * @param {Array<{title,day?,clock?,anchor?:'prev'|'now',gapMin?,durationMin?,daypart?,deadline?,repeat?,remind?,priority?}>} raw 模型给的事项（按说话顺序）
 * @param {{now:string}} opts now 为带时区的 ISO（+08:00）
 * @returns {Array<{title,timeText,date,start,end,deadline,recurrence,vague,remind,priority}>}
 */
export function resolveTimeline(raw, { now }) {
  const today = now.slice(0, 10);
  const nowMin = Math.ceil(toMin(now.slice(11, 16)) / 5) * 5;
  let cursor = null; // 上一件有钟点的事结束于 { date, min }
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
    if (!clock && !repeat) chain(item, r);
    const dur = mins(r.durationMin);
    if (item.start && !item.end && dur) item.end = toHm(Math.min(DAY_END, toMin(item.start) + dur));
    if (item.vague) item.timeText = daypart;
    if (item.start && item.date) cursor = { date: item.date, min: item.end ? toMin(item.end) : Math.min(DAY_END, toMin(item.start) + DEFAULT_SPAN) };
    out.push(item);
  }
  return out;

  function chain(item, r) {
    let at = null;
    if (r.anchor === 'prev' && cursor && (!item.date || item.date === cursor.date)) { item.date = cursor.date; at = cursor.min; }
    else if (r.anchor === 'now' && (!item.date || item.date === today)) { item.date = today; at = nowMin; }
    if (at == null) return;
    item.start = toHm(Math.min(DAY_END, at + mins(r.gapMin)));
    item.vague = false;
  }
}
