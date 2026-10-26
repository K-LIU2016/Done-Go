// W11 media-gen · 生图客户端（经 JC 的 LiteLLM 网关）。
// 依据：BUILD-PLAN §3 W11.1 + PRD §2.4 实测结论：z-image-turbo 快但中文要点出错字 →
// 只出纯画面、文字由代码排版；qwen-image-2.0 中文排版准确 → 图中需要文字时用。
// PRD §10.3 字段约束：纯画面 prompt 必须声明「不要出现任何文字」。
// 响应 url 与 b64_json 两种都支持并落本地缓存；按 Mission 版本缓存；每日配额。
// 安全：远程 URL 只允许网关域（allowlist）、下载大小上限、key 只经 env DONEGO_GATEWAY_KEY
// 运行时读取（W0 交付后换 scripts/agentic/gateway-key.mjs）、绝不打印/落盘。
// 风格：注入 fetch、Bearer 头、类型化错误（照 scripts/voice-pipeline/llm.mjs:51-99）。
export const PURE_IMAGE_MODEL = 'z-image-turbo';
export const TEXT_IMAGE_MODEL = 'qwen-image-2.0';

const NO_TEXT_DECLARATION = '不要出现任何文字';
export const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** 模型选择（PRD §2.4）：图中要文字 → qwen-image-2.0；缺省纯画面 → z-image-turbo。 */
export function chooseImageModel({ textInImage } = {}) {
  return textInImage ? TEXT_IMAGE_MODEL : PURE_IMAGE_MODEL;
}

/**
 * prompt 构造器：纯画面模式强制声明「不要出现任何文字」（z-image-turbo 会把中文写错，
 * 所以画面里不许出现文字，文字全部由代码排版叠加）；图中文字模式原样返回，不加声明。
 */
export function buildImagePrompt({ prompt, textInImage } = {}) {
  const raw = String(prompt ?? '');
  if (textInImage) return raw;
  return raw.includes(NO_TEXT_DECLARATION) ? raw : `${raw}，${NO_TEXT_DECLARATION}`;
}

function typedError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** 运行时解析网关 key：只从注入参数或 env DONEGO_GATEWAY_KEY 读，缺失抛类型化错误。 */
function resolveGatewayKey(injected) {
  const key = injected ?? process.env.DONEGO_GATEWAY_KEY;
  if (!key) throw typedError('GATEWAY_KEY_MISSING', '缺少网关 key：请设置 DONEGO_GATEWAY_KEY（W0 后经 gateway-key.mjs 运行时读取）');
  return key;
}

/**
 * 生图客户端。fetch/cache/quota/allowDomains/maxImageBytes 全部可注入（测试 mock，
 * 绝不真实外呼）。allowDomains 缺省只信任 baseUrl 自己的域名。
 */
export function createImageClient({
  baseUrl,
  key,
  fetch: fetchImpl = globalThis.fetch,
  cache,
  quota,
  allowDomains,
  maxImageBytes = DEFAULT_MAX_IMAGE_BYTES,
} = {}) {
  const gatewayHost = new URL(baseUrl).hostname;
  const allowed = new Set(allowDomains ?? [gatewayHost]);

  async function downloadFrom(urlString) {
    let parsed;
    try { parsed = new URL(urlString); } catch { throw typedError('BAD_IMAGE_URL', `网关返回的图片地址不合法`); }
    if (!allowed.has(parsed.hostname)) {
      throw typedError('DISALLOWED_HOST', `拒绝下载非网关域名的图片：${parsed.hostname}`);
    }
    const res = await fetchImpl(urlString, { method: 'GET' });
    if (!res.ok) throw typedError('http-' + res.status, `图片下载失败 http-${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > maxImageBytes) {
      throw typedError('DOWNLOAD_TOO_LARGE', `图片 ${bytes.length} 字节超过上限 ${maxImageBytes}，已拒收`);
    }
    return bytes;
  }

  return {
    /**
     * 生成一张图（同一 Mission 版本+模型+prompt 命中缓存则零网络、零配额）。
     * 返回 { model, source: 'b64'|'url'|'cache', bytes(字节数), file(本地缓存路径), cached }。
     */
    async generateImage({ missionId, version, prompt, textInImage = false } = {}) {
      const model = chooseImageModel({ textInImage });
      const finalPrompt = buildImagePrompt({ prompt, textInImage });
      const cacheKey = cache.key({ missionId, version, model, prompt: finalPrompt });

      const hit = cache.get(cacheKey);
      if (hit) {
        return { model, source: hit.meta.source ?? 'cache', bytes: hit.bytes.length, file: hit.file, cached: true };
      }

      if (quota && !quota.check().ok) {
        const { used } = quota.check();
        throw typedError('QUOTA_EXCEEDED', `每日生图配额已用尽：已用 ${used}（上限见 quota 配置）`);
      }
      const gatewayKey = resolveGatewayKey(key);

      const res = await fetchImpl(baseUrl + '/v1/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + gatewayKey },
        body: JSON.stringify({ model, prompt: finalPrompt }),
      });
      if (!res.ok) throw typedError('http-' + res.status, `生图网关错误 http-${res.status}`);
      const data = await res.json();

      const item = data?.data?.[0] ?? {};
      let bytes;
      let source;
      if (typeof item.b64_json === 'string' && item.b64_json.length > 0) {
        bytes = Buffer.from(item.b64_json, 'base64');
        source = 'b64';
      } else if (typeof item.url === 'string' && item.url.length > 0) {
        bytes = await downloadFrom(item.url);
        source = 'url';
      } else {
        throw typedError('bad-shape', '生图响应里既没有 url 也没有 b64_json（empty/bad-shape）');
      }
      if (bytes.length > maxImageBytes) {
        throw typedError('DOWNLOAD_TOO_LARGE', `图片 ${bytes.length} 字节超过上限 ${maxImageBytes}，已拒收且不入缓存`);
      }

      const { file } = cache.put(cacheKey, bytes, { source, model, prompt: finalPrompt, missionId, version });
      if (quota) quota.spend();
      return { model, source, bytes: bytes.length, file, cached: false };
    },
  };
}
