// W11 media-gen · 生视频客户端（场景片，异步任务）。
// 依据：BUILD-PLAN §3 W11.1 + PRD §2.4（happyhorse-1.1-t2v 5 秒片段 ≈116s，异步）、
// §5.2 L3 场景片「后台生成，好了再提示，绝不阻塞签约」。
// 流程：POST /v1/videos 建任务 → 轮询 GET /v1/videos/{id}（可注入时钟 + 指数退避，
// 封顶 8× 间隔）→ 就绪后拉 GET /v1/videos/{id}/content 落盘。
// 超时（VIDEO_TIMEOUT）、失败（VIDEO_FAILED，带上游 error）、取消（VIDEO_CANCELLED，
// AbortSignal）三条路径都显式抛类型化错误；下载大小上限；key 只经
// scripts/agentic/gateway-key.mjs 运行时读取（BUILD-PLAN §2.3 红线2，W0 已合入）。
import { gatewayKey } from '../gateway-key.mjs';

export const DEFAULT_MAX_VIDEO_BYTES = 256 * 1024 * 1024;
export const DEFAULT_POLL_INTERVAL_MS = 5000;
export const DEFAULT_VIDEO_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BACKOFF_MULTIPLIER = 8;

function typedError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** 运行时解析网关 key：注入参数优先（测试 mock），缺省经 W0 冻结的唯一入口
 *  scripts/agentic/gateway-key.mjs 读 endpoint.json（BUILD-PLAN §2.3 红线2，env 不再是通道），
 *  缺失抛类型化错误（不含 key 值）。 */
function resolveGatewayKey(injected) {
  if (injected) return injected;
  try {
    return gatewayKey();
  } catch {
    throw typedError('GATEWAY_KEY_MISSING', '缺少网关 key：经 scripts/agentic/gateway-key.mjs 读取 ~/.config/llm-gateway/endpoint.json 的 keys.donego（BUILD-PLAN §2.3 红线2）');
  }
}

/**
 * 生视频客户端。fetch/now/sleep（时钟）/pollIntervalMs/timeoutMs/quota 全部可注入，
 * 测试绝不真实外呼、绝不真等。quota 可选：只在任务被网关受理后记账（POST 被拒不记）。
 */
export function createVideoClient({
  baseUrl,
  key,
  fetch: fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  timeoutMs = DEFAULT_VIDEO_TIMEOUT_MS,
  quota = null,
  cache = null,
  maxVideoBytes = DEFAULT_MAX_VIDEO_BYTES,
} = {}) {
  const authHeaders = gatewayKey => ({ 'content-type': 'application/json', authorization: 'Bearer ' + gatewayKey });

  /** 轮询直到 succeeded/failed/超时/取消。退避：间隔 ×2 逐次增长、封顶 8×，绝不忙轮询。 */
  async function pollUntilReady(id, gatewayKey, signal) {
    const start = now();
    for (let attempt = 0; ; attempt += 1) {
      if (signal?.aborted) throw typedError('VIDEO_CANCELLED', `视频任务 ${id} 已取消（AbortSignal）`);
      if (now() - start >= timeoutMs) {
        throw typedError('VIDEO_TIMEOUT', `视频任务 ${id} 超过 ${timeoutMs}ms 未就绪`);
      }
      const res = await fetchImpl(`${baseUrl}/v1/videos/${id}`, { method: 'GET', headers: authHeaders(gatewayKey) });
      if (!res.ok) throw typedError('http-' + res.status, `视频状态查询失败 http-${res.status}`);
      const body = await res.json();
      if (body?.status === 'succeeded') return;
      if (body?.status === 'failed') {
        throw typedError('VIDEO_FAILED', `视频任务 ${id} 失败：${body?.error ?? '上游未给出原因'}`);
      }
      const delay = pollIntervalMs * Math.min(2 ** attempt, MAX_BACKOFF_MULTIPLIER);
      await sleep(delay); // queued/running 等待后重试
    }
  }

  return {
    /**
     * 生成一段视频，返回 { videoId, model, bytes(Buffer), file? }。
     * signal 为 AbortSignal：abort 后以 VIDEO_CANCELLED 拒绝。
     */
    async generateVideo({ model, prompt, signal = null, missionId, version } = {}) {
      if (quota && !quota.check().ok) {
        const { used } = quota.check();
        throw typedError('QUOTA_EXCEEDED', `每日场景片配额已用尽：已用 ${used}（上限见 quota 配置）`);
      }
      const gatewayKey = resolveGatewayKey(key);

      const res = await fetchImpl(baseUrl + '/v1/videos', {
        method: 'POST',
        headers: authHeaders(gatewayKey),
        body: JSON.stringify({ model, prompt }),
      });
      if (!res.ok) throw typedError('http-' + res.status, `生视频网关错误 http-${res.status}`);
      const created = await res.json();
      const id = created?.id;
      if (!id) throw typedError('bad-shape', '生视频响应缺少任务 id（empty/bad-shape）');
      if (quota) quota.spend(); // 已被网关受理才记账；POST 被拒不记

      await pollUntilReady(id, gatewayKey, signal);

      const contentRes = await fetchImpl(`${baseUrl}/v1/videos/${id}/content`, { method: 'GET', headers: authHeaders(gatewayKey) });
      if (!contentRes.ok) throw typedError('http-' + contentRes.status, `视频内容拉取失败 http-${contentRes.status}`);
      const bytes = Buffer.from(await contentRes.arrayBuffer());
      if (bytes.length > maxVideoBytes) {
        throw typedError('DOWNLOAD_TOO_LARGE', `视频 ${bytes.length} 字节超过上限 ${maxVideoBytes}，已拒收`);
      }

      let file;
      if (cache && missionId != null && version != null) {
        ({ file } = cache.put(
          cache.key({ missionId, version, model, prompt }),
          bytes,
          { source: 'content', model, prompt, missionId, version, videoId: id },
        ));
      }
      return { videoId: id, model, bytes, ...(file ? { file } : {}) };
    },
  };
}
