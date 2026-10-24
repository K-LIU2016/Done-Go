// Pure helpers for the AI "parse" mode (decision D3, frontend half).
//
// No DOM, no fetch, no storage: everything here is directly importable by
// `node --test`. The web/index.html integration owns the network round-trip,
// the consent/preview gate and the ruleParse fallback.
//
// Fallback contract: validateAndExtract() returns null for anything it cannot
// strictly trust (broken JSON, wrong field types, impossible times, dates the
// user never mentioned). Callers must then keep the ruleParse result;
// diffMerge(ruleResult, null) renders that fallback view and never claims an
// AI success.
//
// Mirrors of in-page conventions (web/index.html): item kind enum from KINDS,
// titles capped like ruleParse, '24:00' allowed as end of day, local-time
// date math like ymd/addDays.

export var PARSE_MODE = 'parse';
export var PARSE_KINDS = ['necessary', 'restore', 'create', 'connect', 'explore', 'stillness'];

var FIELD_KEYS = ['date', 'start', 'end', 'title', 'kind', 'prio'];
var TITLE_MAX = 30;
var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
var HM_RE = /^(2[0-4]|[01]?\d):([0-5]\d)$/;
// Longest-first alternation so 大后天 is not read as 后天.
var RELATIVE_DAYS = { '大后天': 3, '后天': 2, '明天': 1, '明晚': 1, '明早': 1, '次日': 1, '今天': 0, '今晚': 0, '当天': 0, '昨天': -1, '前天': -2 };
var RELATIVE_RE = /大后天|后天|前天|明天|明晚|明早|次日|今天|今晚|当天|昨天/g;
var WEEKDAYS = '日一二三四五六';
var WEEKDAY_RE = /(?:周|星期|礼拜)([日一二三四五六])/;
var ISO_DATE_RE = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/g;
var CN_DATE_RE = /(\d{1,2})月(\d{1,2})日/g;

function pad(n) { return (n < 10 ? '0' : '') + n; }
function asDate(now) { return now instanceof Date && !isNaN(now.getTime()) ? now : new Date(); }
function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }

function firstRuleItem(ruleResult) {
  if (Array.isArray(ruleResult)) return ruleResult[0] || null;
  return ruleResult && typeof ruleResult === 'object' ? ruleResult : null;
}

function isRealDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  var parts = value.split('-').map(Number), d = new Date(parts[0], parts[1] - 1, parts[2]);
  return parts[0] > 0 && d.getFullYear() === parts[0] && d.getMonth() === parts[1] - 1 && d.getDate() === parts[2];
}

// '22:00' or '9:30' → canonical zero-padded 'HH:MM'; '24:00' is a legal end of
// day, '24:01' and anything else are not. Returns null for invalid input.
function normalizeTime(value) {
  if (typeof value !== 'string') return null;
  var m = value.trim().match(HM_RE);
  if (!m) return null;
  if (+m[1] === 24 && m[2] !== '00') return null;
  return pad(+m[1]) + ':' + m[2];
}

// Extract the first balanced {...} block, skipping quoted strings. Tolerates
// <think>…</think> blocks, ```json fences and prose before/after the object.
// Anything else — arrays, scalars, truncated JSON — yields null.
function extractJSON(raw) {
  if (typeof raw !== 'string') return null;
  var text = raw.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```[a-zA-Z]*\s*/g, '').trim();
  var brace = text.indexOf('{'), bracket = text.indexOf('[');
  if (brace < 0 || (bracket >= 0 && bracket < brace)) return null;
  var depth = 0, inString = false, escaped = false;
  for (var i = brace; i < text.length; i++) {
    var ch = text.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(brace, i + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

// Dates the AI may pick: today (the implicit default), every date actually
// mentioned in the input, plus the rule engine's own date. Anything else is
// treated as a hallucinated date.
export function allowedDates(rawInput, ruleResult, now) {
  var base = startOfDay(asDate(now)), found = [ymd(base)], m;
  var text = String(rawInput == null ? '' : rawInput);
  RELATIVE_RE.lastIndex = 0;
  while ((m = RELATIVE_RE.exec(text))) found.push(ymd(addDays(base, RELATIVE_DAYS[m[0]])));
  var wd = text.match(WEEKDAY_RE);
  if (wd) found.push(ymd(addDays(base, (WEEKDAYS.indexOf(wd[1]) - base.getDay() + 7) % 7)));
  ISO_DATE_RE.lastIndex = 0;
  while ((m = ISO_DATE_RE.exec(text))) {
    var iso = m[1] + '-' + pad(+m[2]) + '-' + pad(+m[3]);
    if (isRealDate(iso)) found.push(iso);
  }
  CN_DATE_RE.lastIndex = 0;
  while ((m = CN_DATE_RE.exec(text))) {
    var cn = base.getFullYear() + '-' + pad(+m[1]) + '-' + pad(+m[2]);
    if (isRealDate(cn)) found.push(cn);
  }
  var item = firstRuleItem(ruleResult);
  if (item && isRealDate(item.date)) found.push(item.date);
  var seen = {};
  return found.filter(function (d) { if (seen[d]) return false; seen[d] = true; return true; }).sort();
}

// Build the POST /api/assistant/chat body for parse mode. The endpoint only
// accepts {prompt, mode, stream}, so the shape here is exactly that contract.
// The rule engine's start/end are deliberately NOT included: anchoring the
// model on the (possibly wrong) rule times defeats the purpose of parse mode.
export function buildParseRequest(rawInput, ruleResult, now) {
  var current = asDate(now), day = startOfDay(current), item = firstRuleItem(ruleResult);
  var input = String(rawInput == null ? '' : rawInput).slice(0, 600).replace(/[「」]/g, ' ');
  var prompt =
    '你是“探戈 Done&Go”的记录助手，把用户的一句话整理成一条时间记录。' +
    '今天是 ' + ymd(day) + '（星期' + WEEKDAYS.charAt(day.getDay()) + '），现在是 ' + pad(current.getHours()) + ':' + pad(current.getMinutes()) + '。\n' +
    '只输出一个 JSON 对象（不是数组、不要任何解释）：{"title":"简短名称，不含时间词","kind":"' + PARSE_KINDS.join('|') + '","date":"YYYY-MM-DD","start":"HH:MM 或 null","end":"HH:MM 或 null","prio":1到5的整数}\n' +
    'date 只能是今天或用户话里明确提到的日期（明天/明晚/后天/周几/几月几日），绝不要编造其他日期。' +
    '时段词（凌晨/上午/中午/下午/傍晚/晚上/夜里/今晚/明晚）必须换算成 24 小时制的具体时间；没提时间时 start 和 end 写 null；prio 没提就写 3。\n' +
    (item && typeof item.title === 'string' && item.title
      ? '本地规则引擎的初步识别（仅供参考）：名称「' + item.title.slice(0, TITLE_MAX).replace(/[「」]/g, ' ') + '」、类别 ' + String(item.kind) + '；时间请独立判断。\n'
      : '') +
    '用户的话：「' + input + '」';
  return { prompt: prompt, mode: PARSE_MODE, stream: false };
}

// Strictly validate the model reply against the parse contract. Returns the
// normalized {date,start,end,title,kind,prio} (start/end '' when the model
// reported null) or null — null always means "fall back to the rule result".
export function validateAndExtract(rawLlmText, rawInput, ruleResult, now) {
  var obj = extractJSON(rawLlmText);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (typeof obj.title !== 'string' || !obj.title.trim()) return null;
  if (typeof obj.kind !== 'string' || PARSE_KINDS.indexOf(obj.kind) < 0) return null;
  if (!isRealDate(obj.date)) return null;
  var start = obj.start == null ? '' : normalizeTime(obj.start);
  if (start === null) return null;
  var end = obj.end == null ? '' : normalizeTime(obj.end);
  if (end === null) return null;
  if (start && end && end < start) return null;
  var prio = obj.prio == null ? 3 : obj.prio;
  if (!Number.isInteger(prio) || prio < 1 || prio > 5) return null;
  if (allowedDates(rawInput, ruleResult, now).indexOf(obj.date) < 0) return null;
  var title = obj.title.trim().slice(0, TITLE_MAX);
  if (!title) return null;
  return { date: obj.date, start: start, end: end, title: title, kind: obj.kind, prio: prio };
}

// Field-by-field rule-vs-AI comparison for the diff sheet. aiParsed null (or
// anything that is not the validateAndExtract output) renders the fallback
// view: fallback true, adopt null, no field suggests adoption — the UI cannot
// present a fake AI success from this structure.
// Ruling 8: a field whose AI value is empty/missing can never be adopted
// (suggestAdopt false), so it is not a diff row at all — the sheet must never
// show a「10:00 →（空）」line that adoption could not apply anyway.
export function diffMerge(ruleResult, aiParsed) {
  var item = firstRuleItem(ruleResult);
  var rule = item
    ? { date: item.date || '', start: item.start || '', end: item.end || '', title: item.title || '', kind: item.kind || '', prio: typeof item.prio === 'number' ? item.prio : 3 }
    : null;
  var ai = aiParsed && typeof aiParsed === 'object' && !Array.isArray(aiParsed)
    ? { date: aiParsed.date, start: aiParsed.start || '', end: aiParsed.end || '', title: aiParsed.title || '', kind: aiParsed.kind, prio: typeof aiParsed.prio === 'number' ? aiParsed.prio : 3 }
    : null;
  var fields = FIELD_KEYS.map(function (key) {
    var ruleValue = rule ? rule[key] : null, aiValue = ai ? ai[key] : null;
    var differs = !!ai && ruleValue !== aiValue && aiValue !== '' && aiValue != null;
    return { key: key, ruleValue: ruleValue, aiValue: aiValue, differs: differs, suggestAdopt: differs && aiValue !== '' && aiValue != null };
  });
  return {
    fallback: !ai,
    hasDiff: fields.some(function (f) { return f.differs; }),
    fields: fields,
    adopt: ai ? { date: ai.date, start: ai.start, end: ai.end, title: ai.title, kind: ai.kind, prio: ai.prio } : null,
    ruleItem: item
  };
}

// One-call wrapper for the caller flow: validate the reply, then either keep
// the untouched rule item (source 'rule' — validation failed or timed out) or
// hand back the adoptable AI item plus its diff sheet (source 'ai').
export function resolveParse(rawLlmText, rawInput, ruleResult, now) {
  var ai = validateAndExtract(rawLlmText, rawInput, ruleResult, now);
  var diff = diffMerge(ruleResult, ai);
  return { source: ai ? 'ai' : 'rule', aiParsed: ai, diff: diff, item: ai ? diff.adopt : diff.ruleItem };
}
