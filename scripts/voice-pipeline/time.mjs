// 时间原话 → 日期/钟点（确定性规则，绝不让模型算日期：10-26 实测本地 4B 把「下周三」算成 10-29）。
// 复用 scripts/intent.mjs 的规则引擎：给时间原话接一个占位动作，取第一条事项的时间字段。
import { ruleDraft } from '../intent.mjs';

const EMPTY = Object.freeze({ date: null, start: null, end: null, deadline: null, recurrence: null, vague: false });

export function resolveTimeText(timeText, { now, tz = 'Asia/Shanghai' }) {
  const text = typeof timeText === 'string' ? timeText.trim() : '';
  if (!text) return { ...EMPTY };
  const draft = ruleDraft({ transcript: text + '开会', now, tz });
  const item = draft.ok ? draft.value.items?.[0] : null;
  if (!item) return { ...EMPTY };
  const out = {
    date: item.date ?? null,
    start: item.start ?? null,
    end: item.end ?? null,
    deadline: item.deadline ?? null,
    recurrence: item.recurrence ?? null,
    vague: item.vague === true,
  };
  // 只有钟点或时段、没有日期：语音面向当下，按今天（重复事项和截止不补日期）
  if (!out.date && !out.deadline && !out.recurrence && (out.start || out.vague)) out.date = now.slice(0, 10);
  return out;
}
