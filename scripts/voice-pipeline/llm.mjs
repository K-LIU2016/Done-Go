// ⑤ 即时整理（本地小模型，超时退回规则顺滑）与 ⑥ 结构化（云端快模型，超时退回规则稿）。
// 日期一律由 time.mjs 规则解析，模型只给「时间原话」。依据：design/voice-pipeline/SPEC.md §1.2。
import { ruleClean } from './clean.mjs';
import { resolveTimeText } from './time.mjs';
import { ruleDraft } from '../intent.mjs';

const LOCAL_URL = () => process.env.TANGO_VOICE_LOCAL_LLM_URL || 'http://127.0.0.1:8090/v1';
const CLOUD_URL = () => (process.env.TANGO_AI_URL || 'http://127.0.0.1:4000/v1/chat/completions').replace(/\/chat\/completions$/, '');
const CLOUD_MODEL = () => process.env.TANGO_VOICE_STRUCT_MODEL || 'deepseek-v4.1-flash-fast';

export const CLEAN_SYSTEM = `把语音输入整理成通顺的书面中文。输入是同一句话的两路识别 A、B（可能有近音错字）。
对照两路和上下文还原原意；去掉语气词（嗯啊呃、那个、就是、然后呢、我想想）和重复；改口以最后说的为准；补全标点；不增删事实。只输出整理后的文字。`;

export function structSystem(now) {
  return `你是语音输入整理器。输入是用户一段话的两路语音识别结果 A、B（都可能有错：近音字、语气词、重复、改口）。
现在是 ${now}（Asia/Shanghai）。只输出一个 JSON 对象：
{"clean":"整理后的书面文字","items":[{"title":"动宾短语，≤12字","timeText":"原话里的时间说法，如「下周三下午两点到四点」「周五前」「每天早上七点」，没有填 null","remind":"提醒说明或 null","priority":1到5的整数（3=一般，1=最重要）}]}
规则：
1. 对照 A、B 和上下文还原用户真正说的话：不一致时取语义通顺、符合日程场景的那个（如「论文初稿」不是「书稿」，「看大纲」不是「药膏」）。
2. clean：去掉语气词（嗯、啊、呃、那个、就是、然后呢、我想想）和重复；改口以最后说的为准（「三点，不对，四点」→四点）；补全标点；不增删事实。
3. items：只收要做的事；寒暄、感想、天气不成项；一句多事就拆多项；「提前十分钟上线」「记得带材料」是所属事项的 remind，不单独成项。
4. timeText 照抄原话（改口取最后的），不要自己换算日期。说「很重要/一定要/必须」的 priority 取 1 或 2，否则 3。`;
}

async function chat(fetchImpl, url, body, { timeoutMs, headers = {} }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await Promise.race([
      fetchImpl(url + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: controller.signal }),
      new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true })),
    ]);
    if (!res.ok) throw new Error('http-' + res.status);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error('empty');
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

const hypotheses = ({ a, b }) => (b && b !== a ? `A：${a}\nB：${b}` : `A：${a}`);

/** ⑤ 单句即时整理：本地模型 ≤ timeoutMs，否则规则顺滑。 */
export async function cleanSegment({ a, b }, { fetch: fetchImpl = globalThis.fetch, timeoutMs = 2500 } = {}) {
  const fallback = { text: ruleClean(a || b || ''), source: 'rule' };
  if (!a && !b) return fallback;
  try {
    const text = await chat(fetchImpl, LOCAL_URL(), { model: 'local', temperature: 0, max_tokens: 160, chat_template_kwargs: { enable_thinking: false }, messages: [{ role: 'system', content: CLEAN_SYSTEM }, { role: 'user', content: hypotheses({ a, b }) }] }, { timeoutMs });
    return text ? { text, source: 'local' } : fallback;
  } catch {
    return fallback;
  }
}

const FILLER_TITLE = /^(?:嗯+|呃+|啊+|哦+|那个|就是|然后|好的?|对了)$/;
const clampPriority = p => (Number.isInteger(p) && p >= 1 && p <= 5 ? p : 3);

function finishItem(raw, now) {
  const title = typeof raw?.title === 'string' ? raw.title.trim().slice(0, 24) : '';
  if (!title || FILLER_TITLE.test(title)) return null;
  const timeText = typeof raw.timeText === 'string' && raw.timeText.trim() ? raw.timeText.trim() : null;
  return { title, timeText, ...resolveTimeText(timeText, { now }), remind: typeof raw.remind === 'string' && raw.remind.trim() ? raw.remind.trim() : null, priority: clampPriority(raw.priority) };
}

/** 说完瞬间的规则卡片（云端结果到达前先显示）。 */
export function ruleItems(text, now) {
  const draft = ruleDraft({ transcript: text || '', now, tz: 'Asia/Shanghai' });
  if (!draft.ok || !draft.value?.items) return [];
  return draft.value.items.map(i => ({ title: i.title, timeText: i.timeText ?? null, date: i.date ?? null, start: i.start ?? null, end: i.end ?? null, deadline: i.deadline ?? null, recurrence: i.recurrence ?? null, vague: !!i.vague, remind: null, priority: clampPriority(i.priority) }));
}

/** ⑥ 整段（到目前为止）结构化：云端快模型 ≤ timeoutMs，否则规则稿。 */
export async function structureUtterance({ a, b }, { fetch: fetchImpl = globalThis.fetch, now, timeoutMs = 12000, key = process.env.TANGO_AI_KEY } = {}) {
  const fallbackText = ruleClean(a || b || '');
  const fallback = () => ({ clean: fallbackText, items: ruleItems(fallbackText, now), source: 'rule' });
  if (!a && !b) return { clean: '', items: [], source: 'rule' };
  try {
    const text = await chat(fetchImpl, CLOUD_URL(), { model: CLOUD_MODEL(), temperature: 0, max_tokens: 700, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: structSystem(now) }, { role: 'user', content: hypotheses({ a, b }) }] }, { timeoutMs, headers: key ? { authorization: 'Bearer ' + key } : {} });
    const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    if (!parsed || !Array.isArray(parsed.items)) return fallback();
    return { clean: typeof parsed.clean === 'string' && parsed.clean.trim() ? parsed.clean.trim() : fallbackText, items: parsed.items.map(x => finishItem(x, now)).filter(Boolean), source: 'cloud' };
  } catch {
    return fallback();
  }
}
