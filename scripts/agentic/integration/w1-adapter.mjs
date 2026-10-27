// S2D-W13 · M15 W1 legacy DTO → W0 Agentic Block 边界适配器
// （scripts/agentic/integration/w1-adapter.mjs）。
//
// 依据：brief §4.3「边界 adapter」——W1 legacy DTO 只有在完成时间、来源、owner、
// schemaVersion 和服务端时间戳补全后才转成 W0 Agentic Block；草稿或缺字段留在
// 同步层并明确返回 UNKNOWN/不可执行原因。plan.md §G2 M15（TA1 锚点：
// snake/camelCase、prio int/enum、source 枚举、draft 无 start/end）。
//
// 语义锚点（tests/unit/agentic/blocks/contract-consistency.test.mjs 文件头注
// :15-20，W1 流已锚定现有代码，非凭空约定）：
//   prio 上行 1|2→high、3→normal、4|5→low（低数值=高优先，index.html prio-up 递减）；
//   source 上行 web|draft→manual（契约枚举无 web/draft，二者皆用户手工动作），
//   契约原生枚举值（voice/manual/agent/sync/import/system）原样通过；
//   schemaVersion 常量 1。
// 与 W1 测试内适配层的唯一分歧（W13 裁决升级，w1-adapter.test.mjs :12-13 锁定）：
//   createdAt/updatedAt 由集成路径注入的服务端时钟补全，不再沿用 W1 测试层
//   「以 updated_at 兜底」的有损路径——DTO 自带的时间戳不被信任。
//
// 门控顺序（fail-closed，任何不足 → outcome=UNKNOWN，不产出 block）：
//   0. dto 非对象 → UNKNOWN（无可转换物）。
//   1. 软删行（deleted_at 置位）→ UNKNOWN：墓碑永不进入执行层，留在同步层。
//   2. 字段完备性/有效性（missing 数组逐字段点名，reason 人类可读）：
//      id 非空串、revision 整数≥1、date YYYY-MM-DD、start/end 非空且
//      HH:MM|24:00（frozen pattern；draft 的 null 在此拦截——W0 v1 schema
//      必填 start/end，TA1 缺口保持显式，待 CTO 裁决，不静默变绿）、
//      title 非空、kind 冻结枚举、prio 整数 1..5、source 可映射到冻结枚举、
//      done 布尔、note 字符串（缺省 ''）。
//   3. ownerId 只取服务端会话（options.ownerId），绝不读 DTO 的任何 owner 字段
//      （伪造 owner_id 被剥除，测试锁定）；缺 ownerId → UNKNOWN。
//   4. 服务端时间戳：now()（集成根确定性时钟）单次调用盖 createdAt=updatedAt；
//      产出非 ISO date-time → UNKNOWN（拒绝盖章，不降级）。
//   5. 兜底：组装结果再过冻结 block.schema.json（contracts.mjs validate，
//      additionalProperties:false）——非规范字段（state/use/intent…）天然剥除，
//      任何漏网缺陷 → UNKNOWN 并回填 schema 错误路径。
//
// 红线：纯函数（零副作用、不写库、不发事件——事件归 dispatcher/组合根）；
// 无隐藏 wall clock（now 必须注入，缺省即抛）；不读 key；无外部调用。
// 时间顺序（如 start≥end）不在门内：冻结 schema 是唯一权威，接缝不发明
// schema 之外的校验规则。
//
// 留同步层语义：UNKNOWN 结果不改动、不删除 W1 侧任何数据；调用方（M16/M21/M22）
// 只可把 result.block（ok:true 时）送执行层，UNKNOWN 行永远留在 W1 同步层。

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSchema, validate } from '../contracts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(here, '../../../contracts/agentic');
const blockSchema = loadSchema('block.schema.json', schemaDir);

/** prio 上行映射（W1 contract-consistency.test.mjs:45 锚定，1|2→high/3→normal/4|5→low）。 */
export const PRIO_TO_ENUM = Object.freeze({ 1: 'high', 2: 'high', 3: 'normal', 4: 'low', 5: 'low' });
/** source 上行映射（同上 :47——契约枚举无 web/draft，皆用户手工动作 → manual；其余原样）。 */
export const SOURCE_TO_ENUM = Object.freeze({ web: 'manual', draft: 'manual' });

const KIND_ENUM = new Set(['necessary', 'restore', 'create', 'connect', 'explore', 'stillness']);
const SOURCE_ENUM = new Set(['voice', 'manual', 'agent', 'sync', 'import', 'system']);
// 与冻结 block.schema.json start/end pattern 逐字符一致（24:00 允许）。
const HHMM = /^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// contracts.mjs 的 ISO date-time 形状（同源复制，仅用于盖章前置校验）。
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function unknown(reason, missing) {
  // 不携带 block 键：被拒行不得产出任何可被执行层消费的对象（测试锁定 undefined）。
  return { ok: false, outcome: 'UNKNOWN', executionReady: false, reason, missing };
}

/**
 * W1 legacy DTO（block-store store.mjs rowToBlock 形状）→ W0 Agentic Block。
 *
 * @param {object} dto        W1 服务端权威行（id/revision/date/start/end/title/
 *                            kind/prio/note/done/source/deleted_at/updated_at）。
 * @param {object} options
 * @param {string} options.ownerId  服务端会话派生的 owner（必填；DTO 内任何 owner
 *                                  字段一律不采信）。
 * @param {Function} options.now    集成根确定性时钟 () => ISO date-time（必填；
 *                                  缺省即抛——集成路径禁隐藏 wall clock）。
 * @param {number} [options.schemaVersion=1]
 * @returns {{ok:true, executionReady:true, block:object}}
 *        | {{ok:false, outcome:'UNKNOWN', executionReady:false, reason:string,
 *            missing:string[]}}
 * @throws {Error} options.now 缺失/非函数（接线错误，非数据裁决）。
 */
export function adaptW1DtoToBlock(dto, { ownerId, now, schemaVersion = 1 } = {}) {
  if (typeof now !== 'function') {
    throw new Error('w1-adapter: integration clock (now) is required — hidden wall clocks are forbidden on the integration path');
  }
  if (dto === null || typeof dto !== 'object' || Array.isArray(dto)) {
    return unknown('dto is not an object; nothing to convert, the row stays in the W1 sync layer', []);
  }

  // —— 软删墓碑最先拦截：已删除行与字段完备性无关，永不进入执行层。
  if (dto.deleted_at != null) {
    return unknown(
      `soft-deleted row (deleted_at=${JSON.stringify(dto.deleted_at)}) never becomes executable; it stays in the W1 sync layer`,
      [],
    );
  }

  // —— 字段完备性/有效性（完成时间/来源/身份素材逐字段点名）。missing 只列
  // 真正缺席或无效的字段（draft 用例锁定恰好 ['start','end']），不夹带其他。
  const missing = [];
  const details = [];
  const flag = (field, detail) => { missing.push(field); details.push(detail); };

  if (typeof ownerId !== 'string' || ownerId.length === 0) {
    flag('ownerId', 'owner missing from the server session (never read from the DTO)');
  }
  if (typeof dto.id !== 'string' || dto.id.length === 0) flag('id', 'id absent');
  if (!Number.isInteger(dto.revision) || dto.revision < 1) flag('revision', 'revision must be a server-assigned integer ≥ 1');
  if (typeof dto.date !== 'string' || !ISO_DATE.test(dto.date)) {
    flag('date', `date must be YYYY-MM-DD (got ${JSON.stringify(dto.date)})`);
  }
  for (const field of ['start', 'end']) {
    const value = dto[field];
    if (value === null || value === undefined) {
      flag(field, `${field} is null — draft rows carry no time and stay in the W1 sync layer`);
    } else if (value === '' || !HHMM.test(value)) {
      flag(field, `${field} must match HH:MM or 24:00 (got ${JSON.stringify(value)})`);
    }
  }
  if (typeof dto.title !== 'string' || dto.title.length === 0) flag('title', 'title absent');
  if (typeof dto.kind !== 'string' || !KIND_ENUM.has(dto.kind)) {
    flag('kind', `kind ${JSON.stringify(dto.kind)} is outside the frozen enum (necessary|restore|create|connect|explore|stillness) — not coerced`);
  }
  if (!Number.isInteger(dto.prio) || !(dto.prio in PRIO_TO_ENUM)) {
    flag('prio', `prio ${JSON.stringify(dto.prio)} is outside the legacy 1..5 scale — not silently defaulted`);
  }
  const mappedSource = typeof dto.source === 'string' ? (SOURCE_TO_ENUM[dto.source] ?? dto.source) : undefined;
  if (typeof dto.source !== 'string' || !SOURCE_ENUM.has(mappedSource)) {
    flag('source', `source ${JSON.stringify(dto.source)} does not map into the frozen enum (voice|manual|agent|sync|import|system)`);
  }
  if (typeof dto.done !== 'boolean') flag('done', 'done must be a boolean');
  if (dto.note != null && typeof dto.note !== 'string') flag('note', 'note must be a string');

  if (missing.length > 0) {
    return unknown(
      `W1 row stays in the sync layer, not execution-ready — missing/invalid: ${missing.join(', ')} (${details.join('; ')})`,
      missing,
    );
  }

  // —— 服务端时间戳补全：集成时钟单次盖章；产出非 ISO date-time 即拒绝（不降级、
  // 不回读 DTO 时间戳——测试锁定 updated_at='1999-…' 不得透传）。
  const stamp = now();
  if (typeof stamp !== 'string' || !ISO_DATE_TIME.test(stamp)) {
    return unknown(
      `integration clock did not produce an ISO-8601 date-time (${JSON.stringify(stamp)}); refusing to stamp server timestamps`,
      [],
    );
  }

  // —— 组装：只拷贝冻结 schema 认识的字段（additionalProperties:false 兜底剥除非
  // 规范字段 state/use/intent/…与一切 snake_case 键）。deletedAt 省略：能走到这里的
  // 行必然未删除（软删已在第一道门拦截），省略即活块。
  const block = {
    id: dto.id,
    ownerId,
    revision: dto.revision,
    schemaVersion,
    date: dto.date,
    start: dto.start,
    end: dto.end,
    title: dto.title,
    kind: dto.kind,
    prio: PRIO_TO_ENUM[dto.prio],
    note: dto.note == null ? '' : dto.note,
    done: dto.done,
    source: mappedSource,
    createdAt: stamp,
    updatedAt: stamp,
  };

  // —— 冻结契约兜底：以上所有门都应保证 valid；若仍有漏网（如 schemaVersion 被
  // 调用方传成 0），以 schema 错误路径回填 UNKNOWN——绝不放行半合法块。
  const check = validate(block, blockSchema, { schemaDir });
  if (!check.valid) {
    const paths = check.errors.map(error => String(error.path ?? '').replace(/^\$\.?/, '')).filter(Boolean);
    return unknown(
      `mapped block failed the frozen block.schema.json: ${check.errors.map(error => `${error.path}: ${error.message ?? ''}`).join('; ')}`,
      paths,
    );
  }
  return { ok: true, executionReady: true, block };
}
