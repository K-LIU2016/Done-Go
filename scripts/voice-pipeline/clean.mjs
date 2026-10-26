// ④ 规则顺滑（0ms）：定稿一上屏先去掉确定的语气词与叠词；保守，拿不准的留给即时整理（本地模型）。
// 改口（"三点，啊不是，四点"）不在这里处理——需要语义，交给模型。
const FILLER_UNIT = '(?:嗯+|呃+|额+|啊+|哦+|唔+|那个|就是说?|然后呢?|我想想啊?|怎么说呢?)';
const FILLER_CLAUSE = new RegExp('^(?:' + FILLER_UNIT + '\\s*)+$'); // 整个小句只由语气词组成：「然后嗯」「那个那个」
const LEAD_FILLER = /^(?:(?:嗯+|呃+|额+|唔+)\s+|然后呢\s*|就是那个\s*|那个(?:那个)+\s*)+/; // 小句开头可安全去掉的（嗯后须有空格，免伤「嗯哼」）
const LEAD_NAGE_TIME = /^那个\s*(?=大?后天|今天|明天|今晚|明晚|[上下中]午|晚上|早上|[这下]?周|星期|下下?周|[这下]个?月|每[天周日月])/; // 「那个明天下午…」
const INNER_FILLER = /([^\s])(?:呃+|额+)(?=[^\s])/g; // 词中间插的「呃」：「下午呃三点」→「下午三点」
const LEAD_OH = /^哦(?=对了)/;

export function ruleClean(text) {
  if (typeof text !== 'string') return '';
  // 按标点切小句，保留标点
  const parts = text.replace(/\s+/g, ' ').trim().split(/([，,。！？!?；;])/);
  const out = [];
  for (let i = 0; i < parts.length; i += 2) {
    let clause = (parts[i] || '').trim();
    const punct = parts[i + 1] || '';
    clause = clause.replace(LEAD_OH, '').replace(LEAD_FILLER, '').replace(LEAD_NAGE_TIME, '').replace(INNER_FILLER, '$1').trim();
    clause = clause.replace(/^(\p{Script=Han}{2,4})\1/u, '$1'); // 叠词：今天今天 → 今天
    if (!clause || FILLER_CLAUSE.test(clause)) continue;
    // 「今天，今天要…」：与上一小句完全相同的开头词合并
    const prev = out[out.length - 1];
    if (prev && /[，,]$/.test(prev) && clause.startsWith(prev.slice(0, -1)) && prev.length > 1) out.pop();
    out.push(clause + punct);
  }
  let s = out.join('').replace(/^[，,。；;\s]+/, '').replace(/[，,]{2,}/g, '，');
  if (/[，,；;]$/.test(s)) s = s.slice(0, -1);
  // 只剩标点与「然后」等连接词时视为空
  return /^[\s，,。！？!?；;]*$/.test(s) ? '' : s;
}
