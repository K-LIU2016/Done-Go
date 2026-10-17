import { useRef, useState, useSyncExternalStore } from "react";
import type { ReactElement } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useDomainState } from "../../data/react.ts";
import type {
  Approval,
  ChangeSet,
  Draft,
  DraftSection,
  GrantKey,
  Intent,
  LedgerEntry,
  Operation,
  Plan,
  PlanKind,
} from "../../domain/types.ts";
import {
  deferReceiptComplete,
  planBCompletionConfirmed,
  selectChangeSetFreshness,
  parseExplicitIntentValues,
  parsePlanKindValues,
  selectFutureDebtLedgerForOperation,
  selectLatestApprovalForPlan,
  selectLatestChangeSetForPlan,
  selectLatestOperationForApproval,
  selectLatestPlanForKind,
  selectUniqueDraftRef,
  selectWorkflowIntent,
  workflowRequestKey,
} from "../s04-plan/planSurfaces.ts";
import type {
  ExplicitIntentRequest,
  PlanKindRequest,
} from "../s04-plan/planSurfaces.ts";
import { useDomainRuntime } from "../../runtime/index.ts";
import type { DomainRuntimeState, ReadyDomainRuntime } from "../../runtime/index.ts";
import {
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  Check,
  Plus,
  RefreshCcw,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import "./s05-preview.css";
import { assertReviewedProposal, preparePlan, reviewedProposal } from "../s04-plan/planPreparation.ts";
import { assertWorkflowResumeTarget, workflowAttemptKey, workflowCommands } from "../s04-plan/workflow-command.ts";

const EXCLUSIONS = ["外部约会", "邮件发送", "付款与购买"];

type RuntimeWorkflowPhase = "idle" | "running" | "refMissing" | "failed";

const S05_DRAFT_STATUS_WORDS: Record<Draft["status"], string> = {
  generating: "生成中",
  pendingReview: "待检查",
  partiallyConfirmed: "部分确认",
  confirmed: "已确认",
  sent: "已发送",
  withdrawn: "已撤回",
};

function buildBackHref(
  pathname: string,
  request: ExplicitIntentRequest,
  planKind: PlanKind | null,
): string {
  const base = pathname.startsWith("/m/") ? "/m/plan" : "/plan";
  if (request.kind !== "explicit" || planKind === null) return base;
  const params = new URLSearchParams();
  params.set("intentId", request.intentId);
  params.set("kind", planKind);
  return base + "?" + params.toString();
}

function useS05WorkflowState(
  runtime: ReadyDomainRuntime,
  intentRequest: ExplicitIntentRequest,
  planKindRequest: PlanKindRequest,
): {
  intent: Intent | null;
  plan: Plan | null;
  changeSet: ChangeSet | null;
  approval: Approval | null;
  operation: Operation | null;
  draftRef: string | null;
  draft: Draft | undefined;
  futureDebtLedger: LedgerEntry | null;
} {
  const state = useDomainState(runtime.store);
  const planKind = planKindRequest.kind === "valid" ? planKindRequest.value : null;
  const intent = selectWorkflowIntent(state, intentRequest);
  const plan =
    intent === null || planKind === null
      ? null
      : selectLatestPlanForKind(state, intent.id, planKind);
  const changeSet = plan ? selectLatestChangeSetForPlan(state, plan.id) : null;
  const approval = plan ? selectLatestApprovalForPlan(state, plan.id) : null;
  const operation = approval ? selectLatestOperationForApproval(state, approval.id) : null;
  const draftRef =
    planKind === "A" && operation && operation.status === "verified"
      ? selectUniqueDraftRef(state, operation.id, operation.resultRefs)
      : null;
  const draft = draftRef !== null ? state.drafts[draftRef] : undefined;
  const futureDebtLedger =
    planKind === "B" && operation && planBCompletionConfirmed(state, plan, operation)
      ? selectFutureDebtLedgerForOperation(state, operation.id)
      : null;
  return { intent, plan, changeSet, approval, operation, draftRef, draft, futureDebtLedger };
}

function S05DomainPill({
  runtime,
  phase,
  intentRequest,
  planKindRequest,
}: {
  runtime: ReadyDomainRuntime;
  phase: RuntimeWorkflowPhase;
  intentRequest: ExplicitIntentRequest;
  planKindRequest: PlanKindRequest;
}): ReactElement {
  const { draftRef, futureDebtLedger } = useS05WorkflowState(
    runtime,
    intentRequest,
    planKindRequest,
  );
  const planKind = planKindRequest.kind === "valid" ? planKindRequest.value : null;
  const approved =
    phase === "idle" &&
    ((planKind === "A" && draftRef !== null) ||
      (planKind === "B" && futureDebtLedger !== null));
  return (
    <span
      className="s05-pill"
      data-s05-domain-status={approved ? "verified" : "pending"}
    >
      <ShieldCheck size={14} aria-hidden="true" />
      {approved
        ? planKind === "B"
          ? "已批准 · 已推迟承诺"
          : "已批准 · 共享草稿"
        : planKind === "B"
          ? "待批准 · 延期方案"
          : planKind === null
            ? "链接无效 · 未选择方案"
            : "待批准 · 准备方案"}
    </span>
  );
}

function hashS05Text(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return value.length.toString(16) + "-" + (hash >>> 0).toString(16);
}

function S05DraftSectionEditor({
  runtime,
  draft,
  section,
}: {
  runtime: ReadyDomainRuntime;
  draft: Draft;
  section: DraftSection;
}): ReactElement {
  const [edit, setEdit] = useState<{
    text: string;
    baseRevision: Draft["revision"];
    baseContentVersion: DraftSection["contentVersion"];
  } | null>(null);
  const [saveFailed, setSaveFailed] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const runningRef = useRef(false);

  const value = edit !== null ? edit.text : section.content;

  const submitEdit = async (): Promise<void> => {
    if (runningRef.current || edit === null) return;
    const submitted = edit;
    runningRef.current = true;
    setSaving(true);
    setSaveFailed(null);
    try {
      const result = await runtime.store.execute({
        type: "editDraftSection",
        commandId:
          "s05-editDraftSection-" + draft.id + "-s" + section.id +
          "-r" + submitted.baseRevision +
          "-cv" + submitted.baseContentVersion +
          "-" + hashS05Text(submitted.text),
        entityId: draft.id,
        expectedRevision: submitted.baseRevision,
        actor: "user",
        issuedAt: new Date().toISOString(),
        sectionId: section.id,
        expectedContentVersion: submitted.baseContentVersion,
        content: submitted.text,
      });
      if (!result.ok) {
        throw new Error(result.code + ": " + result.reason);
      }
      setEdit((current) => (current === submitted ? null : current));
      setSaveFailed(null);
    } catch (error) {
      setSaveFailed(error instanceof Error ? error.message : String(error));
    } finally {
      runningRef.current = false;
      setSaving(false);
    }
  };

  return (
    <div
      className="s05-draft-section"
      data-section-id={section.id}
      data-content-version={section.contentVersion}
    >
      <h3>{section.title}</h3>
      <label className="s05-draft-field">
        <span className="s05-draft-label">分节内容（可直接修改，逐节保存）</span>
        <textarea
          className="s05-draft-textarea"
          aria-label={"草稿分节：" + section.title}
          rows={4}
          value={value}
          onChange={(event) => {
            setEdit((prev) => ({
              text: event.target.value,
              baseRevision: prev !== null ? prev.baseRevision : draft.revision,
              baseContentVersion:
                prev !== null ? prev.baseContentVersion : section.contentVersion,
            }));
            if (saveFailed !== null) setSaveFailed(null);
          }}
        />
      </label>
      {edit !== null && !saving ? (
        <button type="button" className="s05-secondary" onClick={() => void submitEdit()}>
          <Check size={15} aria-hidden="true" />
          保存此分节
        </button>
      ) : null}
      {saving ? (
        <p className="s05-draft-note" data-section-save="running">
          正在通过共享运行时保存此分节…
        </p>
      ) : null}
      {saveFailed !== null ? (
        <div role="alert" data-section-save="failed">
          <p className="s05-withdrawn">分节保存未完成：{saveFailed}</p>
          <button type="button" className="s05-secondary" onClick={() => void submitEdit()}>
            <RotateCcw size={15} aria-hidden="true" />
            重试保存
          </button>
        </div>
      ) : null}
      {edit === null && saveFailed === null ? (
        <p className="s05-draft-note" data-section-save="saved">
          已保存 · 内容版本 {section.contentVersion}
        </p>
      ) : null}
    </div>
  );
}

function S05RuntimeApproval({
  runtime,
  phase,
  onPhaseChange,
  intentRequest,
  planKindRequest,
}: {
  runtime: ReadyDomainRuntime;
  phase: RuntimeWorkflowPhase;
  onPhaseChange: (phase: RuntimeWorkflowPhase) => void;
  intentRequest: ExplicitIntentRequest;
  planKindRequest: PlanKindRequest;
}): ReactElement {
  const navigate = useNavigate();
  const { intent, plan, operation, draftRef, draft, futureDebtLedger } =
    useS05WorkflowState(runtime, intentRequest, planKindRequest);
  const [failureReason, setFailureReason] = useState<string | null>(null);
  const workflow = workflowCommands(runtime.store);
  const workflowSnapshot = useSyncExternalStore(workflow.subscribe, workflow.getSnapshot);
  const proposal = reviewedProposal(runtime.store.getState(), plan);
  const needsPreparation = !proposal || (!operation && !selectChangeSetFreshness(runtime.store.getState(), proposal.changeSet).fresh);
  const runningRef = useRef(false);
  const setPhase = onPhaseChange;

  if (planKindRequest.kind === "invalid") {
    return (
      <div
        className="s05-runtime-approval"
        data-runtime-surface="s05-approval"
        data-s05-kind-routing="fail-closed"
      >
        <p className="s05-withdrawn" role="alert">
          链接无效：URL 中的 kind 为空、重复或未知；未选择方案类型，也不提供批准操作。
        </p>
      </div>
    );
  }
  const planKind: PlanKind = planKindRequest.value;

  if (intent === null && intentRequest.kind !== "none") {
    return (
      <div
        className="s05-runtime-approval"
        data-runtime-surface="s05-approval"
        data-s05-intent-routing="fail-closed"
      >
        <p className="s05-withdrawn" role="alert">
          {intentRequest.kind === "invalid"
            ? "意图链接无效：URL 中的 intentId 为空或重复；未选择任何意图，也不提供批准操作。"
            : "意图链接无效：共享状态中没有与该 intentId 完全一致的已保存意图；未选择其他意图，也不提供批准操作。"}
        </p>
      </div>
    );
  }

  const startWorkflow = async (): Promise<void> => {
    if (runningRef.current) return;
    runningRef.current = true;
    setPhase("running");
    setFailureReason(null);
    try {
      const store = runtime.store;
      const requireOk = <T,>(result: { ok: true; data: T } | { ok: false; code: string; reason: string }): T => {
        if (!result.ok) {
          throw new Error(result.code + ": " + result.reason);
        }
        return result.data;
      };

      let snapshot = store.getState();
      const currentIntent = selectWorkflowIntent(snapshot, intentRequest);
      if (!currentIntent) {
        throw new Error(
          intentRequest.kind === "none"
            ? "共享状态中没有可用的已保存意图。"
            : "显式意图无效：共享状态中没有与该 intentId 完全一致的已保存意图。",
        );
      }
      const workflowKey = workflowAttemptKey(currentIntent.id, planKind);
      const resumedAttempt = workflow.getSnapshot().pending;
      const resumedStage = await workflow.retryPending(workflowKey);
      if (resumedStage === "selectPlan") { setPhase("idle"); return; }
      snapshot = store.getState();
      const reviewed = resumedStage ? reviewedProposal(snapshot, selectLatestPlanForKind(snapshot, currentIntent.id, planKind)) : proposal;
      assertWorkflowResumeTarget(snapshot, resumedAttempt, reviewed?.plan.id);
      if (needsPreparation) {
        await preparePlan(store, currentIntent.id, planKind);
        setPhase("idle");
        return;
      }
      const { plan: currentPlan } = assertReviewedProposal(snapshot, reviewed);

      const grants: GrantKey[] =
        planKind === "B"
          ? ["internalReschedule"]
          : ["readMaterial", "createLocalDraft", "updateEstimate"];

      snapshot = store.getState();
      let currentApproval = selectLatestApprovalForPlan(snapshot, currentPlan.id);
      if (!currentApproval) {
        const changeSet = assertReviewedProposal(snapshot, reviewed).changeSet;
        const data = requireOk(
          await workflow.run(workflowKey, {
            type: "grantApproval",
            commandId: "s05-grantApproval-" + currentPlan.id + "-kind" + planKind,
            entityId: currentPlan.id,
            expectedRevision: currentPlan.revision,
            actor: "user",
            issuedAt: new Date().toISOString(),
            changeSetId: changeSet.id,
            grants,
          }, grants),
        );
        if (data.approval.planId !== currentPlan.id) {
          throw new Error("grantApproval 返回的批准不属于当前方案，已停止后续步骤。");
        }
        currentApproval = data.approval;
      }
      if (
        planKind === "B" &&
        !currentApproval.grantedActions.includes("internalReschedule")
      ) {
        throw new Error("当前批准缺少内部改期授权（internalReschedule），已停止后续步骤。");
      }

      snapshot = store.getState();
      let currentOperation = selectLatestOperationForApproval(snapshot, currentApproval.id);
      if (!currentOperation) {
        const data = requireOk(
          await workflow.run(workflowKey, {
            type: "startOperation",
            commandId: "s05-startOperation-" + currentApproval.id + "-kind" + planKind,
            entityId: currentApproval.id,
            expectedRevision: currentApproval.revision,
            actor: "user",
            issuedAt: new Date().toISOString(),
            approvalId: currentApproval.id,
          }, grants),
        );
        if (data.operation.approvalId !== currentApproval.id) {
          throw new Error("startOperation 返回的操作不属于当前批准，已停止后续步骤。");
        }
        currentOperation = data.operation;
      }

      requireOk(
        await workflow.run(workflowKey, {
          type: "readbackOperation",
          commandId: "s05-readbackOperation-" + currentOperation.id,
          entityId: currentOperation.id,
          expectedRevision: currentOperation.revision,
          actor: "user",
          issuedAt: new Date().toISOString(),
        }, grants),
      );

      const finalState = store.getState();
      const finalOperation = finalState.operations[currentOperation.id];
      if (!finalOperation || finalOperation.status !== "verified") {
        throw new Error(
          finalOperation
            ? "操作未通过读回验证：" + finalOperation.status
            : "操作在共享状态中不存在。",
        );
      }
      if (planKind === "A") {
        const ref = selectUniqueDraftRef(finalState, finalOperation.id, finalOperation.resultRefs);
        if (ref === null) {
          setPhase("refMissing");
          return;
        }
      } else {
        const ledger = selectFutureDebtLedgerForOperation(finalState, finalOperation.id);
        if (ledger === null || !deferReceiptComplete(finalOperation)) {
          throw new Error(
            "操作已通过读回验证，但缺少已完成的推迟承诺回执或关联的未来欠账台账记录。",
          );
        }
      }
      setPhase("idle");
    } catch (error) {
      setPhase("failed");
      setFailureReason(error instanceof Error ? error.message : String(error));
    } finally {
      runningRef.current = false;
    }
  };

  const bComplete =
    planKind === "B" &&
    phase === "idle" &&
    planBCompletionConfirmed(runtime.store.getState(), plan, operation) &&
    futureDebtLedger !== null;

  if (bComplete && operation !== null && futureDebtLedger !== null) {
    return (
      <div
        className="s05-runtime-approval"
        role="status"
        data-s05-b-approved="true"
        data-operation-id={operation.id}
      >
        <p className="s05-draft-note">
          已批准并完成本次推迟承诺；授权已使用，不会重复授予或重复记账。
        </p>
        <p className="s05-draft-note">
          台账记录：未来欠账{" "}
          {futureDebtLedger.minutes !== null
            ? futureDebtLedger.minutes + " 分钟"
            : "时长未记录"}
          ，生效 {futureDebtLedger.effectiveDate}。
          {plan !== null && plan.summary.netSavingClaim === "none"
            ? "没有净节省"
            : "净节省未经测量"}
          ，也没有写入外部日历。
        </p>
      </div>
    );
  }

  const showSharedDraft =
    planKind === "A" &&
    phase !== "failed" &&
    phase !== "running" &&
    draftRef !== null &&
    draft !== undefined &&
    operation !== null;

  if (showSharedDraft && draft && operation && draftRef !== null) {
    return (
      <article className="s05-card s05-draft" role="status" data-runtime-handoff data-draft-id={draftRef} data-operation-id={operation.id}>
        <div className="s05-draft-head">
          <span className="s05-draft-pill">共享领域草稿 · {S05_DRAFT_STATUS_WORDS[draft.status]}</span>
        </div>
        {intentRequest.kind === "explicit" && intent !== null ? (
          <p className="s05-draft-note" data-s05-selected-intent={intent.id}>
            已选择意图 {intent.id} · 原文：{intent.verbatim}
          </p>
        ) : null}
        {draft.status === "withdrawn" || draft.status === "sent" ? (
          <p className="s05-draft-note" data-draft-readonly={draft.status}>
            草稿状态为{S05_DRAFT_STATUS_WORDS[draft.status]}
            ，内容不可编辑；共享运行时会拒绝新的分节修改。
          </p>
        ) : (
          draft.sections.map((section) => (
            <S05DraftSectionEditor
              key={draftRef + ":" + section.id}
              runtime={runtime}
              draft={draft}
              section={section}
            />
          ))
        )}
        <button
          type="button"
          className="s05-primary"
          data-s05-open-workspace
          onClick={() =>
            navigate(
              "/workspace?draftId=" + encodeURIComponent(draftRef) +
                "&operationId=" + encodeURIComponent(operation.id),
            )
          }
        >
          打开工作台
        </button>
        <p className="s05-draft-note" data-withdraw="unavailable">
          本屏不提供撤回操作；可在工作台管理草稿并撤回。
        </p>
      </article>
    );
  }

  return (
    <div className="s05-runtime-approval" data-runtime-surface="s05-approval">
      {workflowSnapshot.pending && <p className="s05-withdrawn" role="status">存在未决操作，重试会原样重发命令并先确认结果；不会改换方案或重新批准。此恢复仅保留于当前应用运行会话。</p>}
      {intentRequest.kind === "explicit" && intent !== null ? (
        <p className="s05-draft-note" data-s05-selected-intent={intent.id}>
          已选择意图 {intent.id} · 原文：{intent.verbatim}
        </p>
      ) : null}
      {planKind === "B" ? (
        <p className="s05-draft-note" data-s05-b-scope="internal-reschedule">
          批准范围：仅内部改期（internalReschedule）；没有净节省声明，也不写入外部日历。
        </p>
      ) : null}
{phase !== "failed" ? (
        <button
          type="button"
          className="s05-primary"
          data-s05-approve="shared-runtime"
          disabled={phase === "running" || workflowSnapshot.busy}
          onClick={() => void startWorkflow()}
        >
          {workflowSnapshot.pending ? "原样重试未决操作" : needsPreparation ? "准备方案并预览" : planKind === "B" ? "批准并推迟承诺" : "批准并准备草稿"}
          <ArrowRight size={18} aria-hidden="true" />
        </button>
      ) : null}
      {phase === "running" ? (
        <p className="s05-withdrawn" role="status" data-runtime-phase="running">
          正在通过共享运行时执行批准：创建方案批准与操作，并等待读回验证…
        </p>
      ) : null}
      {planKind === "A" &&
      (phase === "refMissing" ||
        (operation && operation.status === "verified" && draftRef === null)) ? (
        <p className="s05-withdrawn" role="status" data-runtime-boundary="draft-ref-missing">
          操作已完成并通过读回验证，但无法通过领域草稿引用（resultRefs）唯一确定草稿，暂不能进入工作台。
        </p>
      ) : null}
      {planKind === "B" &&
      operation !== null &&
      operation.status === "verified" &&
      futureDebtLedger === null &&
      phase !== "failed" ? (
        <p className="s05-withdrawn" role="status" data-runtime-boundary="b-ledger-missing">
          操作已通过读回验证，但未找到关联的未来欠账台账记录；不能视为延期已完成。
        </p>
      ) : null}
      {operation && operation.status === "failed" && phase !== "failed" ? (
        <p className="s05-withdrawn" role="status" data-runtime-boundary="operation-failed">
          共享运行时中的操作标记为失败：{operation.lastError ?? "原因未知"}。
        </p>
      ) : null}
      {phase === "failed" ? (
        <div role="alert" data-runtime-phase="failed">
          <p className="s05-withdrawn">共享运行时执行未完成：{failureReason}</p>
          {!workflowSnapshot.pending && <p className="s05-draft-note">没有结果未知的命令被锁定。若为版本冲突，请返回修改并重新预览；原方案与用户选择不会被这次失败覆盖。</p>}
          {!workflowSnapshot.pending && intent && <button type="button" className="s05-secondary" onClick={() => navigate("/plan?" + new URLSearchParams({ intentId: intent.id, kind: planKind }).toString())}>返回方案重新预览</button>}
          {(!failureReason?.startsWith("REVISION_CONFLICT") || workflowSnapshot.pending) &&
          <button type="button" className="s05-secondary" onClick={() => void startWorkflow()}>
            <RotateCcw size={15} aria-hidden="true" />
            重试执行
          </button>}
        </div>
      ) : null}
    </div>
  );
}

function formatS05DiffValue(value: unknown): string {
  if (value === null || value === undefined) return "空";
  if (typeof value === "string") return value === "" ? "空" : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function S05PlanDiffCard({
  runtime,
  intentRequest,
  planKindRequest,
}: {
  runtime: ReadyDomainRuntime;
  intentRequest: ExplicitIntentRequest;
  planKindRequest: PlanKindRequest;
}): ReactElement {
  const { plan, changeSet, futureDebtLedger, draft } = useS05WorkflowState(
    runtime,
    intentRequest,
    planKindRequest,
  );
  if (plan === null || changeSet === null) {
    return (
      planKindRequest.kind === "valid" && planKindRequest.value === "B" ? (
        <p className="s05-withdrawn" role="status" data-s05-b-plan="pending">
          方案尚未生成：先准备方案，检查实际延期日期与未来负担，再单独批准内部改期。
        </p>
      ) : (
        <p className="s05-withdrawn" role="status" data-s05-a-plan="pending">
          方案尚未生成：先准备方案，检查实际变更，再单独批准读取材料、创建草稿与更新估计。
        </p>
      )
    );
  }
  return (
    <>
      <div className="s05-diff-scroll">
      <table className="s05-diff" data-s05-b-plan={plan.id} aria-label="方案对象变更对照">
        <colgroup><col className="s05-diff-object-col" /><col /><col /></colgroup>
        <thead><tr><th scope="col">对象</th><th scope="col">原状态</th><th scope="col">批准后</th></tr></thead>
        <tbody>
        {plan.kind === "A" ? (
          <tr className="s05-diff-row">
            <th scope="row">报告工作草稿</th>
            <td><span className="s05-before">{draft ? "已创建" : "尚未创建"}</span></td>
            <td><div className="s05-diff-result"><ArrowRight size={16} aria-hidden="true" /><span className="s05-after">{draft ? S05_DRAFT_STATUS_WORDS[draft.status] : "生成 · 待检查"}</span></div></td>
          </tr>
        ) : null}
        {changeSet.objectDiffs.map((diff) => (
          <tr className="s05-diff-row" key={diff.objectId + ":" + diff.field}>
            <th scope="row">{diff.displayName} · {diff.field === "effortEstimateMinutes" ? "预计人工投入" : diff.field === "schedule.date" ? "安排日期" : "变更内容"}</th>
            <td>
              <span className="s05-before">
                {formatS05DiffValue(diff.before)}
                {diff.field === "effortEstimateMinutes" ? " 分钟" : ""}
              </span>
            </td>
            <td><div className="s05-diff-result"><ArrowRight size={16} aria-hidden="true" />
              <span className="s05-after is-warm">
                {formatS05DiffValue(diff.after)}
                {diff.field === "effortEstimateMinutes" ? " 分钟" : ""}
              </span>
            </div></td>
          </tr>
        ))}
        <tr className="s05-diff-row">
          <th scope="row">外部日历、消息与交付</th>
          <td><span className="s05-before">没有变更</span></td>
          <td><div className="s05-diff-result"><ArrowRight size={16} aria-hidden="true" /><span className="s05-before">仍然没有变更</span></div></td>
        </tr>
        {plan.futureDebtMinutes > 0 ? (
          <tr className="s05-diff-row" data-s05-b-future-debt={plan.futureDebtMinutes}>
            <th scope="row">未来欠账（方案）</th>
            <td><span className="s05-before">原状态未提供</span></td>
            <td><div className="s05-diff-result"><Plus size={16} aria-hidden="true" />
              <span className="s05-after is-warm">
                {plan.futureDebtMinutes} 分钟
                {plan.summary.futureDebt !== null ? " · " + plan.summary.futureDebt : ""}
              </span>
            </div></td>
          </tr>
        ) : null}
        {futureDebtLedger !== null ? (
          <tr className="s05-diff-row" data-s05-b-ledger-id={futureDebtLedger.id}>
            <th scope="row">台账记录 · 未来欠账</th>
            <td><span className="s05-before">原状态未提供</span></td>
            <td><div className="s05-diff-result"><Plus size={16} aria-hidden="true" />
              <span className="s05-after is-warm">
                {futureDebtLedger.minutes !== null
                  ? futureDebtLedger.minutes + " 分钟"
                  : "时长未记录"}
                {" · 生效 " + futureDebtLedger.effectiveDate}
                {futureDebtLedger.note !== "" ? " · " + futureDebtLedger.note : ""}
              </span>
            </div></td>
          </tr>
        ) : null}
        </tbody>
      </table>
      </div>
      <p className="s05-draft-note" data-s05-b-boundary="no-external-write">
        {plan.summary.netSavingClaim === "none"
          ? "没有净节省。"
          : "净节省仅为估计，未经测量。"}
        没有写入外部日历。
      </p>
    </>
  );
}

export function S05Preview(): ReactElement {
  const runtime = useDomainRuntime();
  const location = useLocation();
  const legacyDelay =
    (location.state as { variant?: string } | null)?.variant === "delay";
  const searchParams = new URLSearchParams(location.search);
  const intentRequest = parseExplicitIntentValues(searchParams.getAll("intentId"));
  const planKindRequest = parsePlanKindValues(searchParams.getAll("kind"), legacyDelay);
  return (
    <S05NormalPreview
      key={workflowRequestKey(intentRequest, planKindRequest)}
      runtime={runtime}
      intentRequest={intentRequest}
      planKindRequest={planKindRequest}
    />
  );
}

function S05NormalPreview({
  runtime,
  intentRequest,
  planKindRequest,
}: {
  runtime: DomainRuntimeState;
  intentRequest: ExplicitIntentRequest;
  planKindRequest: PlanKindRequest;
}): ReactElement {
  const navigate = useNavigate();
  const location = useLocation();
  const [approvalPhase, setApprovalPhase] = useState<RuntimeWorkflowPhase>("idle");
  const planKind = planKindRequest.kind === "valid" ? planKindRequest.value : null;
  return (
    <section className="s05" data-page="s05" aria-label="变更预览 · 有限授权">
  <header className="s05-head">
        <h1 className="s05-title">授权这一次，不是以后每一次。</h1>
        <p className="s05-sub">所有会改变的对象，都先出现在这里。你批准的是具体范围。</p>
      </header>

      <div className="s05-grid">
        <div className="s05-main">
          <article className="s05-card" aria-label="变更对象">
  {runtime.status === "ready" ? (
  <S05DomainPill
            runtime={runtime.runtime}
            phase={approvalPhase}
            intentRequest={intentRequest}
            planKindRequest={planKindRequest}
          />
        ) : (
          <span className="s05-pill" data-runtime-state={runtime.status}>
            <ShieldCheck size={14} aria-hidden="true" />
            {planKind === "B"
              ? "待批准 · 延期方案"
              : planKind === null
                ? "链接无效 · 未选择方案"
                : "待批准 · 准备方案"}
          </span>
        )}
            <h2 className="s05-object">
              {planKind === "B" ? "推迟本次承诺" : "准备报告草稿"}
            </h2>
            <p className="s05-sub">{planKind === "B" ? "先核对实际延期日期与未来负担。只有批准后，内部安排才会改变。" : "只读取本次授权的材料，在静驻中生成未发送的草稿。"}</p>
            {planKindRequest.kind === "invalid" ? (
              <p className="s05-withdrawn" role="alert" data-s05-kind-routing="fail-closed">
                链接无效：kind 参数为空、重复或未知；未展示任何方案内容。
              </p>
            ) : runtime.status === "ready" ? (
              <S05PlanDiffCard
                runtime={runtime.runtime}
                intentRequest={intentRequest}
                planKindRequest={planKindRequest}
              />
            ) : runtime.status === "loading" ? (
              <p className="s05-withdrawn" role="status" data-runtime-state="loading">
                正在连接本地领域数据…
              </p>
            ) : (
              <p className="s05-withdrawn" role="status" data-runtime-state="unavailable">
                本地领域数据暂不可用：{runtime.reason}。
              </p>
            )}
          </article>

          {runtime.status === "loading" ? (
            <p className="s05-withdrawn" role="status" data-runtime-state="loading">
              正在连接本地领域数据…
            </p>
          ) : null}
          {runtime.status === "unavailable" ? (
            <p className="s05-withdrawn" role="status" data-runtime-state="unavailable">
              本地领域数据暂不可用：{runtime.reason}。
            </p>
          ) : null}
          <section className="s05-card" aria-label="重新检查条件">
            <h2 className="s05-kicker">
              <RefreshCcw size={15} aria-hidden="true" />
              任何参数改变，都重新检查
            </h2>
            <p className="s05-sub">材料范围、目标对象或计划版本发生变化时，旧批准不能继续使用。执行前仍会读取最新状态。</p>
            <div className="s05-exclusions">
              <ul className="s05-ex-list" aria-label="不包含的操作">
                {EXCLUSIONS.map((item) => (
                  <li key={item} className="s05-ex-pill">
                    {item}
                  </li>
                ))}
              </ul>
              <p className="s05-ex-note">本次均不包含</p>
            </div>
          </section>
        </div>

        <aside className="s05-side" aria-label="这次允许做什么">
          <h2 className="s05-side-title">这次允许做什么</h2>
          <ul className="s05-allows">
            {planKind === "B" ? (
              <>
                <li className="s05-allow">
                  <Check size={15} aria-hidden="true" />
                  内部改期：推迟本次承诺
                </li>
                <li className="s05-allow">
                  <Check size={15} aria-hidden="true" />
                  未来欠账记入台账
                </li>
              </>
            ) : (
              <>
                <li className="s05-allow">
                  <Check size={15} aria-hidden="true" />
                  读取指定材料
                </li>
                <li className="s05-allow">
                  <Check size={15} aria-hidden="true" />
                  创建一份共享草稿
                </li>
                <li className="s05-allow">
                  <Check size={15} aria-hidden="true" />
                  更新内部投入估计
                </li>
              </>
            )}
          </ul>
          <p className="s05-side-note">
            {planKind === "B"
              ? "不包含净节省声明、外部日历写入或发送提交。"
              : "不包含发送、提交或移动会议。"}
          </p>
          <div className="s05-scope">
            <p className="s05-scope-line">
              有效范围：{planKind === "B" ? "本次延期承诺" : "本次准备任务"}
            </p>
            <p className="s05-scope-sub">
              <CalendarClock size={13} aria-hidden="true" />
              下一次需要新的批准。
            </p>
          </div>
          {runtime.status === "ready" ? (
            <S05RuntimeApproval
              intentRequest={intentRequest}
              planKindRequest={planKindRequest}
              runtime={runtime.runtime}
              phase={approvalPhase}
              onPhaseChange={setApprovalPhase}
            />
          ) : null}
          <footer className="s05-actions">
            <button
              type="button"
              className="s05-secondary"
              onClick={() => navigate(buildBackHref(location.pathname, intentRequest, planKind))}
            >
              <ArrowLeft size={17} aria-hidden="true" />
              返回修改方案
            </button>
          </footer>
        </aside>
      </div>
    </section>
  );
}
