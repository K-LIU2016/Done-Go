// W11 media-gen · 桶文件：聚合导出生图/生视频客户端、缓存、每日配额，
// 供上层（serve 路由、冒烟 smoke）单点引用（BUILD-PLAN §3 W11.1）。
export {
  PURE_IMAGE_MODEL,
  TEXT_IMAGE_MODEL,
  DEFAULT_MAX_IMAGE_BYTES,
  chooseImageModel,
  buildImagePrompt,
  createImageClient,
} from './image-client.mjs';
export {
  DEFAULT_MAX_VIDEO_BYTES,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_VIDEO_TIMEOUT_MS,
  createVideoClient,
} from './video-client.mjs';
export { createMediaCache, normalizePrompt } from './cache.mjs';
export { createDailyQuota, DEFAULT_IMAGE_QUOTA, DEFAULT_VIDEO_QUOTA, shanghaiDayKey } from './quota.mjs';
