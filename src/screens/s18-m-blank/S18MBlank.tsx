import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { X } from "lucide-react";
import { MobileChrome } from "../mobile/MobileChrome";
import { QuietArtwork } from "../../components/QuietArtwork";
import { useDomainState } from "../../data/react.ts";
import type {
  DecideQuietCommand,
  OpenQuietSessionCommand,
  ProtectedBlock,
} from "../../domain/types.ts";
import {
  retryDomainRuntime,
  useDomainRuntime,
  type ReadyDomainRuntime,
} from "../../runtime/index.ts";
import {
  describeQuietBlock,
  describeQuietExecuteFailure,
  planQuietRetry,
  planQuietClose,
  quietCoverageKnown,
  selectLatestQuietSession,
  selectQuietEntryOrigin,
  selectQuietExitTarget,
  selectProtectedBlock,
  shouldOpenQuietSession,
  verifyDecisionRecorded,
  type QuietRetryPlan,
} from "../s08-blank/quietSurface.ts";
import "./s18-m-blank.css";

const DATA_MODE = "fixture" as const;
const EXIT_TARGET = "/m/now";
const OPEN_ID_PREFIX = "s18-openQuietSession-";
const DECIDE_ID_PREFIX = "s18-decideQuiet-";

type QuietPendingAction = "open" | "keepBlank" | "exit";

interface QuietActionError {
  code: string;
  reason: string;
  retryPlan: QuietRetryPlan;
  command: DecideQuietCommand | OpenQuietSessionCommand | null;
}

export function S18MBlank() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [runtimeEpoch, setRuntimeEpoch] = useState(0);
  return (
    <S18Runtime
      key={runtimeEpoch}
      blockIdQuery={searchParams.get("blockId")}
      onRetrySettled={() => setRuntimeEpoch((epoch) => epoch + 1)}
      onClearBlockId={() => setSearchParams({}, { replace: true })}
    />
  );
}

interface S18RuntimeProps {
  blockIdQuery: string | null;
  onRetrySettled: () => void;
  onClearBlockId: () => void;
}

function S18Runtime({ blockIdQuery, onRetrySettled, onClearBlockId }: S18RuntimeProps) {
  const runtime = useDomainRuntime(DATA_MODE);
  const [retrying, setRetrying] = useState(false);

  const retry = () => {
    if (retrying) return;
    setRetrying(true);
    retryDomainRuntime(DATA_MODE)
      .catch(() => {
        setRetrying(false);
      })
      .finally(() => {
        setRetrying(false);
        onRetrySettled();
      });
  };

  if (runtime.status === "loading") {
    return (
      <div className="s18-state" data-page="s18" data-quiet-state="loading">
        <p>正在连接本地领域数据…</p>
        <p>确认本地的静默记录之前，这里不会显示或记录任何选择。</p>
      </div>
    );
  }
  if (runtime.status === "unavailable") {
    return (
      <div
        className="s18-state"
        data-page="s18"
        data-quiet-state="unavailable"
        data-quiet-reason={runtime.reason}
      >
        <p>静默界面暂时读不到本地记录。</p>
        <p className="s18-error">原因：{runtime.reason}</p>
        <p>已保存的数据仍在本地，没有被清除。</p>
        <button
          type="button"
          className="s18-quiet"
          data-quiet-retry="runtime"
          onClick={retry}
          disabled={retrying}
        >
          {retrying ? "正在重试连接…" : "重试连接本地数据"}
        </button>
        <Link to="/m/now">先回到此刻</Link>
      </div>
    );
  }
  return (
    <S18Ready
      handle={runtime.runtime}
      blockIdQuery={blockIdQuery}
      onClearBlockId={onClearBlockId}
    />
  );
}

interface S18ReadyProps {
  handle: ReadyDomainRuntime;
  blockIdQuery: string | null;
  onClearBlockId: () => void;
}

function S18Ready({ handle, blockIdQuery, onClearBlockId }: S18ReadyProps) {
  const state = useDomainState(handle.store);
  const selection = selectProtectedBlock(state, blockIdQuery);

  if (selection.kind === "notFound") {
    return (
      <div
        className="s18-state"
        data-page="s18"
        data-quiet-state="invalid-block"
        data-quiet-error={selection.reason}
      >
        <p>链接里的保护时段不存在。</p>
        <p className="s18-error">
          blockId「{selection.blockId}」：{selection.reason}
        </p>
        <p>这里不会替你换成另一个时段。</p>
        <button type="button" className="s18-quiet" onClick={onClearBlockId}>
          查看当前实际的保护时段
        </button>
      </div>
    );
  }
  if (selection.kind === "empty") {
    return (
      <div className="s18-state" data-page="s18" data-quiet-state="empty">
        <p>现在没有激活的保护时段。</p>
        <p>本地记录里没有激活的保护时段，这里不会显示虚构的时间，也不会自动指定一个时段。</p>
        <Link to="/m/now">回到此刻</Link>
      </div>
    );
  }
  return <S18Active handle={handle} block={selection.block} />;
}

interface S18ActiveProps {
  handle: ReadyDomainRuntime;
  block: ProtectedBlock;
}

function S18Active({ handle, block }: S18ActiveProps) {
  const store = handle.store;
  const state = useDomainState(store);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [pendingAction, setPendingAction] = useState<QuietPendingAction | null>(null);
  const [actionError, setActionError] = useState<QuietActionError | null>(null);
  const [openAttempt, setOpenAttempt] = useState(0);
  const openInFlight = useRef(false);

  const surface = describeQuietBlock(block);
  const latest = selectLatestQuietSession(state, block.blockId);
  const coverage = quietCoverageKnown(latest);
  const decision = latest === null ? null : latest.decision;
  const returnToQuery = searchParams.get("returnTo");
  const exitTarget = selectQuietExitTarget({
    queryReturnTo: returnToQuery,
    sessionOriginRoute: latest === null ? null : latest.originRoute,
    fallback: EXIT_TARGET,
  });
  const entryOrigin = selectQuietEntryOrigin(returnToQuery, EXIT_TARGET);
  const persistedQuietState = handle.persistence.readFreshState();
  const keepBlankVerified =
    latest !== null &&
    verifyDecisionRecorded(state, latest.id, "keepBlank") &&
    persistedQuietState !== null &&
    verifyDecisionRecorded(persistedQuietState, latest.id, "keepBlank");
  const decidedKeepBlank = decision === "keepBlank";
  const keepBlankDisabled = pendingAction !== null || decidedKeepBlank;

  const needsOpen =
    shouldOpenQuietSession(latest) && actionError === null && pendingAction === null;
  const [openIssuedAt, setOpenIssuedAt] = useState(() => new Date().toISOString());

  useEffect(() => {
    if (!needsOpen || openInFlight.current) return;
    openInFlight.current = true;
    const command: OpenQuietSessionCommand = {
      type: "openQuietSession",
      commandId: OPEN_ID_PREFIX + block.blockId + "-r" + String(openAttempt),
      entityId: null,
      expectedRevision: null,
      actor: "user",
      issuedAt: openIssuedAt,
      blockId: block.blockId,
      originRoute: entryOrigin,
    };
    void store.execute(command).then((result) => {
      openInFlight.current = false;
      setPendingAction(null);
      if (!result.ok) {
        setActionError({
          code: result.code,
          reason: result.reason,
          retryPlan: planQuietRetry(result.code),
          command,
        });
      }
    }).catch((error: unknown) => {
      openInFlight.current = false;
      setPendingAction(null);
      setActionError({
        code: "RUNTIME_PROMISE_REJECTED",
        reason: describeQuietExecuteFailure(error),
        retryPlan: planQuietRetry("RUNTIME_PROMISE_REJECTED"),
        command,
      });
    });
  }, [needsOpen, store, block.blockId, openAttempt, openIssuedAt, entryOrigin]);

  const finishDecide = (command: DecideQuietCommand) => {
    if (command.decision !== "keepBlank" && command.decision !== "exit") {
      setPendingAction(null);
      return;
    }
    const sessionId = command.entityId ?? "";
    const decision = command.decision;
    const readback = handle.persistence.readFreshState();
    const verified =
      verifyDecisionRecorded(store.getState(), sessionId, decision) &&
      readback !== null &&
      verifyDecisionRecorded(readback, sessionId, decision);
    setPendingAction(null);
    if (verified) {
      navigate(exitTarget);
      return;
    }
    setActionError({
      code: "STORAGE_READBACK_UNVERIFIED",
      reason: "记录已提交，但本地保存的读回尚未确认；确认之前不会当作已保存。",
      retryPlan: "replayExact",
      command,
    });
  };

  const executeQuietCommand = (
    command: DecideQuietCommand | OpenQuietSessionCommand,
    pending: QuietPendingAction,
  ) => {
    setPendingAction(pending);
    setActionError(null);
    void store.execute(command).then((result) => {
      if (!result.ok) {
        setPendingAction(null);
        setActionError({
          code: result.code,
          reason: result.reason,
          retryPlan: planQuietRetry(result.code),
          command,
        });
        return;
      }
      if (command.type === "decideQuiet") {
        finishDecide(command);
        return;
      }
      setPendingAction(null);
    }).catch((error: unknown) => {
      setPendingAction(null);
      setActionError({
        code: "RUNTIME_PROMISE_REJECTED",
        reason: describeQuietExecuteFailure(error),
        retryPlan: planQuietRetry("RUNTIME_PROMISE_REJECTED"),
        command,
      });
    });
  };

  const runDecide = (next: "keepBlank" | "exit") => {
    if (pendingAction !== null) return;
    if (next === "exit" && latest !== null) {
      const close = planQuietClose(store.getState(), handle.persistence.readFreshState(), latest.id);
      if (close === "preserve") { navigate(exitTarget); return; }
      if (close === "unverified") {
        setActionError(current => current ?? { code: "STORAGE_READBACK_UNVERIFIED", reason: "静默选择的本地读回尚未一致，暂不关闭或改写选择；请重试读回后再关闭。", retryPlan: "rederiveFromState", command: null });
        return;
      }
    }
    if (latest === null) {
      if (next === "exit") {
        navigate(exitTarget);
      }
      return;
    }
    const command: DecideQuietCommand = {
      type: "decideQuiet",
      commandId: DECIDE_ID_PREFIX + latest.id + "-" + next,
      entityId: latest.id,
      expectedRevision: latest.revision,
      actor: "user",
      issuedAt: new Date().toISOString(),
      blockId: block.blockId,
      decision: next,
    };
    executeQuietCommand(command, next);
  };

  const retryAction = () => {
    if (pendingAction !== null || actionError === null) return;
    const failed = actionError;
    if (failed.retryPlan === "replayExact" && failed.command !== null) {
      const command = failed.command;
      if (command.type === "decideQuiet") {
        if (command.decision === "keepBlank" || command.decision === "exit") {
          executeQuietCommand(command, command.decision);
        }
        return;
      }
      executeQuietCommand(command, "open");
      return;
    }
    setActionError(null);
    if (failed.command !== null && failed.command.type === "openQuietSession") {
      setOpenAttempt((epoch) => epoch + 1);
      setOpenIssuedAt(new Date().toISOString());
    }
  };

  return (
    <div data-page="s18">
      <MobileChrome time={surface.start ?? ""} active="" hideNavigation>
        <section
          className="s18"
          aria-label="移动端静默时刻"
          data-quiet-state="ready"
          data-quiet-decision={decision ?? "none"}
          data-quiet-confirmed={decidedKeepBlank && keepBlankVerified ? "true" : "false"}
          data-quiet-action={pendingAction ?? "none"}
          data-quiet-pending={pendingAction !== null ? "true" : "false"}
          data-quiet-coverage={coverage === null ? "checking" : coverage ? "known" : "unknown"}
        >
          <header className="s18-top">
            <span className="s18-brand">
              <img className="mchrome-brandmark" src="/brand/tango-mark.svg" alt="" draggable={false} />
              探戈
            </span>
            <button
              type="button"
              className="s18-exit"
              aria-label="退出静默时刻"
              disabled={pendingAction !== null}
              onClick={() => runDecide("exit")}
            >
              <X size={18} aria-hidden="true" />
            </button>
          </header>
          <p className="s18-en">A SPACE OF YOUR OWN</p>
          <div className="s18-art">
            <QuietArtwork />
          </div>
          <h1 className="s18-title">
            这段时间，
            <br />
            不必证明什么。
          </h1>
          {surface.start !== null && surface.end !== null ? (
            <p className="s18-range">
              {surface.start}—{surface.end}
            </p>
          ) : (
            <p className="s18-range">时段时间无法如实显示</p>
          )}
          <p className="s18-meta">
            时区 {surface.timezone} · 时段用途：
            {surface.purpose === null ? "未指定（静默允许没有用途）" : surface.purpose}
          </p>
          <p className="s18-note">不自动填入工作，也不催促你选择。</p>
          <button
            type="button"
            className="s18-quiet"
            data-quiet-action="keepBlank"
            disabled={keepBlankDisabled}
            onClick={() => runDecide("keepBlank")}
          >
            {decidedKeepBlank ? "已保留：什么也不安排" : "什么也不安排"}
          </button>
          {decidedKeepBlank && keepBlankVerified ? (
            <p className="s18-kept">已保留。不会再提醒你做选择。</p>
          ) : null}
          {decidedKeepBlank && !keepBlankVerified ? (
            <p className="s18-note">正在确认这条记录已写入本地保存。</p>
          ) : null}
          {decision === "exit" ? (
            <p className="s18-note">已记录你上次退出。想保留，现在可以重新选择。</p>
          ) : null}
          {decision === "music" || decision === "explore" ? (
            <p className="s18-note">已记录你上次的选择。想保留，现在可以重新选择。</p>
          ) : null}
          {actionError !== null ? (
            <>
              <p className="s18-error" data-quiet-error={actionError.reason} role="alert">
                这次记录没有完成：{actionError.reason}
              </p>
              <button
                type="button"
                className="s18-quiet"
                data-quiet-retry={actionError.retryPlan === "replayExact" ? "exact" : "rederive"}
                onClick={retryAction}
              >
                {actionError.retryPlan === "replayExact" ? "重试同一记录" : "按最新状态重新查看"}
              </button>
            </>
          ) : null}
          <p className="s18-demo">
            只保护已接入渠道 · 设计演示{coverage === false ? "（当前来源覆盖未知）" : ""}
          </p>
        </section>
      </MobileChrome>
    </div>
  );
}
