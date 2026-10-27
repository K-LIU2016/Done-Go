// W12 现场感知 · 归属（PRD §6.8.2 L485-487、BUILD-PLAN §3 W12-2 L142）：
// 纯函数——把一次拍摄归属到日程块。blocks 由调用方注入（{id,title,kind,start,end} 的
// W1 块结构），本模块不依赖 W1 代码。判定维度：拍摄时间（EXIF capturedAt → 上传时间
// uploadedAt 兜底）× 块窗口 ± 准备窗（默认 30 分钟，可注入）× 块类型（stillness 零打扰
// 块整体排除，PRD §6.8.4）。时间统一折算成 epoch 毫秒比较：显式时区偏移（Z/±HH:MM）
// 直接用，无偏移的裸串按 Asia/Shanghai（固定 +08:00，无夏令时）补齐，因此 UTC 输入与
// 跨午夜块自然正确。
// 置信度分层：核心窗口 [start,end]（两端含）→ 0.9；仅准备窗（[start−prep,start) ∪
// (end,end+prep]，外沿含内沿不含）→ 0.5。最高置信层唯一命中 → matched；并列 →
// ambiguous，候选含全部命中块（按置信度降序、并列按 start 升序，末位按 id 定序），
// 交用户裁决（BUILD-PLAN L142；持久层 resolveCapture 拍板后置信度置 1）。
// 无命中 → {status:'none', reason}（no-time/no-blocks/no-window），卡片降级仅记录。
export const CORE_CONFIDENCE = 0.9;
export const PREP_CONFIDENCE = 0.5;
export const DEFAULT_PREP_WINDOW_MIN = 30;
const SHANGHAI_OFFSET = '+08:00'; // Asia/Shanghai 无夏令时，固定偏移即可，无需时区库
const HAS_TZ = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** 单个时刻 → epoch 毫秒；缺失/无法解析返回 null。Date/有限数字原样取值；字符串按
 *  Asia/Shanghai 解释无偏移裸串（日期裸串视为当天 00:00 本地）。 */
function toMs(value) {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  let text = value.trim();
  if (DATE_ONLY.test(text)) text += 'T00:00:00';
  if (!HAS_TZ.test(text)) text += SHANGHAI_OFFSET;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

const minutes = n => n * 60_000;

/**
 * 归属一次拍摄。入参全部注入，无 IO、无时钟读取、不改 blocks（纯函数，可重放）。
 * @param {object} input
 * @param {Array<{id:string,title?:string,kind?:string,start:string,end:string}>} input.blocks 日程块
 * @param {string|null} [input.capturedAt] 拍摄时间（EXIF），优先
 * @param {string|null} [input.uploadedAt] 上传时间，EXIF 缺失时兜底
 * @param {number} [input.prepWindowMin=30] 准备窗分钟数（0 = 只认核心窗口）
 * @returns {{status:'matched',blockId:string,confidence:number}
 *          |{status:'ambiguous',candidates:Array<{blockId:string,title,kind,confidence:number}>}
 *          |{status:'none',reason:'no-time'|'no-blocks'|'no-window'}}
 */
export function attributeCapture({ blocks, capturedAt, uploadedAt, prepWindowMin = DEFAULT_PREP_WINDOW_MIN } = {}) {
  const at = toMs(capturedAt) ?? toMs(uploadedAt);
  if (at === null) return { status: 'none', reason: 'no-time' };
  if (!Array.isArray(blocks) || blocks.length === 0) return { status: 'none', reason: 'no-blocks' };

  const prep = minutes(Number.isFinite(prepWindowMin) ? Math.max(0, prepWindowMin) : DEFAULT_PREP_WINDOW_MIN);

  const hits = [];
  for (const b of blocks) {
    if (!b || b.kind === 'stillness') continue; // 零打扰块不参与归属
    if (!b.id) continue; // 防御：无 id 的脏块跳过，不炸整条感知流水线
    const start = toMs(b.start);
    const end = toMs(b.end);
    if (start === null || end === null) continue; // 防御：时间不可解析的块跳过
    let confidence = null;
    if (at >= start && at <= end) confidence = CORE_CONFIDENCE;
    else if (prep > 0 && at >= start - prep && at < start) confidence = PREP_CONFIDENCE;
    else if (prep > 0 && at > end && at <= end + prep) confidence = PREP_CONFIDENCE;
    if (confidence !== null) hits.push({ id: String(b.id), title: b.title ?? null, kind: b.kind ?? null, start, confidence });
  }
  if (hits.length === 0) return { status: 'none', reason: 'no-window' };

  hits.sort((x, y) => y.confidence - x.confidence || x.start - y.start || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const top = hits.filter(h => h.confidence === hits[0].confidence);
  if (top.length === 1) return { status: 'matched', blockId: top[0].id, confidence: top[0].confidence };
  return { status: 'ambiguous', candidates: hits.map(({ id, title, kind, confidence }) => ({ blockId: id, title, kind, confidence })) };
}
