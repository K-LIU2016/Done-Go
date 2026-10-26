// W12 现场感知 · 编排管线（PRD §6.8.2 L485-499、BUILD-PLAN §3 W12-2/3 与 L146、prototype
// capcard L383-391）。依赖 Group1 全部模块，一切可注入（假 clock/假模型测双路时序）：
//   归属 attributeCapture（同步，供 POST 202 立即回体）
//   → 快感知 fast（一句话即时卡，emit card.created）
//   → 敏感判定 classifySensitive（命中 → 云端深路绝不调用，仅本地 local 路径 + 默认不存原图）
//   → 深感知 deep（同 captureId 原地升级，emit card.upgraded，含 ContextDelta 与建议卡）
//   → 深失败/超时 → emit card.deep_failed + 快卡保留。
// 视频 = 抽帧帧集合一次深感知：≤30s（MAX_SYNC_VIDEO_SEC）同步走完双路，更长 emit card.pending
// 交后台（PRD L497-499）；音轨 handoffAudio 留桩透传语音管线（BUILD-PLAN L144）。
// done 永不 reject（emit 桥接 SSE、调用方不 await，未处理拒绝会炸进程）：任何一步抛错都
// 收敛成 {status:'error'|'deep-failed'|...} + card.* 事件。
'use strict';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { attributeCapture } from './attribution.mjs';
import { classifySensitive } from './sensitive.mjs';
import { extractFrames as extractFramesImpl } from './frames.mjs';
import { createFastVisionClient, createDeepVisionClient, createLocalVisionAdapter } from './vision.mjs';
import { fastPrompt, deepPrompt } from './prompts.mjs';
import { buildContextDelta, buildSuggestionCard } from './context-delta.mjs';

export const MAX_SYNC_VIDEO_SEC = 30; // PRD L497：≤30 秒的视频同步处理，更长的后台处理

const MIME_BY_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const mimeOf = (path, fallback = 'image/jpeg') => {
  const i = String(path ?? '').lastIndexOf('.');
  return MIME_BY_EXT[String(path).toLowerCase().slice(i)] || fallback;
};

/**
 * 默认图片加载：{path, mimeType} → {imageBase64, mimeType}（vision.mjs content part 形状）。
 * 文件读不到（单测假件路径 / 帧已被清理）不炸管线：引用原样透传交注入客户端处置——
 * 真客户端会把坏引用报成上游错误（收敛为 card.deep_failed），假件只看 images 数量。
 */
const defaultReadImage = async entry => {
  const mimeType = entry.mimeType || mimeOf(entry.path);
  try {
    return { imageBase64: (await readFile(entry.path)).toString('base64'), mimeType };
  } catch {
    return { path: entry.path, mimeType };
  }
};

const errText = err => String((err && err.message) || err);
const elapsed = (clock, from) => Math.max(0, clock.now() - from);
const safeRun = async fn => { if (typeof fn === 'function') { try { await fn(); } catch { /* 尽力而为 */ } } };

/**
 * 建编排器。全部依赖注入；缺省用 Group1 真件（vision 客户端惰性取 env key，不在构造期 IO）。
 * @param {object} deps
 * @param {{model:string,analyze:Function}} [deps.fast] 快感知客户端（默认 qwen3.5-omni-flash）
 * @param {{model:string,analyze:Function}} [deps.deep] 深感知客户端（默认 qwen3-vl-plus）
 * @param {{model:string,configured:boolean,analyze:Function}} [deps.local] 本地 minicpm-v 适配器
 *   （敏感命中才用；未配置 configured:false → 只标记 localOnly 不升级，PRD §6.8.4 L516）
 * @param {Function} [deps.classifySensitive] 敏感快判（默认 sensitive.mjs，扫快感知结果文本）
 * @param {Function} [deps.attribute] 归属（默认 attribution.mjs）
 * @param {Function} [deps.extractFrames] 视频抽帧（默认 frames.mjs）
 * @param {Function|null} [deps.handoffAudio] 音轨留桩，透传 extractFrames
 * @param {{now:Function}} [deps.clock] 可注入时钟（测时序/耗时）
 * @param {string} [deps.tmpRoot] 抽帧临时目录根
 * @param {Function} [deps.readImage] path→base64 加载器
 * @returns {{start:Function}} start(input) → {captureId, attribution, done}（done 永不 reject）
 */
export function createPerceptionPipeline({
  fast = createFastVisionClient(),
  deep = createDeepVisionClient(),
  local = createLocalVisionAdapter({}),
  classifySensitive: classify = classifySensitive,
  attribute = attributeCapture,
  extractFrames = extractFramesImpl,
  handoffAudio = null,
  clock = { now: () => Date.now() },
  tmpRoot = tmpdir(),
  readImage = defaultReadImage,
} = {}) {
  return {
    /**
     * 编排一次捕获。同步返回归属结果（POST /api/captures 202 回体用）；done 是整条双路
     * 流水线（routes 不 await，SSE 由 input.emit(type, payload) 桥接）。
     * input: { captureId, ownerId, kind:'image'|'video', path, mimeType,
     *          capturedAt, uploadedAt, blocks[], emit }
     */
    start(input = {}) {
      const emit = typeof input.emit === 'function' ? input.emit : () => {};
      const captureId = input.captureId ?? null;
      const attribution = attribute({ blocks: input.blocks, capturedAt: input.capturedAt, uploadedAt: input.uploadedAt });
      const blockId = attribution.status === 'matched' ? attribution.blockId : null;
      const block = Array.isArray(input.blocks) ? (input.blocks.find(b => b && b.id === blockId) || null) : null;
      const promptCtx = { blockTitle: block ? block.title : null, blockKind: block ? block.kind : null };
      const done = run().catch(err => { // 兜底：抽帧失败等意外不炸进程（done 永不 reject）
        emit('card.error', { captureId, blockId, error: errText(err) });
        return { status: 'error', error: errText(err) };
      });
      return { captureId, attribution, done };

      async function run() {
        // ---- 媒体准备：照片单图；视频抽帧（每 2s ∪ 场景切换 ≤15 帧 + 音轨留桩，PRD L497）----
        let entries;
        let cleanup = null;
        if (input.kind === 'video') {
          const fr = await extractFrames({ captureId, videoPath: input.path, tmpRoot, handoffAudio });
          cleanup = typeof fr.cleanup === 'function' ? fr.cleanup : null;
          if (!(fr.durationSec <= MAX_SYNC_VIDEO_SEC)) { // NaN/超长都进后台分支（fail-safe）
            emit('card.pending', { captureId, blockId, durationSec: fr.durationSec });
            return { status: 'pending', durationSec: fr.durationSec, frames: fr.frames, cleanup };
          }
          entries = fr.frames.map(p => ({ path: p, mimeType: 'image/jpeg' }));
        } else {
          entries = [{ path: input.path, mimeType: input.mimeType || mimeOf(input.path) }];
        }
        const images = await Promise.all(entries.map(readImage));
        const ctx = { ...promptCtx, nowText: new Date(clock.now()).toISOString() };

        // ---- 快路：一句话即时卡（qwen3.5-omni-flash 目标 ≤2s；prototype st=1）----
        let fastResult = null;
        let fastCard = null;
        try {
          const t0 = clock.now();
          fastResult = await fast.analyze({ images: images.slice(0, 1), prompt: fastPrompt(ctx) });
          fastCard = {
            captureId,
            blockId,
            confidence: attribution.status === 'matched' ? attribution.confidence : null,
            level: 'fast',
            model: fast.model,
            ms: elapsed(clock, t0),
            seen: fastResult.seen ?? null,
          };
          if (attribution.status === 'ambiguous') fastCard.candidates = attribution.candidates; // 歧义候选交用户选（BUILD-PLAN L142）
          emit('card.created', fastCard);
        } catch (err) {
          emit('card.fast_failed', { captureId, blockId, error: errText(err) }); // 快路失败不陪葬深路
        }

        // ---- 敏感判定：命中 → 只走本地路径 + 默认不存原图（PRD §6.8.4 L516）----
        /** 深感知结果 → card.upgraded 载荷：ContextDelta（PRD §6.8.2 L491）+ 建议卡（L493）。 */
        const buildUpgraded = (client, res, ms, localOnly) => {
          const contextDelta = buildContextDelta({ captureId, blockId, fast: fastResult || {}, deep: res });
          return {
            captureId,
            blockId,
            level: 'deep',
            model: client.model,
            ms,
            seen: res.seen ?? (fastResult ? fastResult.seen : null) ?? null,
            change: res.change ?? null,
            risk: res.risk ?? null,
            suggestion: res.suggestion ?? null,
            actions: res.actions ?? [],
            contextDelta,
            suggestionCard: buildSuggestionCard({ contextDelta, suggestion: res.suggestion, actions: res.actions }),
            ...(localOnly ? { localOnly: true } : {}),
          };
        };
        const sens = classify(fastResult || '');
        if (sens && sens.sensitive) {
          emit('card.sensitive', { captureId, blockId, category: sens.category, localOnly: true });
          if (local && local.configured) { // 本地 minicpm-v 升级（云端 deep 绝不调用）
            try {
              const t0 = clock.now();
              const res = await local.analyze({ images, prompt: deepPrompt({ ...ctx, planSummary: block ? block.note : null }) });
              const upgraded = buildUpgraded(local, res, elapsed(clock, t0), true);
              emit('card.upgraded', upgraded);
              await safeRun(cleanup);
              return { status: 'local-only', keepOriginal: false, card: upgraded };
            } catch (err) {
              emit('card.local_failed', { captureId, blockId, error: errText(err) });
            }
          }
          await safeRun(cleanup);
          return { status: 'local-only', keepOriginal: false, card: fastCard ? { ...fastCard, localOnly: true } : null };
        }

        // ---- 深路：对比计划 → 变化/风险/建议 + 动作，同卡原地升级（qwen3-vl-plus 目标 ≤8s）----
        try {
          const t0 = clock.now();
          const res = await deep.analyze({ images, prompt: deepPrompt({ ...ctx, planSummary: block ? block.note : null }) });
          const upgraded = buildUpgraded(deep, res, elapsed(clock, t0), false);
          emit('card.upgraded', upgraded);
          await safeRun(cleanup);
          return { status: 'upgraded', card: upgraded };
        } catch (err) {
          emit('card.deep_failed', { captureId, blockId, error: errText(err) }); // 深失败/超时：快卡保留（BUILD-PLAN L146）
          await safeRun(cleanup);
          return fastCard ? { status: 'deep-failed', card: fastCard } : { status: 'failed', card: null };
        }
      }
    },
  };
}
