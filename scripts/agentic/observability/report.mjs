/**
 * W10 matrix → Markdown report.
 *
 * The report is the artefact a reviewer re-checks, so it is deliberately
 * literal:
 *
 *  - every gate is rendered with its exact command, rc and pass/fail/skip
 *    counters (a claim without a command is not a claim);
 *  - an unresolved actor is rendered as `resolved_model=NULL` instead of an
 *    empty cell, because a blank cell reads as "nothing to see";
 *  - data that does not exist is spelled `UNKNOWN`, never `0` (N6);
 *  - `## UNKNOWN` and `## BLOCKED` sections are never emptied away — an empty
 *    list says so explicitly.
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { observabilityError, isNonEmptyString, OBS_ERROR_CODES } from './vocabulary.mjs';

export const REPORT_COLUMNS = Object.freeze([
  '流',
  'HEAD',
  '契约',
  'push',
  '门禁',
  '评审模型',
  '未修风险',
  '状态',
]);

const TABLE_HEADER = `| ${REPORT_COLUMNS.join(' | ')} |`;
const TABLE_DIVIDER = `| ${REPORT_COLUMNS.map(() => '---').join(' | ')} |`;

function orUnknown(value) {
  return isNonEmptyString(String(value ?? '')) ? String(value) : 'UNKNOWN';
}

function cell(text) {
  // A pipe inside a cell would break the table; escaping keeps the row count honest.
  return String(text).replace(/\|/g, '\\|');
}

function renderGates(gates) {
  if (!Array.isArray(gates) || gates.length === 0) return 'UNKNOWN';
  return gates
    .map((gate) => {
      const name = gate?.name ?? 'UNKNOWN';
      const command = isNonEmptyString(gate?.command) ? gate.command : 'UNKNOWN';
      const rc = Number.isInteger(gate?.rc) ? gate.rc : 'UNKNOWN';
      const passed = Number.isInteger(gate?.passed) ? gate.passed : 'UNKNOWN';
      const failed = Number.isInteger(gate?.failed) ? gate.failed : 'UNKNOWN';
      const skipped = Number.isInteger(gate?.skipped) ? gate.skipped : 'UNKNOWN';
      return `${name}: ${command} rc=${rc} pass=${passed} fail=${failed} skip=${skipped}`;
    })
    .join('; ');
}

function renderReviewModels(models) {
  if (!Array.isArray(models) || models.length === 0) return 'UNKNOWN';
  return models
    .map((model) => {
      const resolved = isNonEmptyString(model?.resolvedModel) ? model.resolvedModel : 'NULL';
      return `${model?.role ?? 'UNKNOWN'}:${resolved}(${model?.modelSource ?? 'UNKNOWN'})`;
    })
    .join(', ');
}

function renderRisks(risks) {
  const open = (Array.isArray(risks) ? risks : []).filter((risk) => risk?.status === 'open');
  if (open.length === 0) return '无';
  return open.map((risk) => `${risk.id ?? 'UNKNOWN'}(${risk.severity ?? 'UNKNOWN'})`).join(', ');
}

function renderPush(push) {
  if (!push || typeof push !== 'object') return 'UNKNOWN';
  const ref = isNonEmptyString(push.ref) ? push.ref : 'UNKNOWN';
  const state = push.pushed === true ? 'pushed' : 'not-pushed';
  const rc = Number.isInteger(push.rc) ? push.rc : 'UNKNOWN';
  return `${ref} ${state} rc=${rc}`;
}

function renderContract(row) {
  const relation = isNonEmptyString(row?.contractRelation) ? row.contractRelation : 'UNKNOWN';
  // Report-derived rows carry only a commit prefix. Rendering it as-is keeps
  // the prefix re-parseable; dropping it to UNKNOWN would fabricate
  // CONTRACT_DRIFT on the next round trip (§7.2).
  const commit = isNonEmptyString(row?.contractCommit)
    ? row.contractCommit.slice(0, 7)
    : (isNonEmptyString(row?.contractCommitPrefix) ? row.contractCommitPrefix : 'UNKNOWN');
  return `${relation}@${commit}`;
}

function renderRow(row) {
  const cells = [
    orUnknown(row?.stream),
    orUnknown(row?.head),
    renderContract(row),
    renderPush(row?.push),
    renderGates(row?.gates),
    renderReviewModels(row?.reviewModels),
    renderRisks(row?.risks),
    orUnknown(row?.status),
  ];
  return `| ${cells.map(cell).join(' | ')} |`;
}

function describeUnknown(streamName, item) {
  const severity = item?.severity ?? 'UNKNOWN';
  const detail = Object.entries(item ?? {})
    .filter(([key]) => key !== 'code' && key !== 'severity')
    .map(([key, value]) => `${key}=${value === null || value === undefined ? 'NULL' : String(value)}`)
    .join(' ');
  return `- ${streamName} · ${item?.code ?? 'UNKNOWN'} · ${severity}${detail ? ` · ${detail}` : ''}`;
}

function collectUnknowns(matrix, { severity } = {}) {
  const lines = [];
  for (const row of Array.isArray(matrix?.rows) ? matrix.rows : []) {
    for (const item of Array.isArray(row?.unknowns) ? row.unknowns : []) {
      if (severity !== undefined && item?.severity !== severity) continue;
      lines.push(describeUnknown(orUnknown(row.stream), item));
    }
  }
  return lines;
}

/**
 * Render one matrix as Markdown.
 *
 * Deterministic: the output depends only on the matrix object, never on the
 * clock or on object iteration order of caller input.
 */
export function renderMatrixMarkdown(matrix) {
  const frozen = matrix?.frozen ?? {};
  const summary = matrix?.summary ?? {};
  const rows = Array.isArray(matrix?.rows) ? matrix.rows : [];

  const lines = [];
  lines.push(`# S2D 批次验收矩阵 · ${frozen.version ?? 'UNKNOWN'}`);
  lines.push('');
  lines.push(`- 冻结契约 commit: ${frozen.commit ?? 'UNKNOWN'}`);
  lines.push(`- 生成时间: ${matrix?.generatedAt ?? 'UNKNOWN'}`);
  lines.push(`- owner: ${matrix?.ownerId ?? 'UNKNOWN'}`);
  lines.push(
    `- 汇总: total=${summary.total ?? 0} verified=${summary.verified ?? 0} provisional=${summary.provisional ?? 0} ` +
      `unknown=${summary.unknown ?? 0} blocked=${summary.blocked ?? 0} → ${summary.status ?? 'UNKNOWN'}`,
  );
  lines.push('');
  lines.push(TABLE_HEADER);
  lines.push(TABLE_DIVIDER);
  for (const row of rows) lines.push(renderRow(row));
  lines.push('');

  // Every unknown is listed here, whatever its severity, so a PROVISIONAL row
  // cannot hide a blocker behind its status word.
  lines.push('## UNKNOWN');
  lines.push('');
  const unknowns = collectUnknowns(matrix);
  if (unknowns.length === 0) lines.push('无');
  else lines.push(...unknowns);
  lines.push('');

  lines.push('## BLOCKED');
  lines.push('');
  const blocked = collectUnknowns(matrix, { severity: 'BLOCKED' });
  if (blocked.length === 0) lines.push('无');
  else lines.push(...blocked);
  lines.push('');

  lines.push('## 逐流明细');
  lines.push('');
  if (rows.length === 0) lines.push('UNKNOWN（矩阵没有任何流）');
  for (const row of rows) {
    lines.push(`### ${orUnknown(row.stream)}`);
    lines.push('');
    // A row synthesised from a failed parse says so first: it explains why
    // every other line in this section is UNKNOWN (§7.2 解析失败即 UNKNOWN).
    if (isNonEmptyString(row?.parseError)) lines.push(`- 解析: ${row.parseError}`);
    lines.push(`- HEAD: ${orUnknown(row.head)}`);
    lines.push(`- 契约: ${renderContract(row)}`);
    lines.push(`- push: ${renderPush(row.push)}`);
    lines.push(`- 门禁: ${renderGates(row.gates)}`);
    lines.push(`- web 证据: ${row?.web ? `${row.web.command ?? 'UNKNOWN'} rc=${Number.isInteger(row.web.rc) ? row.web.rc : 'UNKNOWN'}` : 'UNKNOWN'}`);
    const models = Array.isArray(row.reviewModels) ? row.reviewModels : [];
    if (models.length === 0) lines.push('- 评审模型: UNKNOWN');
    for (const model of models) {
      const resolved = isNonEmptyString(model?.resolvedModel) ? model.resolvedModel : 'NULL';
      lines.push(`- 评审模型: ${model?.role ?? 'UNKNOWN'} resolved_model=${resolved} source=${model?.modelSource ?? 'UNKNOWN'}`);
    }
    for (const risk of Array.isArray(row.risks) ? row.risks : []) {
      lines.push(`- 风险: ${risk?.id ?? 'UNKNOWN'} severity=${risk?.severity ?? 'UNKNOWN'} status=${risk?.status ?? 'UNKNOWN'}`);
    }
    lines.push(`- 状态: ${orUnknown(row.status)}`);
    // The status a source report claimed is kept next to the derivation when
    // the two disagree: a conflict is a record, not something to reconcile
    // away (STATUS_CONFLICT also appears in ## UNKNOWN above).
    if (isNonEmptyString(row?.claimedStatus) && row.claimedStatus !== row.status) {
      lines.push(`- 状态冲突: claimed=${row.claimedStatus} derived=${orUnknown(row.status)}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

/**
 * Persist the rendered report.
 *
 * An existing file is never clobbered silently: a report path may already hold
 * somebody else's hand-written evidence, so overwriting requires an explicit
 * `overwrite: true`.
 */
export function writeMatrixReport({ matrix, path, overwrite = false } = {}) {
  if (!isNonEmptyString(path)) {
    throw observabilityError(OBS_ERROR_CODES.INVALID_ARGUMENT, 'a report path is required');
  }
  const markdown = renderMatrixMarkdown(matrix);
  if (!overwrite && existsSync(path)) {
    throw observabilityError(OBS_ERROR_CODES.REPORT_EXISTS, `report already exists: ${path}`, { path });
  }
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, markdown, 'utf8');
  return { path, markdown };
}
