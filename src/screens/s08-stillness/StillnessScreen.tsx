import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Moon, Music, X } from "lucide-react";
import { QuietArtwork } from "../../components/QuietArtwork";
import { useDomainState } from "../../data/react.ts";
import type { DomainStore } from "../../domain/store.ts";
import type {
  DecideQuietCommand,
  OpenQuietSessionCommand,
  ProtectedBlock,
  SaveCaptureDraftCommand,
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
} from "./quietSurface.ts";
import "./s08-stillness.css";
import { makeQuietIdeaCommand, saveQuietIdea, selectRecentQuietText } from "./quietIdeas.ts";
import { quietMusicController, unconfiguredMusicAdapter } from "./music-adapter.ts";
import type { QuietMusicAdapter } from "./music-adapter.ts";

const DATA_MODE = "fixture" as const;
const EXIT_TARGET = "/";
const OPEN_ID_PREFIX = "s08-openQuietSession-";
const DECIDE_ID_PREFIX = "s08-decideQuiet-";

type QuietPendingAction = "open" | "keepStill" | "exit";

interface QuietActionError {
  code: string;
  reason: string;
  retryPlan: QuietRetryPlan;
  command: DecideQuietCommand | OpenQuietSessionCommand | null;
}

export function StillnessScreen({ musicAdapter = unconfiguredMusicAdapter }: { musicAdapter?: QuietMusicAdapter } = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [runtimeEpoch, setRuntimeEpoch] = useState(0);
  return (
    <StillnessRuntime
      key={runtimeEpoch}
      musicAdapter={musicAdapter}
      blockIdQuery={searchParams.get("blockId")}
      onRetrySettled={() => setRuntimeEpoch((epoch) => epoch + 1)}
      onClearBlockId={() => setSearchParams({}, { replace: true })}
    />
  );
}

interface StillnessRuntimeProps {
  musicAdapter: QuietMusicAdapter;
  blockIdQuery: string | null;
  onRetrySettled: () => void;
  onClearBlockId: () => void;
}

function StillnessRuntime({ blockIdQuery, onRetrySettled, onClearBlockId, musicAdapter }: StillnessRuntimeProps) {
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
      <div className="s08" data-page="s08" data-quiet-state="loading">
        <h1 className="s08-connecting">正在连接本地领域数据…</h1>
        <p className="s08-note">确认本地的静驻记录之前，这里不会显示或记录任何选择。</p>
      </div>
    );
  }
  if (runtime.status === "unavailable") {
    return (
      <div
        className="s08"
        data-page="s08"
        data-quiet-state="unavailable"
        data-quiet-reason={runtime.reason}
      >
        <h1 className="s08-connecting">静驻界面暂时读不到本地记录</h1>
        <p className="s08-note">原因：{runtime.reason}</p>
        <p className="s08-note">
          已保存的数据仍在本地，没有被清除。恢复连接之前，这里不会显示时段，也不会记录任何选择。
        </p>
        <button
          type="button"
          className="s08-btn-ghost"
          data-quiet-retry="runtime"
          onClick={retry}
          disabled={retrying}
        >
          {retrying ? "正在重试连接…" : "重试连接本地数据"}
        </button>
      </div>
    );
  }
  return (
    <StillnessReady
      handle={runtime.runtime}
      musicAdapter={musicAdapter}
      blockIdQuery={blockIdQuery}
      onClearBlockId={onClearBlockId}
    />
  );
}

interface StillnessReadyProps {
  musicAdapter: QuietMusicAdapter;
  handle: ReadyDomainRuntime;
  blockIdQuery: string | null;
  onClearBlockId: () => void;
}

function StillnessReady({ handle, blockIdQuery, onClearBlockId, musicAdapter }: StillnessReadyProps) {
  const state = useDomainState(handle.store);
  const selection = selectProtectedBlock(state, blockIdQuery);

  if (selection.kind === "notFound") {
    return (
      <div
        className="s08"
        data-page="s08"
        data-quiet-state="invalid-block"
        data-quiet-error={selection.reason}
      >
        <h1 className="s08-connecting">链接里的保护时段不存在</h1>
        <p className="s08-note">
          这个链接指向的 blockId「{selection.blockId}」没有匹配到任何保护时段：{selection.reason}
        </p>
        <p className="s08-note">这里不会替你换成另一个时段。</p>
        <button type="button" className="s08-btn-ghost" onClick={onClearBlockId}>
          查看当前实际的保护时段
        </button>
      </div>
    );
  }
  if (selection.kind === "empty") {
    return (
      <div className="s08" data-page="s08" data-quiet-state="empty">
        <h1 className="s08-connecting">现在没有激活的保护时段</h1>
        <p className="s08-note">
          本地记录里没有激活的保护时段，所以这里不会显示任何虚构的时间，也不会自动指定一个时段。
        </p>
        <Link className="s08-btn-ghost" to="/boundaries">
          去边界页查看保护时段
        </Link>
      </div>
    );
  }
  return <StillnessActive handle={handle} block={selection.block} musicAdapter={musicAdapter} />;
}

interface StillnessActiveProps {
  musicAdapter: QuietMusicAdapter;
  handle: ReadyDomainRuntime;
  block: ProtectedBlock;
}

function StillnessActive({ handle, block, musicAdapter }: StillnessActiveProps) {
  const store: DomainStore = handle.store;
  const state = useDomainState(store);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [pendingAction, setPendingAction] = useState<QuietPendingAction | null>(null);
  const [actionError, setActionError] = useState<QuietActionError | null>(null);
  const [openAttempt, setOpenAttempt] = useState(0);
  const musicController = quietMusicController(musicAdapter);
  const { busy: musicBusy, result: musicResult } = useSyncExternalStore(musicController.subscribe, musicController.getSnapshot);
  const [exploreOpen, setExploreOpen] = useState(false);
  const [ideaOpen, setIdeaOpen] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);
  const [ideaText, setIdeaText] = useState("");
  const [ideaSaving, setIdeaSaving] = useState(false);
  const [ideaMessage, setIdeaMessage] = useState("");
  const [ideaFailed, setIdeaFailed] = useState(false);
  const ideaCommand = useRef<SaveCaptureDraftCommand | null>(null);
  const ideaInFlight = useRef(false);
  const openInFlight = useRef(false);

  const saveIdea = async () => {
    if (ideaInFlight.current) return;
    const command = ideaCommand.current ?? makeQuietIdeaCommand(ideaText, "s08-idea-" + crypto.randomUUID(), new Date().toISOString());
    if (!command) return;
    ideaCommand.current = command;
    ideaInFlight.current = true;
    setIdeaSaving(true);
    const result = await saveQuietIdea(store, handle.persistence.getState, command);
    ideaInFlight.current = false;
    setIdeaSaving(false);
    setIdeaFailed(!result.ok);
    if (!result.ok) {
      setIdeaMessage(result.reason);
      return;
    }
    ideaCommand.current = null;
    setIdeaText("");
    setIdeaMessage("已保存在本地文字草稿中，没有生成待办或责任。");
  };

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
  const keepStillVerified =
    latest !== null &&
    verifyDecisionRecorded(state, latest.id, "keepStill") &&
    persistedQuietState !== null &&
    verifyDecisionRecorded(persistedQuietState, latest.id, "keepStill");
  const decidedKeepStill = decision === "keepStill";
  const keepStillDisabled = pendingAction !== null || decidedKeepStill;
  const musicBlocked = pendingAction !== null || actionError !== null || latest === null || persistedQuietState === null;

  const runMusic = async () => {
    if (musicBlocked || openInFlight.current) return;
    await musicController.run(() => "TangoDoneGo-music-" + crypto.randomUUID());
  };

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
    if (command.decision !== "keepStill" && command.decision !== "exit") {
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

  const runDecide = (next: "keepStill" | "exit") => {
    if (pendingAction !== null) return;
    if (next === "exit" && latest !== null) {
      const close = planQuietClose(store.getState(), handle.persistence.readFreshState(), latest.id);
      if (close === "preserve") { navigate(exitTarget); return; }
      if (close === "unverified") {
        setActionError(current => current ?? { code: "STORAGE_READBACK_UNVERIFIED", reason: "静驻选择的本地读回尚未一致，暂不关闭或改写选择；请重试读回后再关闭。", retryPlan: "rederiveFromState", command: null });
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
        if (command.decision === "keepStill" || command.decision === "exit") {
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

  const coverageLabel =
    coverage === null
      ? "正在确认来源覆盖…"
      : coverage
        ? "已接入渠道内受保护"
        : "来源覆盖未知 · 非全渠道保护";

  return (
    <div
      className="s08"
      data-page="s08"
      data-quiet-state="ready"
      data-quiet-decision={decision ?? "none"}
      data-quiet-confirmed={decidedKeepStill && keepStillVerified ? "true" : "false"}
      data-quiet-action={pendingAction ?? "none"}
      data-quiet-pending={pendingAction !== null ? "true" : "false"}
      data-quiet-coverage={coverage === null ? "checking" : coverage ? "known" : "unknown"}
    >
      <div className="s08-topline">
        <div className="s08-brand">
          <span className="s08-brand-mark" aria-hidden="true" />
          <span className="s08-brand-zh">Done&amp;Go</span>
          <span className="s08-brand-en">A SPACE OF YOUR OWN</span>
        </div>
        <span className="s08-topline-right">
          <span className="s08-protected">{coverageLabel}</span>
          <button
            type="button"
            className="s08-exit"
            aria-label="退出静驻时刻"
            data-quiet-action="exit"
            disabled={pendingAction !== null}
            onClick={() => runDecide("exit")}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </span>
      </div>
      <div className="s08-stage">
        <div className="s08-content">
          <span className="s08-chip">
            <Moon size={13} aria-hidden="true" />
            今晚 · 留给自己
          </span>
          <h1>
            这段时间，
            <br />
            不必证明什么。
          </h1>
          {surface.start !== null && surface.end !== null ? (
            <p className="s08-time">
              {surface.start} — {surface.end}
            </p>
          ) : (
            <p className="s08-time">时段时间无法如实显示</p>
          )}
          <p className="s08-meta">
            时区 {surface.timezone} · 时段用途：
            {surface.purpose === null ? "未指定（静驻允许没有用途）" : surface.purpose}
          </p>
          <p className="s08-note">按你的边界保留。不自动补入下一件事。</p>
          <p className="s08-invite">你可以继续重要的事，也可以什么都不安排。</p>
          <div className="s08-actions">
            <button
              type="button"
              className="s08-btn-primary"
              data-quiet-action="keepStill"
              disabled={keepStillDisabled}
              onClick={() => runDecide("keepStill")}
            >
              {decidedKeepStill ? "已保留：什么也不安排" : "什么也不安排"}
            </button>
            <button
              type="button"
              className="s08-btn-ghost"
              data-quiet-music
              disabled={musicBusy || musicBlocked}
              aria-busy={musicBusy}
              onClick={() => void runMusic()}
            >
              {musicBusy ? "正在检查音乐来源…" : musicResult?.kind === "unknown" ? "核对这次播放状态" : "继续上次的音乐"}
              <Music size={16} aria-hidden="true" />
            </button>
          </div>
          <button
            type="button"
            className="s08-explore"
            aria-expanded={exploreOpen}
            aria-controls="s08-possibilities"
            onClick={() => setExploreOpen((open) => !open)}
          >
            更多可能性
            <span aria-hidden="true">→</span>
          </button>
          {actionError !== null && (
            <div
              className="s08-feedback is-error"
              data-quiet-error={actionError.reason}
              role="alert"
            >
              <p>这次记录尚未确认：{actionError.reason}</p>
              {actionError.retryPlan === "replayExact" ? (
                <button
                  type="button"
                  className="s08-btn-ghost"
                  data-quiet-retry="exact"
                  onClick={retryAction}
                >
                  重试同一记录
                </button>
              ) : (
                <button
                  type="button"
                  className="s08-btn-ghost"
                  data-quiet-retry="rederive"
                  onClick={retryAction}
                >
                  按最新状态重新查看
                </button>
              )}
              <p className="s08-possibility-note">
                这里不会自动改用最新状态重发你的选择；重试始终需要你再次确认。
              </p>
            </div>
          )}
          {decidedKeepStill && keepStillVerified && (
            <p className="s08-feedback">
              已记录：这段时间由你保留。之后不会再因为没有选择而提醒你。
            </p>
          )}
          {decidedKeepStill && !keepStillVerified && (
            <p className="s08-feedback">
              正在确认这条记录已写入本地保存；确认之前不显示成功。
            </p>
          )}
          {decision === "exit" && (
            <p className="s08-feedback">
              已记录你上次退出了这个界面。想保留这段时间，现在可以重新选择。
            </p>
          )}
          {(decision === "music" || decision === "explore") && (
            <p className="s08-feedback">
              已记录你上次在这里的选择。想保留这段时间，现在可以重新选择。
            </p>
          )}
          {musicResult && (
            <p className="s08-feedback" data-quiet-feedback="music" data-music-state={musicResult.kind} role="status">
              {musicResult.message}
              {musicResult.kind === "unknown" && " 再次点击只核对原请求，不会重新发起播放。"}
            </p>
          )}
          {exploreOpen && (
            <div id="s08-possibilities" className="s08-possibilities" aria-label="更多可能性">
              <button type="button" className="s08-explore" aria-expanded={ideaOpen} aria-controls="s08-idea-form" onClick={() => setIdeaOpen((open) => !open)}>记下一个想法</button>
              {ideaOpen && (
                <form id="s08-idea-form" className="s08-idea-form" onSubmit={(event) => { event.preventDefault(); void saveIdea(); }}>
                  <label htmlFor="s08-idea-text">留在这里的一句话</label>
                  <textarea id="s08-idea-text" rows={4} maxLength={4000} value={ideaText} readOnly={ideaSaving || ideaFailed} onChange={(event) => { setIdeaText(event.target.value); setIdeaMessage(""); }} aria-describedby="s08-idea-note" />
                  <p id="s08-idea-note" className="s08-possibility-note">只保存原文，不解析、不安排。最多 4000 字。</p>
                  <button type="submit" className="s08-btn-ghost" disabled={ideaSaving || !ideaText.trim()}>{ideaSaving ? "正在保存…" : ideaFailed ? "重试同一记录" : "仅保存文字"}</button>
                  {ideaMessage && <p className="s08-possibility-note" role={ideaFailed ? "alert" : "status"}>{ideaMessage}</p>}
                </form>
              )}
              <button type="button" className="s08-explore" aria-expanded={recentOpen} aria-controls="s08-recent-text" onClick={() => setRecentOpen((open) => !open)}>看看最近保存的一段话</button>
              {recentOpen && (
                <div id="s08-recent-text" className="s08-recent-text">
                  {selectRecentQuietText(state).length === 0 ? <p className="s08-possibility-note">还没有保存的文字草稿。这里也可以空着。</p> : selectRecentQuietText(state).map((draft) => (
                    <article key={draft.id} className="s08-saved-idea">
                      <p>{draft.raw}</p>
                      <time dateTime={draft.updatedAt}>{new Date(draft.updatedAt).toLocaleString("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })} · 本地草稿</time>
                    </article>
                  ))}
                  <p className="s08-possibility-note">最近 5 条未转为意图的文字草稿，只在这里阅读。</p>
                </div>
              )}
              <button type="button" className="s08-explore" disabled={keepStillDisabled} onClick={() => runDecide("keepStill")}>继续什么都不做</button>
              <p className="s08-possibility-note">
                写下或阅读都不会替你安排下一件事。
              </p>
            </div>
          )}
          <p className="s08-promise">不会因为没有选择，而再次提醒你。</p>
        </div>
        <div className="s08-art">
          <QuietArtwork />
        </div>
      </div>
      <footer className="s08-footer">
        <span>Done&Go · 静驻界面</span>
        <span>保护不等于全渠道拦截；未接入的安排仍需你确认。</span>
        <span>08/14 · 设计演示</span>
      </footer>
    </div>
  );
}
