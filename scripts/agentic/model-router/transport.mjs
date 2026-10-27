// W7 M5 · model-router-call — OpenAI-compatible transport（transport.mjs）
//
// 依据：.s2d/plan.md M5；brief 裁决④。
//   * key 只经注入（构造参数 apiKey；运行期由 gateway-key.mjs 供 W13 接线，
//     本流不读 env、不打印、不落盘任何 key —— 红线①/⑤）。
//   * fetch 必须注入：缺 fetch 直接构造失败，模块自身绝不引用全局 fetch，
//     因此不存在“忘注入而意外联网”的路径（测试全 mock，绝不联网）。
//   * 超时用 AbortController + 注入 timeoutMs；abort → UPSTREAM_UNAVAILABLE。
//   * 403/401 → FORBIDDEN（.status 保留）；429 → RATE_LIMITED；其余非 2xx →
//     UPSTREAM_UNAVAILABLE。错误结构化上抛不吞，message 只含状态码级别信息，
//     绝不携带 key / Authorization / 响应正文（可能含敏感数据）。
//   * 错误码全部落在冻结 api-error.schema.json 的 error.code 枚举内。
//
// 本模块属 G2（model-router），不 import G1 runtime/** 或 G3 tool-registry/**
// （plan.md：组间零源文件依赖，port 用结构化鸭子类型）。

const ERROR_CODES = new Set([
  'FORBIDDEN',
  'RATE_LIMITED',
  'UPSTREAM_UNAVAILABLE',
  'CONTRACT_INVALID',
]);

function fail(code, message, extra) {
  if (!ERROR_CODES.has(code)) {
    // 与 M1 errors.mjs 同一原则：非法码本身就是编程错误，立即失败，
    // 绝不静默降级成枚举外的码。
    throw new TypeError(`invalid transport error code ${String(code)}`);
  }
  const error = new Error(message);
  error.code = code;
  if (extra !== undefined) Object.assign(error, extra);
  return error;
}

function isFunction(value) {
  return typeof value === 'function';
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw fail('CONTRACT_INVALID', `${label} must be a non-empty string (got ${value === null ? 'null' : typeof value})`);
  }
  return value;
}

/** HTTP status → 结构化错误码（全部在冻结 api-error 枚举内）。 */
function codeForStatus(status) {
  if (status === 401 || status === 403) return 'FORBIDDEN';
  if (status === 429) return 'RATE_LIMITED';
  return 'UPSTREAM_UNAVAILABLE';
}

/**
 * createChatTransport({ baseUrl, apiKey, fetch, timeoutMs }) → { chat(payload) }
 *
 * - baseUrl：OpenAI-compatible 基址（如 https://host/v1）；尾斜杠会被归一，
 *   实际请求 POST `${baseUrl}/chat/completions`。
 * - apiKey：仅注入；只进入 Authorization: Bearer 头，不进日志、不进错误 message。
 * - fetch：必须注入（见上）。headers 用普通对象，便于调用方/测试断言。
 * - timeoutMs：正有限数；超时经 AbortSignal 触发，映射 UPSTREAM_UNAVAILABLE。
 */
export function createChatTransport(options = {}) {
  const { baseUrl, apiKey, fetch: fetchImpl, timeoutMs } = options ?? {};
  requireNonEmptyString(baseUrl, 'baseUrl');
  requireNonEmptyString(apiKey, 'apiKey');
  if (!isFunction(fetchImpl)) {
    throw fail(
      'CONTRACT_INVALID',
      `fetch must be injected (mock in tests; got ${fetchImpl === null ? 'null' : typeof fetchImpl}); this transport never falls back to the global fetch`,
    );
  }
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw fail('CONTRACT_INVALID', 'timeoutMs must be a positive finite number of milliseconds');
  }
  const base = baseUrl.replace(/\/+$/, '');

  async function chat(payload) {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw fail('CONTRACT_INVALID', `chat payload must be an object (got ${Array.isArray(payload) ? 'array' : typeof payload})`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (cause) {
      // 超时（AbortError）或注入 fetch 自身的网络错误：一律上游不可用。
      // message 不回显 cause 文本（可能携带 URL/凭据片段），只保留错误名。
      throw fail(
        'UPSTREAM_UNAVAILABLE',
        `chat/completions request failed (${cause?.name ?? 'unknown'}${controller.signal.aborted ? '; aborted by timeout' : ''})`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response || typeof response !== 'object') {
      throw fail('UPSTREAM_UNAVAILABLE', 'chat/completions returned a non-object response');
    }
    const status = Number(response.status);
    if (!(status >= 200 && status < 300)) {
      // 结构化上抛：码由状态映射，绝不解析/回显响应正文。
      throw fail(
        codeForStatus(status),
        `chat/completions upstream responded ${Number.isFinite(status) ? status : 'non-numeric'} status`,
        { status: Number.isFinite(status) ? status : undefined },
      );
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw fail('UPSTREAM_UNAVAILABLE', 'chat/completions 2xx response body was not valid JSON');
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw fail('UPSTREAM_UNAVAILABLE', 'chat/completions 2xx response body was not a JSON object');
    }
    return body;
  }

  return { chat };
}
