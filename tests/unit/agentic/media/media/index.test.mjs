// W11 media-gen · 桶文件 index.mjs 先行单测：聚合导出齐全，供上层（serve 路由/冒烟）单点引用。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createImageClient,
  createVideoClient,
  createMediaCache,
  createDailyQuota,
  chooseImageModel,
  buildImagePrompt,
  normalizePrompt,
  DEFAULT_IMAGE_QUOTA,
  DEFAULT_VIDEO_QUOTA,
  PURE_IMAGE_MODEL,
  TEXT_IMAGE_MODEL,
} from '../../../../../scripts/agentic/media/index.mjs';

test('scripts/agentic/media/index.mjs re-exports the full media toolkit', () => {
  for (const fn of [createImageClient, createVideoClient, createMediaCache, createDailyQuota, chooseImageModel, buildImagePrompt, normalizePrompt]) {
    assert.equal(typeof fn, 'function', fn?.name + ' 必须是可调用导出');
  }
  assert.equal(typeof DEFAULT_IMAGE_QUOTA, 'number');
  assert.equal(typeof DEFAULT_VIDEO_QUOTA, 'number');
  assert.equal(PURE_IMAGE_MODEL, 'z-image-turbo');
  assert.equal(TEXT_IMAGE_MODEL, 'qwen-image-2.0');
});
