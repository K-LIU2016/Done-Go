// W12 敏感画面快判（PRD §6.8.4 L516）：快感知文本里出现 证件/病历/银行卡/屏幕密码
// → 只走本地 minicpm-v 且默认不存原图。命中即 localOnly；多类命中按
// SENSITIVE_CATEGORIES 的固定优先级取第一类（screen-password 最高——密码一旦入云不可逆）。
// 纯关键词快判（零依赖、微秒级）；快模型输出本身已描述画面，扫其全部字符串字段即可。
'use strict';

export const SENSITIVE_CATEGORIES = ['screen-password', 'identity-document', 'bank-card', 'medical-record'];

// 顺序即优先级，与 SENSITIVE_CATEGORIES 一一对应。
const CATEGORY_PATTERNS = [
  [/密码|passcode|password/i, /屏幕|解锁|登录|输入框|便签|screen|login|unlock|prompt/i], // 屏幕密码：需要「密码 + 屏幕语境」双证据
  [/身份证|护照|驾驶证|驾照|港澳通行证|台胞证|identity\s*document|passport|driver'?s?\s*licen[cs]e/i],
  [/银行卡|信用卡|借记卡|储蓄卡|bank\s*card|credit\s*card|debit\s*card/i],
  [/病历|处方|诊断书|体检报告|挂号单|medical\s*record|prescription/i],
];
const CATEGORY_OF = new Map(CATEGORY_PATTERNS.map((p, i) => [i, SENSITIVE_CATEGORIES[i]]));

/** 递归收集对象/数组里的全部字符串（快感知结果 {seen,change,suggestion,actions[]} 整体可扫）。 */
function collectStrings(value, out) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value && typeof value === 'object') for (const k of Object.keys(value)) collectStrings(value[k], out);
  return out;
}

function hit(texts) {
  for (let i = 0; i < CATEGORY_PATTERNS.length; i++) {
    const [trigger, context] = CATEGORY_PATTERNS[i];
    if (!texts.some(t => trigger.test(t))) continue;
    if (!context) return CATEGORY_OF.get(i); // 无语境要求：命中即敏感
    if (texts.some(t => trigger.test(t) && context.test(t))) return CATEGORY_OF.get(i); // 同一条文本里主词+语境同现
  }
  return null;
}

/**
 * 快判输入是否敏感画面。input 可以是字符串或快感知结果对象（扫全部字符串字段）。
 * 返回 { sensitive, category, localOnly }；category 为 SENSITIVE_CATEGORIES 之一或 null。
 */
export function classifySensitive(input) {
  const texts = collectStrings(input, []);
  const category = texts.length ? hit(texts) : null;
  return category
    ? { sensitive: true, category, localOnly: true }
    : { sensitive: false, category: null, localOnly: false };
}
