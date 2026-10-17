import { FIXTURE_IDS, computeChangeSetHash } from "../../domain/index.ts";
import type {
  Approval,
  ChangeSet,
  DomainState,
  EntityId,
  Intent,
  LedgerEntry,
  ObjectDiff,
  Operation,
  Plan,
  PlanKind,
} from "../../domain/index.ts";
import {
  formatCapacityWarning,
  formatIsoDateCn,
  formatIsoTime,
  formatMinuteOfDay,
  isoDateOf,
  minuteOfDay,
  selectCapacityView,
  selectModificationView,
  selectSurfaceDate,
  weekdayIndexOf,
} from "../s01-now/timeSurfaces.ts";
import type { CapacityView, ModificationKind } from "../s01-now/timeSurfaces.ts";
import { resolveIntentCalendarContext } from "./intent-calendar-context.ts";

/**
 * Pure view adapters for the plan surfaces (s04, s15, s16).
 *
 * Rules encoded here:
 * - every minute number comes from a stored Plan / ChangeSet / capacity view;
 *   this file never hardcodes business quantities (60/40/110/90/130...);
 * - an explicit ?intentId= that is missing, duplicated, empty, or not a saved
 *   intent fails closed (no silent fallback to fixture data);
 * - a plan proposal is only ever created by an explicit user command from the
 *   screen layer; these adapters are read-only.
 */

const SAFE_DIFF_FIELDS = new Set(["effortEstimateMinutes", "schedule.date"]);

const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

export type PlanIntentFailReason =
  | "malformedQuery"
  | "explicitIntentNotFound"
  | "explicitIntentNotSaved"
  | "intentDateUnknown"
  | "noApplicableIntent";

export type PlanIntentResolution =
  | { ok: true; intentId: EntityId; source: "explicit" | "fixture" | "latestSaved" }
  | { ok: false; reason: PlanIntentFailReason; explicitQuery: boolean };

export function resolvePlanIntent(
  state: DomainState,
  explicitIntentIds: readonly string[],
): PlanIntentResolution {
  if (explicitIntentIds.length > 1) {
    return { ok: false, reason: "malformedQuery", explicitQuery: true };
  }
  if (explicitIntentIds.length === 1) {
    const raw = explicitIntentIds[0];
    if (raw.trim() === "") return { ok: false, reason: "malformedQuery", explicitQuery: true };
    const intent = state.intents[raw];
    if (!intent) return { ok: false, reason: "explicitIntentNotFound", explicitQuery: true };
    if (intent.status !== "saved") {
      return { ok: false, reason: "explicitIntentNotSaved", explicitQuery: true };
    }
    return { ok: true, intentId: intent.id, source: "explicit" };
  }
  const fixture = state.intents[FIXTURE_IDS.intent];
  if (fixture && fixture.status === "saved") {
    return { ok: true, intentId: fixture.id, source: "fixture" };
  }
  const saved = Object.values(state.intents).filter((intent) => intent.status === "saved");
  const latest = saved[saved.length - 1];
  if (latest) return { ok: true, intentId: latest.id, source: "latestSaved" };
  return { ok: false, reason: "noApplicableIntent", explicitQuery: false };
}

/**
 * Latest-entity selection relies on Object.values insertion order, which the
 * domain store preserves as creation order.
 */
export function selectLatestPlanForKind(
  state: DomainState,
  intentId: EntityId,
  kind: PlanKind,
): Plan | null {
  let latest: Plan | null = null;
  for (const plan of Object.values(state.plans)) {
    if (plan.kind === kind && plan.intentId === intentId) latest = plan;
  }
  return latest;
}

export function selectLatestChangeSetForPlan(state: DomainState, planId: EntityId): ChangeSet | null {
  let latest: ChangeSet | null = null;
  for (const changeSet of Object.values(state.changeSets)) {
    if (changeSet.planId === planId) latest = changeSet;
  }
  return latest;
}

export function selectLatestPlanOperation(state: DomainState, planId: EntityId): Operation | null {
  const planChangeSetIds = new Set<EntityId>();
  for (const changeSet of Object.values(state.changeSets)) {
    if (changeSet.planId === planId) planChangeSetIds.add(changeSet.id);
  }
  let latest: Operation | null = null;
  for (const operation of Object.values(state.operations)) {
    if (planChangeSetIds.has(operation.changeSetId)) latest = operation;
  }
  return latest;
}

export interface ChangeSetFreshness {
  fresh: boolean;
  reasons: string[];
}

/** View-side mirror of the domain staleness check; never mutates state. */
export function selectChangeSetFreshness(state: DomainState, changeSet: ChangeSet): ChangeSetFreshness {
  const reasons = new Set<string>();
  if (computeChangeSetHash(changeSet) !== changeSet.hash) {
    reasons.add("变更内容与已保存的变更集不一致");
  }
  if (changeSet.ruleRevision !== state.ruleset.revision) {
    reasons.add("规则版本已更新");
  }
  for (const [sourceId, boundVersion] of Object.entries(changeSet.sourceVersionSet)) {
    const source = state.sources[sourceId];
    if (!source) reasons.add("绑定的数据来源已不存在");
    else if (source.sourceVersion !== boundVersion) reasons.add("来源数据已有新版本");
  }
  for (const [targetId, boundRevision] of Object.entries(changeSet.targetRevisions)) {
    const target = state.commitments[targetId] ?? state.intents[targetId];
    if (!target) reasons.add("绑定的责任已不存在");
    else if (target.revision !== boundRevision) reasons.add("责任内容已有新版本");
  }
  return { fresh: reasons.size === 0, reasons: [...reasons] };
}

function hasFlexibleCommitment(state: DomainState): boolean {
  return Object.values(state.commitments).some(
    (commitment) =>
      commitment.status === "active" &&
      commitment.mobility === "flexible" &&
      commitment.effortEstimateMinutes !== null,
  );
}

export interface PlanSelectOffer {
  action: "create" | "view" | "regenerate" | "blocked";
  label: string;
  note: string | null;
}

/** Select-offer logic for plan A; plan B is preview-only and never selects. */
export function selectPlanSelectOffer(
  state: DomainState,
  plan: Plan | null,
): PlanSelectOffer {
  if (!plan) {
    if (!hasFlexibleCommitment(state)) {
      return {
        action: "blocked",
        label: "暂时不能生成方案",
        note: "当前没有可重新决定的可变投入，因此没有可生成的方案。",
      };
    }
    return { action: "create", label: "选择这条路径", note: "下一步预览具体授权" };
  }
  const operation = selectLatestPlanOperation(state, plan.id);
  if (operation) {
    if (operation.status === "verified") {
      return {
        action: "blocked",
        label: "不会重复提出同样的调整",
        note: "这条方案已经应用；实际节省仍未测量，也不会再次生成同一份调整。",
      };
    }
    if (operation.status === "executing" || operation.status === "verifying") {
      return {
        action: "blocked",
        label: "正在执行，结果未确认",
        note: "等这次执行结束后再决定下一步。",
      };
    }
    if (operation.status === "unknown") {
      return {
        action: "blocked",
        label: "执行结果未知",
        note: "回读确认之前，不能再次生成或执行方案。",
      };
    }
  }
  if (plan.status === "invalid") {
    return {
      action: "regenerate",
      label: "重新生成方案",
      note: "原方案已失效：" + (plan.invalidReason ?? "原因未记录"),
    };
  }
  const changeSet = selectLatestChangeSetForPlan(state, plan.id);
  if (changeSet) {
    const freshness = selectChangeSetFreshness(state, changeSet);
    if (!freshness.fresh) {
      return {
        action: "regenerate",
        label: "重新生成方案",
        note: "方案需要重新检查：" + freshness.reasons.join("；"),
      };
    }
  }
  if (operation && operation.status === "failed") {
    return {
      action: "regenerate",
      label: "重新生成方案",
      note: "上次执行未完成，原安排未变；可以重新生成方案。",
    };
  }
  return {
    action: "view",
    label: "查看已保存的方案",
    note: "方案与变更集已保存，先预览再决定批准。",
  };
}

export interface PlanCardRow {
  term: string;
  detail: string;
  tone: "default" | "warm" | "ok";
}

export interface PlanCardView {
  kind: PlanKind;
  planId: EntityId | null;
  estimateReductionMinutes: number | null;
  deferToDate: string | null;
  headline: string;
  headlineTone: "default" | "delay";
  subnote: string | null;
  statusWord: string | null;
  rows: PlanCardRow[];
  appliedRows: PlanCardRow[];
  emptyNote: string | null;
  offer: PlanSelectOffer;
  previewHref: string;
  changeSetId: EntityId | null;
  changeSetLabel: string | null;
  changeSetHashShort: string | null;
  changeSetStaleReasons: string[];
  targetScope: string | null;
  externalCommitmentUnchanged: boolean;
  remainingFutureDebtMinutes: number | null;
  planStatus: Plan["status"] | null;
  applied: boolean;
}

export interface PlanCardContext {
  windowLabel: string;
  capacityMinutes: number;
  committedLabel: string;
}

function estimateDiffOf(changeSet: ChangeSet): ObjectDiff | null {
  return changeSet.objectDiffs.find((diff) => diff.field === "effortEstimateMinutes") ?? null;
}

function deferDiffOf(changeSet: ChangeSet): ObjectDiff | null {
  return changeSet.objectDiffs.find((diff) => diff.field === "schedule.date") ?? null;
}

function planStatusWord(plan: Plan, operation: Operation | null, freshness: ChangeSetFreshness): string {
  if (operation) {
    if (operation.status === "verified") return "已应用 · 实际节省未测量";
    if (operation.status === "executing" || operation.status === "verifying") return "正在执行 · 结果未确认";
    if (operation.status === "unknown") return "执行结果未知";
    if (operation.status === "failed") return "上次执行未完成";
  }
  if (plan.status === "invalid") return "方案已失效";
  if (!freshness.fresh) return "方案已过期 · 需要重新检查";
  return "已保存 · 待批准（尚未执行）";
}

function remainingFutureDebtMinutes(state: DomainState, planId: EntityId): number | null {
  const operationIds = new Set<EntityId>();
  for (const changeSet of Object.values(state.changeSets)) {
    if (changeSet.planId !== planId) continue;
    for (const operation of Object.values(state.operations)) {
      if (operation.changeSetId === changeSet.id) operationIds.add(operation.id);
    }
  }
  let total = 0;
  let found = false;
  for (const entry of state.ledger) {
    if (
      entry.category === "futureDebt" &&
      entry.operationId !== null &&
      operationIds.has(entry.operationId)
    ) {
      if (state.ledger.some((replacement) => replacement.supersedesId === entry.id)) continue;
      if (entry.minutes === null || !Number.isFinite(entry.minutes)) return null;
      total += entry.minutes;
      found = true;
    }
  }
  return found ? total : null;
}

function externalCommitmentUnchanged(plan: Plan, changeSet: ChangeSet | null): boolean {
  if (!changeSet) return false;
  if (!changeSet.exclusions.some((value) => value.includes("externalCalendarWrite") && value.includes("not granted"))) return false;
  return changeSet.objectDiffs.every((diff) => diff.objectId === plan.commitmentId && SAFE_DIFF_FIELDS.has(diff.field));
}

export function buildPlanCardView(
  state: DomainState,
  intentId: EntityId,
  kind: PlanKind,
  context: PlanCardContext,
): PlanCardView {
  const previewHref = "/preview?intentId=" + encodeURIComponent(intentId) + "&kind=" + kind;
  const plan = selectLatestPlanForKind(state, intentId, kind);
  if (!plan) {
    const offer: PlanSelectOffer = selectPlanSelectOffer(state, null);
    return {
      kind,
      planId: null,
      estimateReductionMinutes: null,
      deferToDate: null,
      headline: "尚未保存",
      headlineTone: kind === "A" ? "default" : "delay",
      subnote: null,
      statusWord: null,
      rows: [],
      appliedRows: [],
      emptyNote:
        kind === "A"
          ? "还没有已保存的方案 A；选择后会生成一份真实方案与变更集，再由你预览和批准。"
          : "还没有已保存的方案 B；先准备方案，预览延期日期与未来负担，再决定批准。",
      offer,
      previewHref,
      changeSetId: null,
      changeSetLabel: null,
      changeSetHashShort: null,
      changeSetStaleReasons: [],
      targetScope: null,
      externalCommitmentUnchanged: false,
      remainingFutureDebtMinutes: null,
      planStatus: null,
      applied: false,
    };
  }
  const changeSet = selectLatestChangeSetForPlan(state, plan.id);
  const operation = selectLatestPlanOperation(state, plan.id);
  const freshness = changeSet
    ? selectChangeSetFreshness(state, changeSet)
    : { fresh: true, reasons: [] as string[] };
  const target = state.commitments[plan.commitmentId] ?? null;
  const applied = operation?.status === "verified";
  const emptyOr = (value: string, fallback: string) => value || fallback;
  if (kind === "A") {
    const diff = changeSet ? estimateDiffOf(changeSet) : null;
    const before = diff && typeof diff.before === "number" ? diff.before : Number.NaN;
    const after = diff && typeof diff.after === "number" ? diff.after : Number.NaN;
    const hasRealDiff = diff !== null && Number.isFinite(before) && Number.isFinite(after);
    const reduction = hasRealDiff ? before - after : null;
    const rows: PlanCardRow[] = [
      reduction !== null
        ? { term: "预计减少人工投入", detail: reduction + " 分钟（预计）", tone: "default" }
        : { term: "预计减少人工投入", detail: "以变更集为准", tone: "warm" },
      {
        term: context.windowLabel + "预计总投入",
        detail: plan.capacityAfterMinutes + " / " + context.capacityMinutes + " 分钟",
        tone: "default",
      },
      {
        term: "仍需你完成",
        detail: changeSet?.actions.some((action) => action.kind === "createDraft")
          ? "内容检查与最终确认"
          : "确认变更结果",
        tone: "default",
      },
    ];
    return {
      kind,
      planId: plan.id,
      estimateReductionMinutes: reduction,
      deferToDate: null,
      headline: hasRealDiff ? before + " → " + after + " 分钟" : "预计总投入 " + plan.capacityAfterMinutes + " 分钟",
      headlineTone: "default",
      subnote: emptyOr(target?.scope ?? "", "这项责任") + "的预计人工投入 · 新估计包含检查与修改",
      statusWord: planStatusWord(plan, operation, freshness),
      rows,
      appliedRows:
        applied
          ? [
              {
                term: "当前账面预计投入",
                detail: context.committedLabel + "（方案估计 " + plan.capacityAfterMinutes + " 分钟）",
                tone: "default",
              },
            ]
          : [],
      emptyNote: null,
      offer: selectPlanSelectOffer(state, plan),
      previewHref,
      changeSetId: changeSet?.id ?? null,
      changeSetLabel: changeSet?.label ?? null,
      changeSetHashShort: changeSet ? changeSet.hash.slice(0, 12) : null,
      changeSetStaleReasons: applied ? [] : freshness.reasons,
      targetScope: target?.scope ?? null,
      externalCommitmentUnchanged: externalCommitmentUnchanged(plan, changeSet),
      remainingFutureDebtMinutes: null,
      planStatus: plan.status,
      applied,
    };
  }
  const diff = changeSet ? deferDiffOf(changeSet) : null;
  const afterDate = diff && typeof diff.after === "string" ? diff.after : null;
  const rows: PlanCardRow[] = [
    {
      term: "预计净节省",
      detail: plan.summary.netSavingClaim === "none" ? "没有发生" : "仅估计，未测量",
      tone: plan.summary.netSavingClaim === "none" ? "warm" : "default",
    },
    {
      term: context.windowLabel + "预计总投入",
      detail: plan.capacityAfterMinutes + " / " + context.capacityMinutes + " 分钟",
      tone: "default",
    },
    {
      term: afterDate ? formatIsoDateCn(afterDate) + "新增负担" : "延期新增负担",
      detail: plan.futureDebtMinutes + " 分钟",
      tone: "warm",
    },
  ];
  const debt = remainingFutureDebtMinutes(state, plan.id);
  return {
    kind,
    planId: plan.id,
    estimateReductionMinutes: null,
    deferToDate: afterDate,
    headline: plan.futureDebtMinutes + " 分钟",
    headlineTone: "delay",
    subnote:
      afterDate
        ? "转移到 " + formatIsoDateCn(afterDate) + " 的工作量 · 这份责任不会消失"
        : "转移到以后日期的工作量 · 这份责任不会消失",
    statusWord: planStatusWord(plan, operation, freshness),
    rows,
    appliedRows:
      applied
        ? [
            {
              term: "未来仍欠（未清偿）",
              detail: debt !== null ? debt + " 分钟（账本估计）" : "账本还没有这项记录",
              tone: "warm",
            },
          ]
        : [],
    emptyNote: null,
    offer: applied
      ? { action: "view", label: "预览延期的影响", note: null }
      : selectPlanSelectOffer(state, plan),
    previewHref,
    changeSetId: changeSet?.id ?? null,
    changeSetLabel: changeSet?.label ?? null,
    changeSetHashShort: changeSet ? changeSet.hash.slice(0, 12) : null,
    changeSetStaleReasons: applied ? [] : freshness.reasons,
    targetScope: target?.scope ?? null,
      externalCommitmentUnchanged: externalCommitmentUnchanged(plan, changeSet),
      remainingFutureDebtMinutes: debt,
      planStatus: plan.status,
      applied,
    };
}

export interface PlanSurfaceChip {
  kind: "meeting" | "delivery" | "protected" | "modification";
  label: string;
  tone: "default" | "warm" | "ok";
}

function selectFixedCommitmentsOnDate(state: DomainState, date: string) {
  return Object.values(state.commitments).filter(
    (commitment) =>
      commitment.status === "active" &&
      commitment.mobility === "fixed" &&
      commitment.schedule?.date === date,
  );
}

function selectProtectedBlocksForIntent(state: DomainState, intentId: EntityId, date: string) {
  return Object.values(state.protectedBlocks)
    .filter(
      (block) =>
        block.status === "active" &&
        block.intentId === intentId &&
        isoDateOf(block.range.start) <= date &&
        date <= isoDateOf(block.range.end),
    )
    .sort((a, b) => minuteOfDay(a.range.start) - minuteOfDay(b.range.start));
}

function selectChangeSetsForIntent(state: DomainState, intentId: EntityId): ChangeSet[] {
  const rows: ChangeSet[] = [];
  for (const plan of Object.values(state.plans)) {
    if (plan.intentId !== intentId) continue;
    for (const changeSet of Object.values(state.changeSets)) {
      if (changeSet.planId === plan.id) rows.push(changeSet);
    }
  }
  return rows;
}

function selectWindowLabel(state: DomainState, date: string): string {
  let latestDeadline: string | null = null;
  for (const commitment of Object.values(state.commitments)) {
    if (
      commitment.status !== "active" ||
      !commitment.schedule ||
      commitment.schedule.date !== date ||
      !commitment.deadline
    ) {
      continue;
    }
    if (!latestDeadline || commitment.deadline > latestDeadline) latestDeadline = commitment.deadline;
  }
  return latestDeadline ? formatIsoTime(latestDeadline) + " 前" : "今日";
}

function modificationChip(kind: ModificationKind): PlanSurfaceChip {
  switch (kind) {
    case "none":
      return { kind: "modification", label: "方案未执行", tone: "warm" };
    case "inFlight":
      return { kind: "modification", label: "修改正在执行", tone: "warm" };
    case "unknown":
      return { kind: "modification", label: "执行结果未知", tone: "warm" };
    case "verified":
      return { kind: "modification", label: "方案已应用 · 节省未测量", tone: "ok" };
    case "failed":
      return { kind: "modification", label: "上次修改未完成", tone: "warm" };
  }
}

function modificationShortWord(kind: ModificationKind): string {
  switch (kind) {
    case "none":
      return "没有执行任何变更";
    case "inFlight":
      return "修改正在执行";
    case "unknown":
      return "上次修改结果未知";
    case "verified":
      return "已有一次已批准的修改 · 实际节省未测量";
    case "failed":
      return "上次修改未完成";
  }
}

function buildModificationFootnote(state: DomainState, intentId: EntityId, date: string): string {
  const meetingPart =
    selectFixedCommitmentsOnDate(state, date).length > 0 ? "会议不动" : "会议状态以账本为准";
  const intentChangeSets = selectChangeSetsForIntent(state, intentId);
  const deliverySafe = intentChangeSets.every((changeSet) =>
    changeSet.objectDiffs.every((diff) => SAFE_DIFF_FIELDS.has(diff.field)),
  );
  const deadlinePart = deliverySafe ? "期限不变" : "变更范围以变更集为准";
  const word = modificationShortWord(selectModificationView(state).kind);
  return meetingPart + " · " + deadlinePart + " · " + word;
}

function intentFailView(
  reason: PlanIntentFailReason,
): { title: string; detail: string } {
  switch (reason) {
    case "malformedQuery":
      return {
        title: "意图链接无效",
        detail: "URL 中的 intentId 为空或重复；未选择任何意图，也不提供方案操作。",
      };
    case "explicitIntentNotFound":
      return {
        title: "意图链接无效",
        detail: "URL 中的 intentId 在共享状态中没有对应的已保存意图；不会回退到示例意图，也不提供方案操作。",
      };
    case "explicitIntentNotSaved":
      return {
        title: "意图尚未保存",
        detail: "URL 中的 intentId 对应的意图已废弃或尚未确认；不回退到其他意图，也不提供方案操作。",
      };
    case "noApplicableIntent":
      return {
        title: "还没有可用的意图",
        detail: "共享状态中没有任何已保存的意图，因此没有可显示的方案。",
      };
    case "intentDateUnknown":
      return {
        title: "意图日期尚未确认",
        detail: "这条意图的日期尚未确认或无效，未借用其他意图的时间，也不提供方案操作。",
      };
  }
}

export interface PlanSurfaceFailModel {
  ready: false;
  reason: PlanIntentFailReason;
  explicitQuery: boolean;
  title: string;
  detail: string;
}

export interface PlanSurfaceReadyModel {
  ready: true;
  intentId: EntityId;
  intentSource: "explicit" | "fixture" | "latestSaved";
  dateLabel: string;
  windowLabel: string;
  capacity: CapacityView;
  capacityHeadline: string;
  chips: PlanSurfaceChip[];
  cardA: PlanCardView;
  cardB: PlanCardView;
  modificationKind: ModificationKind;
  modificationFootnote: string;
}

export type PlanSurfaceModel = PlanSurfaceFailModel | PlanSurfaceReadyModel;

export function buildPlanSurfaceModel(state: DomainState, explicitIntentIds: readonly string[]): PlanSurfaceModel {
  const resolution = resolvePlanIntent(state, explicitIntentIds);
  if (!resolution.ok) {
    const view = intentFailView(resolution.reason);
    return { ready: false, reason: resolution.reason, explicitQuery: resolution.explicitQuery, ...view };
  }
  const intentId = resolution.intentId;
  const calendar = resolution.source === "explicit" ? resolveIntentCalendarContext(state, state.intents[intentId]) : null;
  if (calendar && !calendar.ok) {
    return { ready: false, reason: calendar.reason, explicitQuery: true, ...intentFailView(calendar.reason) };
  }
  const date = calendar?.date ?? selectSurfaceDate(state);
  const capacity = selectCapacityView(state, date);
  const windowLabel = selectWindowLabel(state, date);
  const capacityHeadline =
    windowLabel +
    "可用 " +
    capacity.capacityMinutes +
    " 分钟；" +
    (capacity.kind === "unknown" ? formatCapacityWarning(capacity) + "。" : "当前预计投入 " + capacity.committedKnownMinutes + " 分钟。");
  const fixed = selectFixedCommitmentsOnDate(state, date);
  const intentChangeSets = selectChangeSetsForIntent(state, intentId);
  const deliverySafe = intentChangeSets.every((changeSet) =>
    changeSet.objectDiffs.every((diff) => SAFE_DIFF_FIELDS.has(diff.field)),
  );
  const protectedBlock = selectProtectedBlocksForIntent(state, intentId, date)[0] ?? null;
  const chips: PlanSurfaceChip[] = [
    fixed.length > 0
      ? { kind: "meeting", label: "会议不动", tone: "default" }
      : { kind: "meeting", label: "当日没有固定约定", tone: "default" },
    deliverySafe
      ? { kind: "delivery", label: "交付标准不变", tone: "default" }
      : { kind: "delivery", label: "交付范围受变更影响", tone: "warm" },
    protectedBlock
      ? {
          kind: "protected",
          label:
            formatMinuteOfDay(minuteOfDay(protectedBlock.range.start)) +
            "—" +
            formatMinuteOfDay(minuteOfDay(protectedBlock.range.end)) +
            " 静驻 · " + protectedBlock.range.timezone,
          tone: "default",
        }
      : { kind: "protected", label: "当日没有已保存的静驻", tone: "default" },
    modificationChip(selectModificationView(state).kind),
  ];
  const context = {
    windowLabel,
    capacityMinutes: capacity.capacityMinutes,
    committedLabel: capacity.kind === "unknown" ? "含未知投入" : capacity.committedKnownMinutes + " 分钟",
  };
  return {
    ready: true,
    intentId,
    intentSource: resolution.source,
    dateLabel: formatSurfaceDateLabel(date) + (calendar ? " · " + (calendar.timezone ?? "时区未知") : ""),
    windowLabel,
    capacity,
    capacityHeadline,
    chips,
    cardA: buildPlanCardView(state, intentId, "A", context),
    cardB: buildPlanCardView(state, intentId, "B", context),
    modificationKind: selectModificationView(state).kind,
    modificationFootnote: buildModificationFootnote(state, intentId, date),
  };
}

export interface NowSurfaceFailModel {
  ready: false;
  reason: PlanIntentFailReason;
  explicitQuery: boolean;
  title: string;
  detail: string;
}

export interface NowSurfaceReadyModel {
  ready: true;
  intentId: EntityId;
  intentSource: "explicit" | "fixture" | "latestSaved";
  dateLabel: string;
  capacity: CapacityView;
  heroRangeLabel: string | null;
  heroNote: string;
  warningText: string;
  warningTone: "warm" | "ok";
  modificationFootnote: string;
  planHref: string;
}

export type NowSurfaceModel = NowSurfaceFailModel | NowSurfaceReadyModel;

export function buildNowSurfaceModel(state: DomainState, explicitIntentIds: readonly string[]): NowSurfaceModel {
  const resolution = resolvePlanIntent(state, explicitIntentIds);
  if (!resolution.ok) {
    const view = intentFailView(resolution.reason);
    return { ready: false, reason: resolution.reason, explicitQuery: resolution.explicitQuery, ...view };
  }
  const intentId = resolution.intentId;
  const date = selectSurfaceDate(state);
  const capacity = selectCapacityView(state, date);
  const block = selectProtectedBlocksForIntent(state, intentId, date)[0] ?? null;
  const heroRangeLabel = block
    ? formatMinuteOfDay(minuteOfDay(block.range.start)) + "—" + formatMinuteOfDay(minuteOfDay(block.range.end))
    : null;
  const heroNote = block
    ? block.purpose
      ? "用途：" + block.purpose + "。不自动填满。"
      : "不自动填满。没有用途，也成立。"
    : "这一天还没有已保存的保护时段；空白不自动意味着可占用。";
  return {
    ready: true,
    intentId,
    intentSource: resolution.source,
    dateLabel: formatSurfaceDateLabel(date),
    capacity,
    heroRangeLabel,
    heroNote,
    warningText: formatCapacityWarning(capacity),
    warningTone: capacity.kind === "deficit" || capacity.kind === "unknown" ? "warm" : "ok",
    modificationFootnote: buildModificationFootnote(state, intentId, date),
    planHref: mobilePlanHref(intentId),
  };
}

export function formatSurfaceDateLabel(date: string): string {
  const parts = date.split("-");
  return (
    String(Number(parts[1])) +
    " 月 " +
    String(Number(parts[2])) +
    " 日 · " +
    WEEKDAY_LABELS[weekdayIndexOf(date)]
  );
}

export function formatMobileCapacityStrip(capacity: CapacityView): string {
  if (capacity.kind === "unknown") {
    return capacity.capacityMinutes + " 分钟可用 / " + capacity.unknownEffortCount + " 项预计投入未知";
  }
  return capacity.capacityMinutes + " 分钟可用 / " + capacity.committedKnownMinutes + " 分钟预计投入";
}

export function mobilePlanHref(intentId: EntityId): string {
  return "/m/plan?intentId=" + encodeURIComponent(intentId);
}

export function mobileAuthHref(intentId: EntityId, kind: PlanKind): string {
  return "/m/auth?intentId=" + encodeURIComponent(intentId) + "&kind=" + kind;
}

export type ExplicitIntentRequest =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "explicit"; intentId: string };

export function parseExplicitIntentValues(values: readonly string[]): ExplicitIntentRequest {
  if (values.length === 0) return { kind: "none" };
  if (values.length > 1) return { kind: "invalid" };
  const value = values[0] ?? "";
  return value.trim() === "" ? { kind: "invalid" } : { kind: "explicit", intentId: value };
}

export function selectWorkflowIntent(
  state: DomainState,
  request: ExplicitIntentRequest,
): Intent | null {
  if (request.kind === "invalid") return null;
  if (request.kind === "explicit") {
    const exact = state.intents[request.intentId];
    return exact !== undefined && exact.status === "saved" ? exact : null;
  }
  const seeded = state.intents[FIXTURE_IDS.intent];
  if (seeded && seeded.status === "saved") return seeded;
  const saved = Object.values(state.intents).filter((entry) => entry.status === "saved");
  if (saved.length === 0) return null;
  return saved.reduce((a, b) => (a.revision >= b.revision ? a : b));
}

export function explicitIntentRequestKey(request: ExplicitIntentRequest): string {
  return request.kind === "explicit" ? "intent:" + request.intentId : request.kind;
}

export type PlanKindRequest = { kind: "invalid" } | { kind: "valid"; value: PlanKind };

export function parsePlanKindValues(values: readonly string[], legacyDelay: boolean): PlanKindRequest {
  if (values.length > 1) return { kind: "invalid" };
  if (values.length === 0) {
    return legacyDelay ? { kind: "valid", value: "B" } : { kind: "valid", value: "A" };
  }
  const value = values[0] ?? "";
  if (value === "A") return { kind: "valid", value: "A" };
  if (value === "B") return { kind: "valid", value: "B" };
  return { kind: "invalid" };
}

export function planKindRequestKey(planKind: PlanKindRequest): string {
  return planKind.kind === "valid" ? "kind:" + planKind.value : planKind.kind;
}

export function workflowRequestKey(
  request: ExplicitIntentRequest,
  planKind: PlanKindRequest,
): string {
  return explicitIntentRequestKey(request) + ":" + planKindRequestKey(planKind);
}

export function selectLatestApprovalForPlan(state: DomainState, planId: EntityId): Approval | null {
  const approvals = Object.values(state.approvals)
    .filter((a) => a.planId === planId && (a.status === "valid" || a.status === "consumed"))
    .sort((a, b) => a.revision - b.revision);
  return approvals.length > 0 ? approvals[approvals.length - 1] : null;
}

export function selectLatestOperationForApproval(state: DomainState, approvalId: EntityId): Operation | null {
  const operations = Object.values(state.operations)
    .filter((o) => o.approvalId === approvalId)
    .sort((a, b) => a.revision - b.revision);
  return operations.length > 0 ? operations[operations.length - 1] : null;
}

export function selectUniqueDraftRef(
  state: DomainState,
  operationId: EntityId,
  resultRefs: readonly EntityId[],
): EntityId | null {
  const refs = resultRefs.filter((ref) => {
    const draft = state.drafts[ref];
    return draft !== undefined && draft.operationId === operationId;
  });
  return refs.length === 1 ? refs[0] : null;
}

export function selectFutureDebtLedgerForOperation(state: DomainState, operationId: EntityId): LedgerEntry | null {
  const entries = state.ledger.filter(
    (entry) => entry.operationId === operationId && entry.category === "futureDebt",
  );
  return entries.length > 0 ? entries[entries.length - 1] : null;
}

export function deferReceiptComplete(operation: Operation): boolean {
  return operation.stepReceipts.some(
    (receipt) => receipt.actionKind === "deferCommitment" && receipt.status === "completed",
  );
}

export function planBCompletionConfirmed(state: DomainState, plan: Plan | null, operation: Operation | null): boolean {
  if (!plan || plan.kind !== "B" || !operation || operation.status !== "verified" || !deferReceiptComplete(operation)) return false;
  const approval = state.approvals[operation.approvalId];
  const changeSet = state.changeSets[operation.changeSetId];
  const ledger = selectFutureDebtLedgerForOperation(state, operation.id);
  const deferDiff = changeSet?.objectDiffs.find((diff) => diff.objectId === plan.commitmentId && diff.field === "schedule.date");
  return !!approval && approval.planId === plan.id && approval.changeSetId === operation.changeSetId &&
    approval.status === "consumed" && !!changeSet && changeSet.planId === plan.id &&
    changeSet.hash === operation.changeSetHash && approval.changeSetHash === operation.changeSetHash &&
    operation.readback !== null && operation.readback.items.length > 0 &&
    operation.readback.items.every((item) => item.matchesExpected === true) &&
    !!deferDiff && typeof deferDiff.after === "string" &&
    operation.readback.items.some((item) => item.objectId === plan.commitmentId && item.field === "schedule.date" && item.value === deferDiff.after) &&
    ledger !== null && ledger.commitmentId === plan.commitmentId && ledger.minutes !== null && ledger.effectiveDate === deferDiff.after;
}
