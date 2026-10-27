// W12 视觉客户端：OpenAI 兼容 chat/completions + image base64 content parts。
// 快路 qwen3.5-omni-flash（timeout≈4s，即时卡）/ 深路 qwen3-vl-plus（timeout≈15s，
// 同卡升级）；本地 minicpm-v 适配器端点可配（未提供→留桩拒绝）。BUILD-PLAN §3 W12-3。
// key 为可注入 getter（默认运行时读 env DONEGO_GATEWAY_KEY，W0 交付后切
// scripts/agentic/gateway-key.mjs）；绝不打印/落盘；错误一律不透明错误码，不带 key。
// 容错解析仿 voice-pipeline/llm.mjs:100（slice 首尾大括号）。
'use strict';

export const FAST_MODEL = 'qwen3.5-omni-flash';
export const DEEP_MODEL = 'qwen3-vl-plus';
export const LOCAL_MODEL = 'minicpm-v';
export const FAST_TIMEOUT_MS = 4000; // 预算 4s：目标即时卡 ≤2s + 网络余量
export const DEEP_TIMEOUT_MS = 15000; // 预算 15s：目标深建议 ≤8s + 长尾余量
const DEFAULT_BASE_URL = () => process.env.DONEGO_GATEWAY_URL || 'https://open.bigmodel.cn/api/paas/v4';
const defaultGatewayKey = () => process.env.DONEGO_GATEWAY_KEY;

const normalizeBase = u => String(u || '').replace(/\/+$/, '').replace(/\/chat\/completions$/, '');

/** 归一模型输出：四字段固定形状；actions 单字符串→数组，非字符串项丢弃。 */
function normalizePerception(parsed) {
  const str = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
  let actions = [];
  if (Array.isArray(parsed.actions)) actions = parsed.actions.filter(a => typeof a === 'string' && a.trim()).map(a => a.trim());
  else if (typeof parsed.actions === 'string' && parsed.actions.trim()) actions = [parsed.actions.trim()];
  return { seen: str(parsed.seen), change: str(parsed.change), suggestion: str(parsed.suggestion), actions };
}

/** 容错解析：剥掉围栏/前后闲话，取首个 `{` 到末个 `}` 的片段再 JSON.parse。 */
export function parsePerceptionJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('vision-bad-json: no JSON object in model output');
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error('vision-bad-json: ' + (e && e.message ? e.message : 'parse failed'));
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('vision-bad-json: not a JSON object');
  return normalizePerception(parsed);
}

/** 单次 chat/completions：超时（AbortController + race，注入的 fetchImpl 不理会 signal 也能掐断）、
 *  HTTP 非 2xx、空 content 都抛不透明错误码（vision-timeout / vision-http-<status> / vision-empty）。 */
async function chatCompletion({ fetchImpl, baseUrl, body, timeoutMs, headers = {} }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await Promise.race([
      fetchImpl(baseUrl + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: controller.signal }),
      new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('vision-timeout')), { once: true })),
    ]);
    if (!res.ok) throw new Error('vision-http-' + res.status); // 不读错误体：避免上游回显泄露
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error('vision-empty: model returned no content');
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

function buildMessages({ system, prompt, images }) {
  const msgs = [];
  if (system) msgs.push({ role: 'system', content: system });
  const parts = images.map(({ imageBase64, mimeType }) => ({ type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } }));
  parts.push({ type: 'text', text: prompt });
  msgs.push({ role: 'user', content: parts });
  return msgs;
}

function toImages(args) {
  if (Array.isArray(args.images) && args.images.length) return args.images;
  if (args.imageBase64) return [{ imageBase64: args.imageBase64, mimeType: args.mimeType || 'image/jpeg' }];
  throw new Error('vision-no-image: analyze needs imageBase64 or images[]');
}

/**
 * 通用视觉客户端。analyze({ imageBase64, mimeType, system, prompt, images }) →
 * { seen, change, suggestion, actions }；key 每次调用时经 getKey() 运行时读取。
 */
export function createVisionClient({ baseUrl, model, timeoutMs = DEEP_TIMEOUT_MS, maxTokens = 1024, getKey = defaultGatewayKey, fetchImpl = globalThis.fetch } = {}) {
  const base = normalizeBase(baseUrl ?? DEFAULT_BASE_URL());
  return {
    model,
    timeoutMs,
    async analyze(args = {}) {
      const images = toImages(args);
      const prompt = typeof args.prompt === 'string' ? args.prompt : '';
      const key = getKey(); // 运行时读取（不缓存），环境变了跟着变
      const text = await chatCompletion({
        fetchImpl,
        baseUrl: base,
        timeoutMs,
        headers: key ? { authorization: 'Bearer ' + key } : {},
        body: { model, temperature: 0, max_tokens: maxTokens, messages: buildMessages({ system: args.system, prompt, images }) },
      });
      return parsePerceptionJson(text);
    },
  };
}

/** 快感知：qwen3.5-omni-flash，预算 4s（即时卡）。 */
export function createFastVisionClient({ baseUrl, getKey = defaultGatewayKey, fetchImpl = globalThis.fetch, maxTokens = 512 } = {}) {
  return createVisionClient({ baseUrl, model: FAST_MODEL, timeoutMs: FAST_TIMEOUT_MS, maxTokens, getKey, fetchImpl });
}

/** 深感知：qwen3-vl-plus，预算 15s（同卡升级）。 */
export function createDeepVisionClient({ baseUrl, getKey = defaultGatewayKey, fetchImpl = globalThis.fetch, maxTokens = 2048 } = {}) {
  return createVisionClient({ baseUrl, model: DEEP_MODEL, timeoutMs: DEEP_TIMEOUT_MS, maxTokens, getKey, fetchImpl });
}

/**
 * 本地 minicpm-v 适配器（敏感画面只走本地，PRD §6.8.4）。端点未提供 → 留桩：analyze 直接拒绝；
 * 配了 OpenAI 兼容 URL 则照发（model 固定 minicpm-v，无鉴权头——本地服务）。
 */
export function createLocalVisionAdapter({ url, timeoutMs = 30000, fetchImpl = globalThis.fetch } = {}) {
  const base = url ? normalizeBase(url) : null;
  return {
    model: LOCAL_MODEL,
    localOnly: true,
    configured: !!base,
    async analyze(args = {}) {
      if (!base) throw new Error('local vision endpoint not configured (minicpm-v)');
      const images = toImages(args);
      const prompt = typeof args.prompt === 'string' ? args.prompt : '';
      const text = await chatCompletion({
        fetchImpl,
        baseUrl: base,
        timeoutMs,
        body: { model: LOCAL_MODEL, temperature: 0, max_tokens: 1024, messages: buildMessages({ system: args.system, prompt, images }) },
      });
      return parsePerceptionJson(text);
    },
  };
}
