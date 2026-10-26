// W12 现场感知提示词：CTO 实测版本的结构化 JSON 输出（seen/change/suggestion/actions，
// BUILD-PLAN §3 W12-3 / L143）。快感知只索要 seen（一句话即时卡）；深感知要四件套
// （相对计划的变化 + 具体建议 + 动作按钮，PRD §6.8.2/§6.8.3）。
// 提示词只约束语义与输出形状；容错解析在 vision.mjs（仿 voice-pipeline/llm.mjs:100）。
'use strict';

const JSON_ONLY = '只输出一个 JSON 对象，不要解释、不要 Markdown 代码块。';

/** 快感知用户提示词：一张（或多帧）画面 → 一句话「看到了什么」。 */
export function fastPrompt({ blockTitle, blockKind, nowText } = {}) {
  const ctx = [
    `当前日程块：「${blockTitle || '未命名'}」（类型 ${blockKind || 'unknown'}）`,
    nowText ? `现在时间：${nowText}` : null,
  ].filter(Boolean).join('；');
  return `你是「Done&Go」的快感知器。用户在日程进行中主动拍了一张现场照片，请看图回答。
${ctx}。

只输出一个 JSON 对象：
{"seen":"一句话：画面里实际看到了什么（≤40 字，具体、可读，如「隔板已涂胶，胶水溢出，未用夹具」）"}

规则：
- seen 只描述画面里亲眼可见的内容；不猜测、不建议、不推测原因（那些属于深感知）。
- 不描述人物外貌，不做身份推断（PRD §6.8.4）。
${JSON_ONLY}`;
}

/** 深感知用户提示词：画面 × 原计划 → 变化/风险 + 具体建议 + 动作按钮。 */
export function deepPrompt({ blockTitle, blockKind, planSummary, nowText } = {}) {
  const ctx = [
    `当前日程块：「${blockTitle || '未命名'}」（类型 ${blockKind || 'unknown'}）`,
    planSummary ? `原计划/预期：${planSummary}` : null,
    nowText ? `现在时间：${nowText}` : null,
  ].filter(Boolean).join('；');
  return `你是「Done&Go」的深感知器。用户在日程进行中主动拍了现场照片（或多帧视频截图），请对比计划分析。
${ctx}。

只输出一个 JSON 对象：
{"seen":"看到了什么（≤60 字，具体事实）","change":"相对计划/预期的变化与风险；没有变化填 null","suggestion":"一句话具体可执行的建议（带关键参数，如时长/数量/下一步）","actions":["动作按钮，每个 2-8 字，从 记下来/加待办/调整计划/设提醒/交给 agent 做 中按需选取，最多 3 个"]}

规则：
- seen/change 必须基于画面证据，不编造；change 为空时填 null，不要写「无变化」的句子。
- suggestion 要具体到能直接执行（例：「用湿布擦掉余胶，直尺检查水平，夹子固定 15 分钟」）。
- 不做医疗/伤病判断，不做人物身份推断（PRD §6.8.3/§6.8.4）。
${JSON_ONLY}`;
}
