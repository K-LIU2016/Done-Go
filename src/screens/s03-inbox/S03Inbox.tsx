import { useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  Bookmark,
  Check,
  FileText,
  Lock,
  Mail,
  RotateCcw,
  UserRound,
} from "lucide-react";
import "./s03-inbox.css";
import { useDomainState } from "../../data/react.ts";
import type { DomainStore } from "../../domain/index.ts";
import type {
  AcceptRequestCommand,
  ArchiveRequestCommand,
  Commitment,
  DomainCommand,
  Request,
  UpdateCommitmentCommand,
} from "../../domain/types.ts";
import {
  retryDomainRuntime,
  useDomainRuntime,
  type ReadyDomainRuntime,
} from "../../runtime/index.ts";
import {
  countCommitmentsForRequest,
  decisionEligibility,
  describeRequestFacts,
  describeSourceRef,
  normalizeCommitmentEdit,
  planInboxRetry,
  requestStatusView,
  selectInboxRequest,
  selectLinkedCommitment,
  selectOrderedRequests,
  verifyCommitmentPatch,
  verifyPersistedRequestStatus,
  verifyRequestStatus,
} from "./inboxAdapter.ts";
import { AgreementPanel } from "./AgreementPanel.tsx";
import type {
  CommitmentEditPatch,
  DecidedStatus,
  InboxRetryPlan,
} from "./inboxAdapter.ts";

const DATA_MODE = "fixture" as const;
const CAPTURE_ROUTE = "/capture";
const READBACK_UNVERIFIED_CODE = "STORAGE_READBACK_UNVERIFIED";

type DecisionKind = "accept" | "keepIdea" | "exclude";

const DECISION_STATUS: Record<DecisionKind, DecidedStatus> = {
  accept: "accepted",
  keepIdea: "archived",
  exclude: "excluded",
};

interface InboxActionError {
  code: string;
  reason: string;
  plan: InboxRetryPlan;
  command: DomainCommand | null;
}

export function S03Inbox() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [runtimeEpoch, setRuntimeEpoch] = useState(0);
  return (
    <section className="s03" data-page="s03" aria-label="收件箱 · 请求不等于承诺">
      <header className="s03-head">
        <h1 className="s03-title">先理解，再成为责任。</h1>
        <p className="s03-sub">把外界的请求放进收件箱，不直接放进你的人生。</p>
      </header>
      <S03RuntimeGate
        key={runtimeEpoch}
        requestIdQuery={searchParams.get("requestId")}
        onRetrySettled={() => setRuntimeEpoch((epoch) => epoch + 1)}
        onSelectRequest={(id) =>
          setSearchParams(id === null ? {} : { requestId: id })
        }
        onClearRequest={() => setSearchParams({})}
      />
    </section>
  );
}

interface S03RuntimeGateProps {
  requestIdQuery: string | null;
  onRetrySettled: () => void;
  onSelectRequest: (requestId: string | null) => void;
  onClearRequest: () => void;
}

function S03RuntimeGate({
  requestIdQuery,
  onRetrySettled,
  onSelectRequest,
  onClearRequest,
}: S03RuntimeGateProps) {
  const runtime = useDomainRuntime(DATA_MODE);
  const [retrying, setRetrying] = useState(false);
  if (runtime.status === "loading") {
    return (
      <p className="s03-runtime" role="status" data-runtime-state="loading">
        正在连接本地领域数据…
      </p>
    );
  }
  if (runtime.status === "unavailable") {
    const retry = () => {
      if (retrying) return;
      setRetrying(true);
      void retryDomainRuntime(runtime.dataMode).finally(() => {
        setRetrying(false);
        onRetrySettled();
      });
    };
    return (
      <div className="s03-runtime is-error" data-runtime-state="unavailable">
        <p role="status">
          本地领域数据当前不可读：{runtime.reason}。原始数据已保留，未被清除。
        </p>
        <button
          type="button"
          className="s03-retry"
          data-runtime-retry
          onClick={retry}
          disabled={retrying}
        >
          {retrying ? "正在重试连接…" : "重试连接本地数据"}
        </button>
      </div>
    );
  }
  return (
    <div data-runtime-state="ready">
      <S03Ready
        handle={runtime.runtime}
        requestIdQuery={requestIdQuery}
        onSelectRequest={onSelectRequest}
        onClearRequest={onClearRequest}
      />
    </div>
  );
}

interface S03ReadyProps {
  handle: ReadyDomainRuntime;
  requestIdQuery: string | null;
  onSelectRequest: (requestId: string | null) => void;
  onClearRequest: () => void;
}

function S03Ready({
  handle,
  requestIdQuery,
  onSelectRequest,
  onClearRequest,
}: S03ReadyProps) {
  const state = useDomainState(handle.store);
  const requests = selectOrderedRequests(state);
  const selection = selectInboxRequest(state, requestIdQuery);

  if (selection.kind === "empty") {
    return (
      <div className="s03-empty" data-inbox-state="empty">
        <p className="s03-empty-title">现在没有已记录的请求。</p>
        <p className="s03-empty-note">
          收件箱只显示本地真实记录，不展示虚构示例。你可以在快捷记录里先写下外界的请求，它们会出现在这里等你确认。
        </p>
        <Link className="s03-empty-link" to={CAPTURE_ROUTE}>
          打开快捷记录
        </Link>
      </div>
    );
  }

  const selected = selection.kind === "selected" ? selection.request : null;
  const candidateCount = requests.filter(
    (item) => item.status === "candidate",
  ).length;

  return (
    <div className="s03-grid" data-inbox-state={selection.kind}>
      <aside className="s03-list" aria-label="请求列表">
        <div className="s03-list-head">
          <h2 className="s03-list-title">收件记录</h2>
          <span className="s03-count">{requests.length}</span>
        </div>
        <p className="s03-foot-note">待澄清 {candidateCount}</p>
        <ul className="s03-items">
          {requests.map((item) => {
            const isOn = selected !== null && item.id === selected.id;
            return (
              <li
                key={item.id}
                className={isOn ? "s03-entry is-on" : "s03-entry"}
              >
                <button
                  type="button"
                  className="s03-entry-btn"
                  aria-pressed={isOn}
                  onClick={() => onSelectRequest(item.id)}
                >
                  {item.verbatim.length > 18
                    ? item.verbatim.slice(0, 18) + "…"
                    : item.verbatim}
                </button>
                <p className="s03-entry-src">
                  <FileText size={13} aria-hidden="true" />
                  {describeSourceRef(item).label}
                </p>
                <span className="s03-entry-tag">
                  {requestStatusView(item).listTag}
                </span>
              </li>
            );
          })}
        </ul>
        <div className="s03-list-foot">
          <p className="s03-foot-title">允许一个想法一直只是想法。</p>
          <p className="s03-foot-note">收集，不等于接受。</p>
        </div>
      </aside>

      {selection.kind === "invalid" ? (
        <article
          className="s03-detail"
          aria-label="请求链接无效"
          data-inbox-invalid-id={selection.requestId}
        >
          <span className="s03-detail-pill">
            <AlertTriangle size={14} aria-hidden="true" />
            请求链接无效
          </span>
          <h2 className="s03-detail-title">链接里的请求不存在。</h2>
          <p className="s03-detail-meta">
            requestId「{selection.requestId}
            」在本地记录中没有对应的请求。
          </p>
          <p className="s03-detail-note">
            这里不会替你换成另一个请求。左侧列表仍是本地真实记录，可自行选择查看。
          </p>
          <div className="s03-actions">
            <button
              type="button"
              className="s03-secondary"
              onClick={onClearRequest}
            >
              查看实际请求列表
            </button>
          </div>
        </article>
      ) : null}

      {selected !== null ? (
        <S03Detail key={selected.id} handle={handle} request={selected} />
      ) : null}

      <div className="s03-side">
        <AgreementPanel handle={handle} />
        <aside className="s03-panel" aria-label="提取不是承诺">
          <p className="s03-panel-kicker">01 · 提取不是承诺</p>
          <ol className="s03-steps">
            <li className="s03-step">
              <span className="s03-step-dot is-done" aria-hidden="true" />
              <div>
                <p className="s03-step-title">已提出</p>
                <p className="s03-step-note">会议中出现的请求</p>
              </div>
            </li>
            <li className="s03-step">
              <span className="s03-step-dot is-current" aria-hidden="true" />
              <div>
                <p className="s03-step-title">待确认</p>
                <p className="s03-step-note">系统提取出的候选事项</p>
              </div>
            </li>
            <li className="s03-step">
              <span className="s03-step-dot" aria-hidden="true" />
              <div>
                <p className="s03-step-title">已接受</p>
                <p className="s03-step-note">只有你能建立这份责任</p>
              </div>
            </li>
          </ol>
        </aside>

        <aside className="s03-panel" aria-label="AI 只补问必要的问题">
          <h2 className="s03-panel-title">AI 只补问必要的问题。</h2>
          <p className="s03-panel-q">你是否愿意接受这件事？</p>
          <p className="s03-panel-body">
            确定之后，再讨论范围与时间；不要要求先填写一整套项目表格。
          </p>
          <p className="s03-panel-pill">
            <Lock size={14} aria-hidden="true" />
            不自动向任何人发送消息
          </p>
        </aside>
      </div>
    </div>
  );
}

interface S03DetailProps {
  handle: ReadyDomainRuntime;
  request: Request;
}

function S03Detail({ handle, request }: S03DetailProps) {
  const store: DomainStore = handle.store;
  const state = useDomainState(store);
  const [pendingKey, setPendingKey] = useState<DecisionKind | null>(null);
  const [actionError, setActionError] = useState<InboxActionError | null>(null);
  const attemptRef = useRef(0);

  const status = requestStatusView(request);
  const eligibility = decisionEligibility(request);
  const facts = describeRequestFacts(state, request);
  const source = describeSourceRef(request);
  const commitment = selectLinkedCommitment(state, request);
  const busy = pendingKey !== null;

  const checkReadback = (command: DomainCommand, expected: DecidedStatus) => {
    const storeVerified = verifyRequestStatus(
      store.getState(),
      request.id,
      expected,
    );
    const persistedVerified = verifyPersistedRequestStatus(
      handle.persistence.getState(),
      request.id,
      expected,
    );
    if (!storeVerified || persistedVerified !== true) {
      setActionError({
        code: READBACK_UNVERIFIED_CODE,
        reason: "命令已提交，但本地持久层的读回尚未确认；确认之前不会当作已保存。",
        plan: "replayExact",
        command,
      });
    }
  };

  const runDecision = (kind: DecisionKind) => {
    if (busy || !eligibility.canAccept) return;
    attemptRef.current += 1;
    const attempt = String(attemptRef.current);
    const command: AcceptRequestCommand | ArchiveRequestCommand =
      kind === "accept"
        ? {
            type: "acceptRequest",
            commandId:
              "s03-accept-" + request.id + "-r" + request.revision + "-a" + attempt,
            entityId: request.id,
            expectedRevision: request.revision,
            actor: "user",
            issuedAt: new Date().toISOString(),
          }
        : {
            type: "archiveRequest",
            commandId:
              "s03-" + kind + "-" + request.id + "-r" + request.revision + "-a" + attempt,
            entityId: request.id,
            expectedRevision: request.revision,
            actor: "user",
            issuedAt: new Date().toISOString(),
            decision: kind === "keepIdea" ? "keepIdea" : "exclude",
          };
    setPendingKey(kind);
    setActionError(null);
    void store.execute(command).then((result) => {
      setPendingKey(null);
      if (!result.ok) {
        setActionError({
          code: result.code,
          reason: result.reason,
          plan: planInboxRetry(result.code),
          command,
        });
        return;
      }
      checkReadback(command, DECISION_STATUS[kind]);
    });
  };

  const retryAction = () => {
    if (busy || actionError === null) return;
    const failed = actionError;
    if (failed.plan === "recapture" || failed.command === null) {
      setActionError(null);
      return;
    }
    const command = failed.command;
    if (command.type !== "acceptRequest" && command.type !== "archiveRequest") {
      setActionError(null);
      return;
    }
    const kind: DecisionKind =
      command.type === "acceptRequest"
        ? "accept"
        : command.decision === "keepIdea"
          ? "keepIdea"
          : "exclude";
    setPendingKey(kind);
    setActionError(null);
    void store.execute(command).then((result) => {
      setPendingKey(null);
      if (!result.ok) {
        setActionError({
          code: result.code,
          reason: result.reason,
          plan: planInboxRetry(result.code),
          command,
        });
        return;
      }
      checkReadback(command, DECISION_STATUS[kind]);
    });
  };

  return (
    <article
      className="s03-detail"
      aria-label="请求详情"
      data-request-id={request.id}
      data-request-status={request.status}
      data-commitment-count={String(countCommitmentsForRequest(state, request.id))}
    >
      <span className="s03-detail-pill" data-request-pill={request.status}>
        <Mail size={14} aria-hidden="true" />
        {status.pill}
      </span>
      <h2 className="s03-detail-title">{request.verbatim}</h2>
      <p className="s03-detail-meta" data-source-ref={request.sourceRef ?? ""}>
        {source.kind === "link" ? (
          <a href={source.href} target="_blank" rel="noreferrer">
            {source.label}
          </a>
        ) : (
          source.label
        )}
        {" · fixture 示例数据"}
      </p>
      <blockquote className="s03-quote">
        <span className="s03-quote-label">原话</span>
        <p className="s03-quote-text">“{request.verbatim}”</p>
      </blockquote>
      <h3 className="s03-facts-title">影响判断的四件事</h3>
      <dl className="s03-facts">
        {facts.map((fact) => (
          <div className="s03-fact" key={fact.label}>
            <dt>
              {fact.label === "提出者" ? (
                <UserRound size={15} aria-hidden="true" />
              ) : null}
              {fact.label}
            </dt>
            <dd className={fact.unknown ? "is-warm" : undefined} data-fact={fact.label}>
              {fact.value}
            </dd>
          </div>
        ))}
      </dl>
      <p className="s03-detail-note">
        只有你的确认，才会把它变成你的责任。
        系统不会替你回答“我来做”。
      </p>
      {status.note !== null ? (
        <p className="s03-status" role="status" data-request-status={request.status}>
          <Check size={15} aria-hidden="true" />
          {status.pill}
          <span className="s03-status-note">{status.note}</span>
        </p>
      ) : null}
      <div className="s03-actions">
        <button
          type="button"
          className="s03-primary"
          onClick={() => runDecision("accept")}
          disabled={!eligibility.canAccept || busy}
        >
          {pendingKey === "accept" ? "正在接受…" : "我接受这件事"}
          <ArrowRight size={18} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="s03-secondary"
          onClick={() => runDecision("keepIdea")}
          disabled={!eligibility.canKeepIdea || busy}
        >
          <Bookmark size={16} aria-hidden="true" />
          保留为想法
        </button>
        <button
          type="button"
          className="s03-tertiary"
          onClick={() => runDecision("exclude")}
          disabled={!eligibility.canExclude || busy}
        >
          <Ban size={15} aria-hidden="true" />
          不是我的事项
        </button>
      </div>
      {!eligibility.canAccept ? (
        <p className="s03-hint">
          该请求当前状态是「{status.pill}」；处置按钮不可重复执行，避免重复入账。
        </p>
      ) : null}
      {actionError !== null ? (
        <div
          className="s03-action-error"
          role="alert"
          data-action-error={actionError.code}
          data-action-plan={actionError.plan}
        >
          <p className="s03-action-error-title">
            <AlertTriangle size={14} aria-hidden="true" />
            {actionError.code === READBACK_UNVERIFIED_CODE
              ? "读回未确认，未当作已保存"
              : "操作未完成"}
          </p>
          <p className="s03-action-error-reason">
            {actionError.code}：{actionError.reason}
          </p>
          {actionError.plan === "replayExact" && actionError.command !== null ? (
            <button
              type="button"
              className="s03-secondary"
              data-action-retry="exact"
              onClick={retryAction}
              disabled={busy}
            >
              <RotateCcw size={15} aria-hidden="true" />
              原样重试同一命令
            </button>
          ) : (
            <button
              type="button"
              className="s03-secondary"
              data-action-retry="recapture"
              onClick={retryAction}
            >
              重新读取最新状态后再决定
            </button>
          )}
        </div>
      ) : null}
      {eligibility.canEditCommitment && commitment !== null ? (
        <CommitmentEditor key={commitment.id} handle={handle} commitment={commitment} />
      ) : null}
    </article>
  );
}

interface CommitmentEditorProps {
  handle: ReadyDomainRuntime;
  commitment: Commitment;
}

function CommitmentEditor({ handle, commitment }: CommitmentEditorProps) {
  const store: DomainStore = handle.store;
  const [scope, setScope] = useState(commitment.scope ?? "");
  const [deadline, setDeadline] = useState(
    commitment.deadline === null ? "" : commitment.deadline.slice(0, 10),
  );
  const [effort, setEffort] = useState(
    commitment.effortEstimateMinutes === null
      ? ""
      : String(commitment.effortEstimateMinutes),
  );
  const [fieldErrors, setFieldErrors] = useState<string[] | null>(null);
  const [saveError, setSaveError] = useState<InboxActionError | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const attemptRef = useRef(0);

  const verifyPatch = (patch: CommitmentEditPatch, command: DomainCommand) => {
    const storeVerified = verifyCommitmentPatch(
      store.getState(),
      commitment.id,
      patch,
    );
    const persisted = handle.persistence.getState();
    const persistedVerified =
      persisted === null
        ? false
        : verifyCommitmentPatch(persisted, commitment.id, patch);
    if (!storeVerified || !persistedVerified) {
      setSaveError({
        code: READBACK_UNVERIFIED_CODE,
        reason: "命令已提交，但本地持久层的读回尚未确认；确认之前不会当作已保存。",
        plan: "replayExact",
        command,
      });
      return;
    }
    setSaved(true);
  };

  const save = () => {
    if (pending) return;
    const normalized = normalizeCommitmentEdit({ scope, deadline, effort });
    if (!normalized.ok) {
      setFieldErrors(normalized.errors);
      return;
    }
    setFieldErrors(null);
    setPending(true);
    setSaveError(null);
    attemptRef.current += 1;
    const command: UpdateCommitmentCommand = {
      type: "updateCommitment",
      commandId:
        "s03-edit-" +
        commitment.id +
        "-r" +
        commitment.revision +
        "-a" +
        String(attemptRef.current),
      entityId: commitment.id,
      expectedRevision: commitment.revision,
      actor: "user",
      issuedAt: new Date().toISOString(),
      scope: normalized.patch.scope,
      deadline: normalized.patch.deadline,
      effortEstimateMinutes: normalized.patch.effortEstimateMinutes,
    };
    void store.execute(command).then((result) => {
      setPending(false);
      if (!result.ok) {
        setSaveError({
          code: result.code,
          reason: result.reason,
          plan: planInboxRetry(result.code),
          command,
        });
        return;
      }
      verifyPatch(normalized.patch, command);
    });
  };

  const retrySave = () => {
    if (pending || saveError === null) return;
    const failed = saveError;
    if (failed.plan === "recapture" || failed.command === null) {
      setSaveError(null);
      return;
    }
    const command = failed.command;
    if (command.type !== "updateCommitment") {
      setSaveError(null);
      return;
    }
    const patch: CommitmentEditPatch = {
      scope: command.scope ?? null,
      deadline: command.deadline ?? null,
      effortEstimateMinutes: command.effortEstimateMinutes ?? null,
    };
    setPending(true);
    setSaveError(null);
    void store.execute(command).then((result) => {
      setPending(false);
      if (!result.ok) {
        setSaveError({
          code: result.code,
          reason: result.reason,
          plan: planInboxRetry(result.code),
          command,
        });
        return;
      }
      verifyPatch(patch, command);
    });
  };

  return (
    <div
      className="s03-edit"
      aria-label="补充责任信息"
      data-edit-state={saveError !== null ? "error" : saved ? "verified" : "idle"}
      data-edit-scope={commitment.scope ?? ""}
      data-edit-deadline={commitment.deadline ?? ""}
      data-edit-effort={
        commitment.effortEstimateMinutes === null
          ? ""
          : String(commitment.effortEstimateMinutes)
      }
    >
      <h3 className="s03-edit-title">补充范围、期限与投入</h3>
      <p className="s03-edit-note">留空表示尚未明确；系统不会替你填默认值。</p>
      <div className="s03-edit-fields">
        <label className="s03-edit-field">
          <span>范围</span>
          <input
            type="text"
            value={scope}
            placeholder="尚未明确"
            onChange={(event) => {
              setScope(event.target.value);
              setSaved(false);
            }}
          />
        </label>
        <label className="s03-edit-field">
          <span>截止日期</span>
          <input
            type="date"
            value={deadline}
            onChange={(event) => {
              setDeadline(event.target.value);
              setSaved(false);
            }}
          />
        </label>
        <label className="s03-edit-field">
          <span>预计投入（分钟）</span>
          <input
            type="number"
            min="1"
            step="1"
            value={effort}
            placeholder="尚未估计"
            onChange={(event) => {
              setEffort(event.target.value);
              setSaved(false);
            }}
          />
        </label>
      </div>
      {fieldErrors !== null ? (
        <ul className="s03-edit-errors" role="alert">
          {fieldErrors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}
      <div className="s03-edit-actions">
        <button
          type="button"
          className="s03-secondary"
          onClick={save}
          disabled={pending}
        >
          {pending ? "正在保存…" : "保存责任信息"}
        </button>
        <p className="s03-edit-readback">
          本地记录：{commitment.scope ?? "范围尚未明确"} · 截止{" "}
          {commitment.deadline ?? "尚未约定"} · 投入{" "}
          {commitment.effortEstimateMinutes === null
            ? "尚未估计"
            : commitment.effortEstimateMinutes + " 分钟"}
        </p>
      </div>
      {saveError !== null ? (
        <div
          className="s03-action-error"
          role="alert"
          data-edit-error={saveError.code}
          data-edit-plan={saveError.plan}
        >
          <p className="s03-action-error-title">
            <AlertTriangle size={14} aria-hidden="true" />
            {saveError.code === READBACK_UNVERIFIED_CODE
              ? "读回未确认，未当作已保存"
              : "保存未完成"}
          </p>
          <p className="s03-action-error-reason">
            {saveError.code}：{saveError.reason}
          </p>
          {saveError.plan === "replayExact" && saveError.command !== null ? (
            <button
              type="button"
              className="s03-secondary"
              data-edit-retry="exact"
              onClick={retrySave}
              disabled={pending}
            >
              <RotateCcw size={15} aria-hidden="true" />
              原样重试同一命令
            </button>
          ) : (
            <button
              type="button"
              className="s03-secondary"
              data-edit-retry="recapture"
              onClick={retrySave}
            >
              重新读取最新状态后再保存
            </button>
          )}
        </div>
      ) : null}
      {saved && saveError === null ? (
        <p className="s03-edit-saved" role="status">
          已保存，并通过本地读回确认。
        </p>
      ) : null}
    </div>
  );
}
