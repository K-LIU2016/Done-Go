import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Link } from "react-router-dom";
import { LockKeyhole, Moon, Search } from "lucide-react";
import { SpeechInput } from "../../components/SpeechInput.tsx";
import { useDomainRuntime } from "../../runtime/index.ts";
import type { ReadyDomainRuntime } from "../../runtime/index.ts";
import { useDomainState } from "../../data/react.ts";
import type {
  CaptureChannel,
  Commitment,
  ConflictOutcome,
  DomainState,
  EntityId,
  SaveCaptureDraftCommand,
  SaveIntentCommand,
} from "../../domain/types.ts";
import {
  buildCaptureDraftCommand,
  buildCheckConflictCommand,
  buildIntentCommand,
  findMatchingIntent,
  intervalKey,
  parseSentence,
  sameDraftState,
  validateInterval,
  verifyDraftReadback,
  verifyIntentReadback,
} from "./s14-capture-adapter.ts";
import { restoreLatestCapture } from "./capture-restore.ts";
import type { SavedCapture } from "./capture-restore.ts";
import type {
  CaptureTarget,
  DraftState,
  Interval,
} from "./s14-capture-adapter.ts";
import "./s14-capture.css";

const SENTENCE = "明晚七点到八点留给自己，客户会议别动。";

type CheckPresentation = {
  key: string;
  kind: "conflict" | "clear" | "unknown" | "invalid";
  title: string;
  staticNotes: string[];
  conflictIds: EntityId[];
};

type PendingRequest =
  | { kind: "close"; submitted: DraftState; command: SaveCaptureDraftCommand }
  | {
      kind: "check";
      submitted: DraftState;
      interval: Interval;
      command: SaveCaptureDraftCommand | null;
    }
  | { kind: "intent"; submitted: DraftState; command: SaveIntentCommand };

function commitmentDisplayName(state: DomainState, commitment: Commitment): string {
  if (commitment.scope !== null && commitment.scope.trim() !== "") return commitment.scope;
  if (commitment.requestId !== null) {
    const request = state.requests[commitment.requestId];
    if (request !== undefined && request.verbatim.trim() !== "") {
      return "「" + request.verbatim.trim() + "」的承诺";
    }
  }
  return commitment.id;
}

function minuteClock(minute: number): string {
  return (
    String(Math.floor(minute / 60)).padStart(2, "0") +
    ":" +
    String(minute % 60).padStart(2, "0")
  );
}

function conflictNotes(state: DomainState, conflictIds: EntityId[]): string[] {
  return conflictIds.map((id) => {
    const commitment = state.commitments[id];
    if (commitment !== undefined) {
      const schedule = commitment.schedule;
      const when =
        schedule === null
          ? "时间未定"
          : schedule.date +
            " " +
            (schedule.startMinute === null || schedule.endMinute === null
              ? "时间未定"
              : minuteClock(schedule.startMinute) + "—" + minuteClock(schedule.endMinute));
      return "冲突：" + commitmentDisplayName(state, commitment) + "（" + when + "）重叠。";
    }
    const block = state.protectedBlocks[id];
    if (block !== undefined) {
      const name = block.purpose !== null && block.purpose.trim() !== "" ? block.purpose : block.blockId;
      return (
        "冲突：" +
        name +
        "（" +
        block.range.start.slice(11, 16) +
        "—" +
        block.range.end.slice(11, 16) +
        "）重叠：这是受保护的静驻时段。"
      );
    }
    return "冲突：记录 " + id + "（共享状态中未找到对应的承诺或受保护时段）。";
  });
}

export function S14Capture(): ReactElement {
  const runtimeState = useDomainRuntime();
  if (runtimeState.status === "ready") {
    return <S14CaptureReady runtime={runtimeState.runtime} />;
  }
  const loading = runtimeState.status === "loading";
  const note =
    runtimeState.status === "loading"
      ? "正在加载本地共享状态…"
      : "本地共享状态不可用：" + runtimeState.reason + "。页面不会回退到私有本地存储，也不会伪造保存结果。";
  return (
    <section className="s14" data-page="s14" aria-label="快捷输入">
      <div className="s14-closed">
        <p className="s14-closed-note" role={loading ? "status" : "alert"}>
          {note}
        </p>
      </div>
    </section>
  );
}

function S14CaptureReady({ runtime }: { runtime: ReadyDomainRuntime }): ReactElement {
  const store = runtime.store;
  const state = useDomainState(store);
  const [initialCapture] = useState(() => restoreLatestCapture(store.getState()));
  const [open, setOpen] = useState(true);
  const [channel, setChannel] = useState<CaptureChannel>(initialCapture.kind === "restored" ? initialCapture.channel : "shortcut");
  const [shareText, setShareText] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return [params.get("title"), params.get("text"), params.get("url")].filter(value => value !== null && value !== "").join("\n");
  });
  const [showShare, setShowShare] = useState(() => ["title", "text", "url"].some(key => new URLSearchParams(window.location.search).has(key)));
  const [draft, setDraft] = useState<DraftState>(() => initialCapture.kind === "restored" ? initialCapture.draft : {
    verbatim: SENTENCE,
    fields: parseSentence(SENTENCE),
  });
  const [showEditor, setShowEditor] = useState(false);
  const [checkResult, setCheckResult] = useState<CheckPresentation | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const [captureTarget, setCaptureTarget] = useState<CaptureTarget | null>(initialCapture.kind === "restored" ? initialCapture.target : null);
  const [savedCapture, setSavedCapture] = useState<SavedCapture | null>(initialCapture.kind === "restored" ? initialCapture.saved : null);
  const [retryRequest, setRetryRequest] = useState<PendingRequest | null>(null);
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  });

  const reopenCapture = (): void => {
    const restored = restoreLatestCapture(store.getState());
    setOpen(true);
    if (restored.kind === "skip") return;
    if (restored.kind === "none") {
      setCaptureTarget(null);
      setSavedCapture(null);
    } else {
      setChannel(restored.channel);
      setDraft(restored.draft);
      setCaptureTarget(restored.target);
      setSavedCapture(restored.saved);
    }
    setCheckResult(null);
    setActionError(null);
  };

  useEffect(() => {
    if (pending === null) return;
    let active = true;
    const submitted = pending.submitted;
    const editedSince = (): boolean => draftRef.current !== submitted;
    const cancelIfEdited = (phase: string): boolean => {
      if (!editedSince()) return false;
      setPending(null);
      setActionError("输入在" + phase + "期间已被修改；页面保留最新输入，未应用旧操作的结果。");
      return true;
    };
    const failWithRetry = (message: string): void => {
      setPending(null);
      setActionError(message);
      setRetryRequest(pending);
    };
    const applyOutcome = (interval: Interval, outcome: ConflictOutcome): void => {
      const disclosure = "对照对象：当前本地共享状态中的承诺与受保护时段。未检查任何外部日历。";
      if (outcome.outcome === "conflict") {
        setCheckResult({
          key: intervalKey(interval),
          kind: "conflict",
          title: "有冲突 · 对照共享状态",
          staticNotes: [disclosure],
          conflictIds: outcome.conflictIds,
        });
      } else if (outcome.outcome === "none") {
        setCheckResult({
          key: intervalKey(interval),
          kind: "clear",
          title: "无冲突 · 对照共享状态",
          staticNotes: [disclosure],
          conflictIds: [],
        });
      } else {
        setCheckResult({
          key: intervalKey(interval),
          kind: "unknown",
          title: "无法判断 · 覆盖范围未知",
          staticNotes: [outcome.note, disclosure],
          conflictIds: [],
        });
      }
    };
    void (async () => {
      try {
        if (pending.kind === "intent") {
          const result = await store.execute(pending.command);
          if (!active) return;
          if (!result.ok) {
            failWithRetry("保存意图失败（" + result.code + "）：" + result.reason + " 可原样重试同一命令。");
            return;
          }
          const verified = verifyIntentReadback(store.getState(), pending.command, result.data);
          if (!verified.ok) {
            failWithRetry(
              "意图保存结果未能在共享状态中确认：" + verified.reason + "；页面不显示已保存状态，可原样重试同一命令。",
            );
            return;
          }
          setSavedCapture({
            intentId: verified.intent.id,
            draftId: verified.captureDraft !== null ? verified.captureDraft.id : null,
            baseline: submitted,
          });
          if (verified.captureDraft !== null) {
            setCaptureTarget({
              id: verified.captureDraft.id,
              revision: verified.captureDraft.revision,
              status: "savedAsIntent",
            });
          }
          setRetryRequest(null);
          setPending(null);
          if (editedSince()) {
            setActionError("意图已保存，但输入在保存期间又被修改；已保存对应关系会随输入变化自动隐藏。");
          } else {
            setActionError(null);
          }
          return;
        }
        if (pending.command !== null) {
          const draftResult = await store.execute(pending.command);
          if (!active) return;
          if (!draftResult.ok) {
            failWithRetry(
              "草稿未保存（" + draftResult.code + "）：" + draftResult.reason + " 页面保持打开，输入未丢失，可原样重试同一命令。",
            );
            return;
          }
          const verifiedDraft = verifyDraftReadback(store.getState(), pending.command, draftResult.data);
          if (!verifiedDraft.ok) {
            failWithRetry(
              "草稿保存结果未能在共享状态中确认：" + verifiedDraft.reason + "；页面保持打开，输入未丢失，可原样重试同一命令。",
            );
            return;
          }
          setCaptureTarget({
            id: verifiedDraft.captureDraft.id,
            revision: verifiedDraft.captureDraft.revision,
            status: "open",
          });
          setRetryRequest(null);
        }
        if (pending.kind === "close") {
          if (cancelIfEdited("保存草稿")) return;
          setPending(null);
          setActionError(null);
          setCheckResult(null);
          setOpen(false);
          return;
        }
        if (cancelIfEdited("保存草稿")) return;
        const sharedRevision = store.getState().globalRevision;
        const checkCommand = buildCheckConflictCommand({
          interval: pending.interval,
          sharedRevision,
        });
        const checkCommandResult = await store.execute(checkCommand);
        if (!active) return;
        if (!checkCommandResult.ok) {
          setPending(null);
          setActionError("冲突检查失败（" + checkCommandResult.code + "）：" + checkCommandResult.reason);
          return;
        }
        if (cancelIfEdited("检查")) return;
        setPending(null);
        applyOutcome(pending.interval, checkCommandResult.data.outcome);
      } catch (error) {
        if (!active) return;
        setPending(null);
        setRetryRequest(pending);
        setActionError("操作未完成：" + (error instanceof Error ? error.message : String(error)) + " 页面保持打开，输入未丢失，可原样重试同一命令。");
      }
    })();
    return () => {
      active = false;
    };
  }, [pending, store]);

  const openTarget: CaptureTarget | null =
    captureTarget !== null && captureTarget.status === "open" ? captureTarget : null;
  const savedCaptureVisible =
    savedCapture !== null && sameDraftState(draft, savedCapture.baseline);
  const savedIntentId =
    savedCaptureVisible && savedCapture !== null && savedCapture.intentId !== null
      ? savedCapture.intentId
      : (findMatchingIntent(state, draft, channel)?.id ?? null);
  const completedWithoutIntentLink =
    savedCaptureVisible &&
    savedCapture !== null &&
    savedCapture.intentId === null &&
    savedCapture.draftId !== null;
  const captureLocked = savedIntentId !== null || completedWithoutIntentLink;

  const requestClose = (): void => {
    if (pending !== null) return;
    if (captureLocked) {
      setActionError(null);
      setOpen(false);
      return;
    }
    setActionError(null);
    setPending({
      kind: "close",
      submitted: draft,
      command: buildCaptureDraftCommand({ submitted: draft, target: openTarget, channel }),
    });
  };

  const requestCheck = (): void => {
    if (pending !== null) return;
    const verdict = validateInterval(draft.fields);
    if (!verdict.ok) {
      setActionError(null);
      setCheckResult({
        key: "",
        kind: "invalid",
        title: verdict.title,
        staticNotes: [verdict.note],
        conflictIds: [],
      });
      return;
    }
    setActionError(null);
    setCheckResult(null);
    const saveDraftFirst = captureTarget === null || captureTarget.status === "open";
    setPending({
      kind: "check",
      submitted: draft,
      interval: verdict.interval,
      command: saveDraftFirst
        ? buildCaptureDraftCommand({ submitted: draft, target: openTarget, channel })
        : null,
    });
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        requestCheck();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const requestIntent = (): void => {
    if (pending !== null) return;
    if (captureLocked) {
      setCheckResult(null);
      setActionError(
        "该捕获已保存为意图" +
          (savedIntentId !== null ? "（记录 " + savedIntentId + "）" : "") +
          "；不会重复创建新意图。",
      );
      return;
    }
    if (draft.verbatim.trim() === "" && draft.verbatim !== "") {
      setCheckResult(null);
      setActionError(
        "原文只有空白字符：手动字段保存不会伪造原文。请清空原文后仅凭字段保存，或输入真实内容。",
      );
      return;
    }
    const fieldOnly = draft.verbatim === "";
    const verdict = validateInterval(draft.fields);
    if (!verdict.ok) {
      setCheckResult(null);
      setActionError(
        verdict.title + verdict.note + (fieldOnly ? " 手动字段保存需要完整的日期、开始与结束时间。" : ""),
      );
      return;
    }
    setActionError(null);
    setPending({
      kind: "intent",
      submitted: draft,
      command: buildIntentCommand({
        submitted: draft,
        interval: verdict.interval,
        target: openTarget,
        channel,
      }),
    });
  };

  const updateVerbatim = (value: string): void => {
    setDraft({ verbatim: value, fields: parseSentence(value) });
    setCheckResult(null);
    setActionError(null);
  };

  const updateField = (patch: Partial<DraftState["fields"]>): void => {
    setDraft({ ...draft, fields: { ...draft.fields, ...patch } });
    setCheckResult(null);
    setActionError(null);
  };

  const fields = draft.fields;
  const isEmpty = draft.verbatim.trim().length === 0;
  const hasTime =
    fields.dateText !== "" && fields.start !== "" && fields.end !== "";
  const intentLine = hasTime
    ? fields.dateText + " · " + fields.start + "—" + fields.end
    : "未确定";
  const currentVerdict = validateInterval(draft.fields);
  const currentIntervalKey = currentVerdict.ok ? intervalKey(currentVerdict.interval) : "";
  const checkVisible =
    checkResult !== null &&
    (checkResult.kind === "invalid" || checkResult.key === currentIntervalKey);
  const checkNoteLines =
    checkResult === null
      ? []
      : [
          ...checkResult.staticNotes,
          ...(checkResult.conflictIds.length > 0
            ? conflictNotes(state, checkResult.conflictIds)
            : []),
        ];

  if (!open) {
    return (
      <section className="s14" data-page="s14" aria-label="快捷输入">
        <div className="s14-closed">
          <p className="s14-closed-note">
            快捷入口已关闭。可从菜单或分享重新进入。
          </p>
          <button
            type="button"
            className="s14-btn"
            onClick={reopenCapture}
          >
            重新打开快捷入口
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="s14" data-page="s14" aria-label="快捷输入">
      <header className="s14-page-heading">
        <h1 className="s14-title">一句话，保留你的原意。</h1>
        <p className="s14-sub">轻量输入不意味着草率执行。先理解，再检查可行性。</p>
      </header>
      <div className="s14-modal">
        <header className="s14-head">
          <span className="s14-entry">快捷入口</span>
          <span className="s14-esc">ESC 关闭</span>
        </header>
        <label className="s14-field">
          <span className="s14-field-label">用一句话记录</span>
          <textarea
            className="s14-input"
            aria-label="用一句话记录"
            rows={2}
            value={draft.verbatim}
            disabled={pending !== null}
            onChange={(event) => updateVerbatim(event.target.value)}
          />
        </label>

        <div className="s14-capture-sources">
          <details className="s14-voice-panel">
            <summary>语音输入</summary>
          <SpeechInput disabled={pending !== null} onTranscript={text => {
            setDraft(current => {
              const verbatim = current.verbatim + (current.verbatim ? "\n" : "") + text;
              return { verbatim, fields: parseSentence(verbatim) };
            });
            setChannel("voice");
            setCaptureTarget(null);
            setSavedCapture(null);
            setCheckResult(null);
          }} />
          </details>
          <button type="button" aria-expanded={showShare} disabled={pending !== null} onClick={() => setShowShare(value => !value)}>从分享内容录入</button>
          <button
            type="button"
            aria-expanded={showEditor}
            onClick={() => setShowEditor((visible) => !visible)}
          >
            修改字段
          </button>
          <p className="s14-source-label">本次输入来源：{channel === "voice" ? "口述转写" : channel === "share" ? "分享内容" : "文字输入"} · 保存前可修改</p>
          {showShare && <div className="s14-share-panel">
            <label>分享的原文或链接<textarea aria-label="分享的原文或链接" value={shareText} onChange={event => setShareText(event.target.value)} /></label>
            <p>可粘贴内容，或使用 /capture?text=…&amp;url=… 链接传入。只接收文字与链接，不读取链接页面，不自动保存。</p>
            <button type="button" disabled={pending !== null || !shareText.trim()} onClick={() => {
              updateVerbatim(shareText);
              setChannel("share");
              setCaptureTarget(null);
              setSavedCapture(null);
              setShowShare(false);
            }}>将分享内容填入原文</button>
          </div>}
        </div>

        <p className="s14-parse-label">系统理解为</p>
        <div className="s14-cards">
          <article className="s14-card">
            <h2 className="s14-card-title"><Moon size={24} strokeWidth={1.7} aria-hidden="true" />个人时间意图</h2>
            <p className="s14-card-line">{intentLine}</p>
            <p className="s14-card-note">
              {hasTime
                ? "当前时区 UTC+8 · 可修改 · 尚未创建日历事件"
                : "未识别出完整时间；不会沿用默认时间。"}
            </p>
          </article>
          <article className="s14-card">
            <h2 className="s14-card-title"><LockKeyhole size={24} strokeWidth={1.7} aria-hidden="true" />不可擅自改变</h2>
            <p className="s14-card-line">
              {fields.constraint === "" ? "未确定" : "现有" + fields.constraint}
            </p>
            <p className="s14-card-note">
              没有自动授予改会或发消息权限。
            </p>
          </article>
        </div>

        {isEmpty ? (
          <p className="s14-empty" role="status">
            输入为空。可以填入示例，或直接修改下方字段后「只保存为意图」（手动字段保存，不伪造原文）。
          </p>
        ) : null}

        {showEditor ? (
          <div className="s14-editor">
            <label className="s14-editor-field">
              <span className="s14-editor-label">日期</span>
              <input
                className="s14-editor-input"
                aria-label="修改日期"
                value={fields.dateText}
                placeholder="如：9 月 13 日"
                disabled={pending !== null}
                onChange={(event) => updateField({ dateText: event.target.value })}
              />
            </label>
            <label className="s14-editor-field">
              <span className="s14-editor-label">开始时间</span>
              <input
                className="s14-editor-input"
                aria-label="修改开始时间"
                value={fields.start}
                placeholder="如：19:00"
                disabled={pending !== null}
                onChange={(event) => updateField({ start: event.target.value })}
              />
            </label>
            <label className="s14-editor-field">
              <span className="s14-editor-label">结束时间</span>
              <input
                className="s14-editor-input"
                aria-label="修改结束时间"
                value={fields.end}
                placeholder="如：20:00"
                disabled={pending !== null}
                onChange={(event) => updateField({ end: event.target.value })}
              />
            </label>
            <label className="s14-editor-field">
              <span className="s14-editor-label">约束对象</span>
              <input
                className="s14-editor-input"
                aria-label="修改约束对象"
                value={fields.constraint}
                placeholder="如：客户会议"
                disabled={pending !== null}
                onChange={(event) => updateField({ constraint: event.target.value })}
              />
            </label>
          </div>
        ) : null}

        {checkVisible && checkResult !== null ? (
          <div className={"s14-check is-" + checkResult.kind} role="status">
            <p className="s14-check-title">{checkResult.title}</p>
            {checkNoteLines.map((note, index) => (
              <p className="s14-check-note" key={checkResult.kind + "-" + index}>
                {note}
              </p>
            ))}
          </div>
        ) : null}

        <p className="s14-next">
          下一步只检查冲突。需要改变安排时，再向你展示具体差异。
        </p>

        {savedIntentId !== null ? (
          <p className="s14-saved" role="status">
            已保存为意图 · 记录 {savedIntentId}
            {savedCaptureVisible && savedCapture !== null && savedCapture.draftId !== null
              ? "（捕获草稿 " + savedCapture.draftId + " 已完成并链接）"
              : ""}
            。尚未创建日历事件，也不会通知任何人。
          </p>
        ) : null}
        {completedWithoutIntentLink ? (
          <p className="s14-saved" role="status">
            该捕获已保存为意图（历史记录缺少意图链接，捕获草稿 {savedCapture?.draftId}）；不会重复创建新意图。
          </p>
        ) : null}

        {savedIntentId !== null && pending === null && actionError === null ? (
          <div className="s14-actions" data-saved-intent-links={savedIntentId}>
            <Link
              className="s14-btn s14-btn-ghost"
              data-s14-open-now
              to={"/?intentId=" + encodeURIComponent(savedIntentId)}
            >
              查看此刻
            </Link>
            <Link
              className="s14-btn"
              data-s14-open-preview
              to={"/preview?intentId=" + encodeURIComponent(savedIntentId)}
            >
              打开预览
            </Link>
            <Link
              className="s14-btn s14-btn-ghost"
              data-s14-open-auth
              to={"/m/auth?intentId=" + encodeURIComponent(savedIntentId)}
            >
              打开移动授权
            </Link>
          </div>
        ) : null}

        {actionError !== null ? (
          <p className="s14-storage-error" role="alert">
            {actionError}
          </p>
        ) : null}

        {retryRequest !== null && pending === null ? (
          <div className="s14-actions">
            <button
              type="button"
              className="s14-btn s14-btn-ghost"
              onClick={() => {
                const retry = retryRequest;
                setRetryRequest(null);
                setPending(retry);
              }}
            >
              重试上次保存（原样重发同一命令）
            </button>
          </div>
        ) : null}

        <div className="s14-actions s14-primary-actions">
          <button
            type="button"
            className="s14-btn"
            onClick={requestCheck}
            disabled={pending !== null}
          >
            检查这段时间
            <Search size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="s14-btn s14-btn-ghost"
            onClick={requestIntent}
            disabled={pending !== null || captureLocked}
          >
            只保存为意图
          </button>
          <span className="s14-kbd">⌘ Enter</span>
        </div>

      </div>
      <footer className="s14-page-footer">
        <p>快速记录 / 自然语言 / 语音 / 分享到静驻 · 同一套语义与授权边界</p>
        <p>对照与保存都发生在本地共享状态（数据模式：{runtime.dataMode}）中；未检查任何外部日历，也未使用任何 LLM。</p>
      </footer>
    </section>
  );
}
