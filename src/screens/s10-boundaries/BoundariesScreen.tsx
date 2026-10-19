import { useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import "./s10-boundaries.css";
import { useDomainState } from "../../data/react.ts";
import type { DomainStore } from "../../domain/store.ts";
import type {
  GrantKey,
  PauseAutomationCommand,
  ResumeAutomationCommand,
  UpdateRulesCommand,
} from "../../domain/types.ts";
import {
  retryDomainRuntime,
  useDomainRuntime,
  type ReadyDomainRuntime,
} from "../../runtime/index.ts";
import { attentionDisclosure } from "../s09-attention/attentionSurface.ts";
import {
  actorLabel,
  CAPABILITY_ROWS,
  formatBlockRange,
  formatRulesTime,
  grantStatusLabel,
  GRANT_KEYS,
  GRANT_ROWS,
  parseDailyCapacityMinutes,
  parseDailyReminderMax,
  describeRulesFailure,
  selectActiveProtectedBlocks,
  selectLatestConfirmation,
  selectRulesHistory,
  verifyBudgetMaxReadback,
  verifyCapacityReadback,
  verifyGrantReadback,
  verifyPauseReadback,
  type GrantRow,
  type RulesActionReadback,
  type RulesRetryPlan,
} from "./boundarySurface.ts";

const DATA_MODE = "fixture" as const;

const TABS = ["行动权限", "时间边界", "打扰规则", "暂停与退出"] as const;

type Tab = (typeof TABS)[number];

function parseTabParam(raw: string | null): Tab {
  switch (raw) {
    case "时间边界":
      return "时间边界";
    case "打扰规则":
      return "打扰规则";
    case "暂停与退出":
      return "暂停与退出";
    default:
      return "行动权限";
  }
}

const NAV_GLYPHS: Record<Tab, string> = {
  行动权限: "◎",
  时间边界: "◷",
  打扰规则: "◔",
  暂停与退出: "‖",
};

type RulesUiCommand =
  | UpdateRulesCommand
  | PauseAutomationCommand
  | ResumeAutomationCommand;

type RulesActionKind = "grant" | "capacity" | "budgetMax" | "pause" | "resume";

interface RulesActionContext {
  kind: RulesActionKind;
  grantsPatch: Partial<Record<GrantKey, boolean>> | null;
  capacityValue: number | null;
  budgetMaxValue: number | null;
  expectedEpoch: number | null;
  expectedNextRevision: number | null;
  expectedNextBudgetRevision: number | null;
  targetTitle: string | null;
}

interface RulesActionError {
  code: string;
  reason: string;
  plan: RulesRetryPlan;
  command: RulesUiCommand | null;
  context: RulesActionContext;
  persistedUnknown: boolean;
}

const READBACK_UNVERIFIED_CODE = "STORAGE_READBACK_UNVERIFIED";

export function BoundariesScreen() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [runtimeEpoch, setRuntimeEpoch] = useState(0);
  const tab = parseTabParam(searchParams.get("tab"));
  const setTab = (next: Tab) => {
    setSearchParams(next === "行动权限" ? {} : { tab: next }, { replace: true });
  };
  return (
    <BoundariesRuntime
      key={runtimeEpoch}
      tab={tab}
      onTabChange={setTab}
      onRetrySettled={() => setRuntimeEpoch((epoch) => epoch + 1)}
    />
  );
}

interface BoundariesRuntimeProps {
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  onRetrySettled: () => void;
}

function BoundariesRuntime({ tab, onTabChange, onRetrySettled }: BoundariesRuntimeProps) {
  const runtime = useDomainRuntime(DATA_MODE);
  const [retrying, setRetrying] = useState(false);

  const retry = () => {
    if (retrying) return;
    setRetrying(true);
    void retryDomainRuntime(DATA_MODE).finally(() => {
      setRetrying(false);
      onRetrySettled();
    });
  };

  if (runtime.status === "loading") {
    return (
      <div className="s10" data-page="s10" data-runtime-state="loading">
        <header className="s10-head">
          <h1>智能可以学习，边界由你决定。</h1>
          <p>正在连接本地领域数据；确认之前不显示任何规则。</p>
        </header>
      </div>
    );
  }
  if (runtime.status === "unavailable") {
    return (
      <div
        className="s10"
        data-page="s10"
        data-runtime-state="unavailable"
        data-runtime-reason={runtime.reason}
      >
        <header className="s10-head">
          <h1>智能可以学习，边界由你决定。</h1>
        </header>
        <div className="s10-error" role="status">
          <p className="s10-error-title">本地领域数据当前不可读</p>
          <p className="s10-error-reason">原因：{runtime.reason}</p>
          <p className="s10-error-note">
            已保存的数据仍在本地，没有被清除。恢复连接之前，这里不显示规则与边界。
          </p>
          <button
            type="button"
            className="s10-btn-ghost"
            data-runtime-retry="runtime"
            onClick={retry}
            disabled={retrying}
          >
            {retrying ? "正在重试连接…" : "重试连接本地数据"}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div data-runtime-state="ready">
      <BoundariesReady handle={runtime.runtime} tab={tab} onTabChange={onTabChange} />
    </div>
  );
}

interface BoundariesReadyProps {
  handle: ReadyDomainRuntime;
  tab: Tab;
  onTabChange: (tab: Tab) => void;
}

function BoundariesReady({ handle, tab, onTabChange }: BoundariesReadyProps) {
  const store: DomainStore = handle.store;
  const state = useDomainState(store);
  const ruleset = state.ruleset;
  const activeBlocks = selectActiveProtectedBlocks(state);
  const historyRows = selectRulesHistory(ruleset);
  const latestConfirmation = selectLatestConfirmation(ruleset);
  const disclosure = attentionDisclosure(state.attention.budget);

  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<RulesActionError | null>(null);
  const mutationBlocked = busyKey !== null || actionError?.persistedUnknown === true;
  const [grantDrafts, setGrantDrafts] = useState<Partial<Record<GrantKey, boolean>>>({});
  const [capacityDraft, setCapacityDraft] = useState<string | null>(null);
  const [capacityBaseRevision, setCapacityBaseRevision] = useState<number | null>(null);
  const [capacityFieldError, setCapacityFieldError] = useState<string | null>(null);
  const [budgetMaxDraft, setBudgetMaxDraft] = useState<string | null>(null);
  const [budgetBaseRevision, setBudgetBaseRevision] = useState<number | null>(null);
  const [budgetFieldError, setBudgetFieldError] = useState<string | null>(null);
  const [resumedInvalidatedCount, setResumedInvalidatedCount] = useState<number | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const attemptRef = useRef(0);

  const verifyRulesReadback = (context: RulesActionContext): RulesActionReadback => {
    const storeState = store.getState();
    const persisted = handle.persistence.getState();
    if (context.kind === "grant" && context.grantsPatch !== null && context.expectedNextRevision !== null) {
      return verifyGrantReadback(storeState, persisted, context.grantsPatch, context.expectedNextRevision);
    }
    if (context.kind === "capacity" && context.capacityValue !== null && context.expectedNextRevision !== null) {
      return verifyCapacityReadback(storeState, persisted, context.capacityValue, context.expectedNextRevision);
    }
    if (
      context.kind === "budgetMax" &&
      context.budgetMaxValue !== null &&
      context.expectedNextRevision !== null &&
      context.expectedNextBudgetRevision !== null
    ) {
      return verifyBudgetMaxReadback(storeState, persisted, context.budgetMaxValue, context.expectedNextRevision, context.expectedNextBudgetRevision);
    }
    if (context.kind === "pause" && context.expectedEpoch !== null) {
      return verifyPauseReadback(storeState, persisted, true, context.expectedEpoch);
    }
    if (context.kind === "resume" && context.expectedEpoch !== null) {
      return verifyPauseReadback(storeState, persisted, false, context.expectedEpoch);
    }
    return { ok: false, persistedUnknown: false, reason: "无法核对本次操作结果。" };
  };

  const applyVerifiedEffects = (context: RulesActionContext) => {
    if (context.kind === "grant" && context.grantsPatch !== null) {
      setGrantDrafts((drafts) => {
        const next = { ...drafts };
        for (const key of GRANT_KEYS) {
          if (context.grantsPatch?.[key] !== undefined) delete next[key];
        }
        return next;
      });
    }
    if (context.kind === "capacity") {
      setCapacityDraft(null);
      setCapacityBaseRevision(null);
    }
    if (context.kind === "budgetMax") {
      setBudgetMaxDraft(null);
      setBudgetBaseRevision(null);
    }
  };

  const runRulesCommand = (
    command: RulesUiCommand,
    busy: string,
    context: RulesActionContext,
  ) => {
    if (busyKey !== null) return;
    if (actionError?.persistedUnknown && command !== actionError.command) return;
    setBusyKey(busy);
    setActionError(null);
    void store.execute(command)
      .then((result) => {
      if (!result.ok) {
        setActionError({
          code: result.code,
          reason: result.reason,
          ...describeRulesFailure(result, actionError?.persistedUnknown),
          command,
          context,
        });
        return;
      }
      if (context.kind === "resume" && "invalidatedApprovalIds" in result.data) {
        setResumedInvalidatedCount(result.data.invalidatedApprovalIds.length);
      }
      const check = verifyRulesReadback(context);
      if (!check.ok) {
        setActionError({
          code: READBACK_UNVERIFIED_CODE,
          reason: check.reason,
          plan: "replayExact",
          command,
          context,
          persistedUnknown: true,
        });
        return;
      }
      applyVerifiedEffects(context);
      })
      .catch(() => {
        setActionError({
          code: "RUNTIME_THROWN",
          reason: "执行过程出现异常，无法确认是否已保存。",
          plan: "replayExact",
          command,
          context,
          persistedUnknown: true,
        });
      })
      .finally(() => setBusyKey(null));
  };

  const retryAction = () => {
    const failed = actionError;
    if (failed === null || failed.command === null || busyKey !== null) return;
    runRulesCommand(failed.command, failed.context.kind + ":retry", failed.context);
  };

  const recaptureAction = () => {
    const failed = actionError;
    if (failed === null || failed.persistedUnknown) return;
    if (failed.context.kind === "grant") setGrantDrafts({});
    if (failed.context.kind === "capacity") {
      setCapacityDraft(null);
      setCapacityBaseRevision(null);
    }
    if (failed.context.kind === "budgetMax") {
      setBudgetMaxDraft(null);
      setBudgetBaseRevision(null);
    }
    setActionError(null);
  };

  const nextAttemptId = () => {
    attemptRef.current += 1;
    return String(attemptRef.current);
  };

  const applyGrantChange = (row: GrantRow, nextValue: boolean) => {
    if (mutationBlocked) return;
    const capturedRevision = ruleset.revision;
    const grantsPatch: Partial<Record<GrantKey, boolean>> = {};
    grantsPatch[row.key] = nextValue;
    setGrantDrafts((drafts) => ({ ...drafts, [row.key]: nextValue }));
    const command: UpdateRulesCommand = {
      commandId: "s10-grant-" + row.key + "-r" + capturedRevision + "-a" + nextAttemptId(),
      entityId: ruleset.id,
      expectedRevision: capturedRevision,
      actor: "user",
      issuedAt: new Date().toISOString(),
      type: "updateRules",
      grants: grantsPatch,
      summary: (nextValue ? "开启权限：" : "关闭权限：") + row.title,
    };
    runRulesCommand(command, "grant:" + row.key, {
      kind: "grant",
      grantsPatch,
      capacityValue: null,
      budgetMaxValue: null,
      expectedEpoch: null,
      expectedNextRevision: capturedRevision + 1,
      expectedNextBudgetRevision: null,
      targetTitle: row.title,
    });
  };

  const submitCapacity = () => {
    if (busyKey !== null) return;
    const parsed = parseDailyCapacityMinutes(capacityDraft ?? String(ruleset.dailyCapacityMinutes));
    if (!parsed.ok) {
      setCapacityFieldError(parsed.reason);
      return;
    }
    setCapacityFieldError(null);
    const capturedRevision = capacityBaseRevision ?? ruleset.revision;
    const command: UpdateRulesCommand = {
      commandId: "s10-capacity-r" + capturedRevision + "-a" + nextAttemptId(),
      entityId: ruleset.id,
      expectedRevision: capturedRevision,
      actor: "user",
      issuedAt: new Date().toISOString(),
      type: "updateRules",
      dailyCapacityMinutes: parsed.value,
      summary: "每日可用时间调整为 " + parsed.value + " 分钟",
    };
    runRulesCommand(command, "capacity", {
      kind: "capacity",
      grantsPatch: null,
      capacityValue: parsed.value,
      budgetMaxValue: null,
      expectedEpoch: null,
      expectedNextRevision: capturedRevision + 1,
      expectedNextBudgetRevision: null,
      targetTitle: "每日可用时间",
    });
  };

  const togglePause = (pause: boolean) => {
    if (busyKey !== null) return;
    const capturedRevision = ruleset.revision;
    const expectedEpoch = pause ? ruleset.pauseEpoch + 1 : ruleset.pauseEpoch;
    const base = {
      commandId: "s10-" + (pause ? "pause" : "resume") + "-e" + expectedEpoch + "-r" + capturedRevision + "-a" + nextAttemptId(),
      entityId: ruleset.id,
      expectedRevision: capturedRevision,
      actor: "user" as const,
      issuedAt: new Date().toISOString(),
    };
    const command: PauseAutomationCommand | ResumeAutomationCommand = pause
      ? { ...base, type: "pauseAutomation" }
      : { ...base, type: "resumeAutomation" };
    runRulesCommand(command, pause ? "pause" : "resume", {
      kind: pause ? "pause" : "resume",
      grantsPatch: null,
      capacityValue: null,
      budgetMaxValue: null,
      expectedEpoch,
      expectedNextRevision: null,
      expectedNextBudgetRevision: null,
      targetTitle: pause ? "暂停全部自动化" : "恢复自动化",
    });
  };

  const submitBudgetMax = () => {
    if (busyKey !== null) return;
    const parsed = parseDailyReminderMax(budgetMaxDraft ?? String(disclosure.dailyMax));
    if (!parsed.ok) {
      setBudgetFieldError(parsed.reason);
      return;
    }
    setBudgetFieldError(null);
    const capturedRevision = budgetBaseRevision ?? ruleset.revision;
    const capturedBudgetRevision = store.getState().attention.budget.revision;
    const command: UpdateRulesCommand = {
      commandId: "s10-budget-r" + capturedRevision + "-a" + nextAttemptId(),
      entityId: ruleset.id,
      expectedRevision: capturedRevision,
      actor: "user",
      issuedAt: new Date().toISOString(),
      type: "updateRules",
      dailyReminderMax: parsed.value,
      summary: "每日提醒上限调整为 " + parsed.value + " 次",
    };
    runRulesCommand(command, "budgetMax", {
      kind: "budgetMax",
      grantsPatch: null,
      capacityValue: null,
      budgetMaxValue: parsed.value,
      expectedEpoch: null,
      expectedNextRevision: capturedRevision + 1,
      expectedNextBudgetRevision: capturedBudgetRevision + 1,
      targetTitle: "每日提醒上限",
    });
  };

  const displayGrant = (key: GrantKey): boolean =>
    grantDrafts[key] ?? ruleset.grants[key];

  const pauseErrorVisible =
    actionError !== null &&
    (actionError.context.kind === "pause" || actionError.context.kind === "resume");

  const panelError =
    actionError !== null &&
    ((actionError.persistedUnknown && tab !== "暂停与退出") || actionError.context.kind === "grant" ||
      actionError.context.kind === "capacity" ||
      actionError.context.kind === "budgetMax")
      ? actionError
      : null;

  return (
    <div className="s10" data-page="s10" data-ruleset-revision={ruleset.revision} data-paused={ruleset.paused ? "true" : "false"}>
      <header className="s10-head">
        <h1>智能可以学习，边界由你决定。</h1>
        <p>规则不是提示词。每次读取、写入与打扰，都受它约束。</p>
      </header>
      <div className="s10-layout">
        <aside className="s10-rail" aria-label="我的规则">
          <h2>我的规则</h2>
          <nav className="s10-nav" data-rule-nav aria-label="规则分类">
            {TABS.map((name) => (
              <button
                key={name}
                type="button"
                className="s10-nav-btn"
                aria-current={tab === name ? "true" : undefined}
                onClick={() => onTabChange(name)}
              >
                <span className="s10-nav-glyph" aria-hidden="true">
                  {NAV_GLYPHS[name]}
                </span>
                {name}
              </button>
            ))}
          </nav>
          <div className="s10-version">
            <p data-ruleset-version={"r" + ruleset.revision}>规则版本 {ruleset.revision}</p>
            {latestConfirmation === null ? (
              <p data-latest-confirmation="none">还没有由你确认的版本记录。</p>
            ) : (
              <p data-latest-confirmation={"r" + latestConfirmation.revision}>
                {actorLabel(latestConfirmation.actor)}于{" "}
                {formatRulesTime(latestConfirmation.at, ruleset.timezone) ?? latestConfirmation.at}
              </p>
            )}
            <p>暂停计次 {ruleset.pauseEpoch}{ruleset.paused ? "（当前暂停中）" : ""}</p>
          </div>
          <p className="s10-railnote">
            AI 可以提出修改建议，但不能自行让它生效。
          </p>
          <button
            type="button"
            className="s10-btn-ghost"
            aria-expanded={showHistory}
            onClick={() => setShowHistory((v) => !v)}
          >
            查看规则变更记录
            <span aria-hidden="true">→</span>
          </button>
          {showHistory && (
            <ul className="s10-history-list" data-history-state={historyRows.length === 0 ? "empty" : "rows"}>
              {historyRows.length === 0 ? (
                <li>还没有规则变更记录。</li>
              ) : (
                historyRows.map((row) => (
                  <li key={row.revision} data-history-revision={row.revision}>
                    r{row.revision} ·{" "}
                    {formatRulesTime(row.at, ruleset.timezone) ?? row.at} ·{" "}
                    {actorLabel(row.actor)}：{row.description}
                  </li>
                ))
              )}
            </ul>
          )}
        </aside>
        <section className="s10-panel" aria-label={tab}>
          <header className="s10-panel-head">
            <h2>{tab}</h2>
            {tab === "行动权限" && (
              <span className="s10-chip">本人的规则优先</span>
            )}
          </header>
          {panelError !== null && (
            <div
              className="s10-error"
              role="alert"
              data-error-code={panelError.code}
              data-error-plan={panelError.plan}
            >
              <p className="s10-error-title">
                {panelError.persistedUnknown
                  ? "结果未确认；不会当作已保存"
                  : panelError.plan === "recapture"
                    ? "规则版本已变化，你的修改没有生效"
                    : "操作没有完成"}
              </p>
              <p className="s10-error-reason">原因：{panelError.reason}</p>
              {panelError.plan === "recapture" && !panelError.persistedUnknown ? (
                <div className="s10-error-actions">
                  <button type="button" className="s10-btn-ghost" onClick={recaptureAction}>
                    重新读取当前规则（放弃候选修改）
                  </button>
                  <button type="button" className="s10-btn-ghost" onClick={() => setActionError(null)}>
                    保留我的修改，稍后处理
                  </button>
                </div>
              ) : (
                <div className="s10-error-actions">
                  <button type="button" className="s10-btn-ghost" onClick={retryAction}>
                    重试同一操作
                  </button>
                  {!panelError.persistedUnknown && <button type="button" className="s10-btn-ghost" onClick={recaptureAction}>
                    放弃候选修改
                  </button>}
                </div>
              )}
            </div>
          )}
          {tab === "行动权限" && (
            <div className="s10-rules">
              {GRANT_ROWS.map((row) => {
                const actual = ruleset.grants[row.key];
                const shown = displayGrant(row.key);
                const status = grantStatusLabel(actual);
                const busy = busyKey === "grant:" + row.key;
                const pending = shown !== actual;
                return (
                  <article key={row.key} className="s10-rule-row" data-rule-row={row.key}>
                    <div>
                      <h3 className="s10-rule-title">
                        <label className="s10-check">
                          <input
                            type="checkbox"
                            checked={shown}
                            disabled={mutationBlocked}
                            onChange={() => applyGrantChange(row, !shown)}
                          />
                          <span>{row.title}</span>
                        </label>
                      </h3>
                      <p className="s10-rule-desc">{row.desc}</p>
                      {pending && (
                        <p className="s10-rule-note" data-grant-candidate={row.key}>
                          有待保存的候选修改（{shown ? "开启" : "关闭"}）；未经确认不会当作已保存。
                        </p>
                      )}
                    </div>
                    <span className={"s10-status s10-status-" + status.tone} data-grant-state={row.key}>
                      {busy ? "保存中…" : status.label}
                    </span>
                  </article>
                );
              })}
              {CAPABILITY_ROWS.map((row) => (
                <article key={row.title} className="s10-rule-row" data-capability-row={row.title}>
                  <div>
                    <h3 className="s10-rule-title">{row.title}</h3>
                    <p className="s10-rule-desc">{row.desc}</p>
                    <p className="s10-rule-note">{row.note}</p>
                  </div>
                  <span className="s10-status s10-status-locked" data-capability-state="not-implemented">
                    没有对应权限项
                  </span>
                </article>
              ))}
            </div>
          )}
          {tab === "时间边界" && (
            <div className="s10-tabbody">
              <ul className="s10-blocks" data-blocks-state={activeBlocks.length === 0 ? "empty" : "rows"}>
                {activeBlocks.length === 0 ? (
                  <li>当前没有进行中的保护时段记录；这里不显示虚构时段。</li>
                ) : (
                  activeBlocks.map((block) => (
                    <li key={block.id} data-protected-block={block.blockId}>
                      <span className="s10-tabline">{formatBlockRange(block, ruleset.timezone)} 已保护。</span>
                      <span className="s10-tabnote">
                        {block.purpose !== null && block.purpose.trim() !== ""
                          ? "用途：" + block.purpose
                          : "这个时段没有填写用途。"}
                      </span>
                    </li>
                  ))
                )}
              </ul>
              <p className="s10-tabnote">与静驻时刻共用同一边界。</p>
              <div className="s10-capacity" data-capacity-state={busyKey === "capacity" ? "saving" : "idle"}>
                <label className="s10-capacity-field">
                  <span>每日可用时间（分钟）</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={capacityDraft ?? String(ruleset.dailyCapacityMinutes)}
                    disabled={mutationBlocked}
                    onChange={(event) => {
                      const value = event.target.value;
                      setCapacityDraft(value);
                      setCapacityBaseRevision((current) =>
                        current === null ? ruleset.revision : current,
                      );
                    }}
                  />
                </label>
                {capacityFieldError !== null && (
                  <p className="s10-capacity-error" role="alert">{capacityFieldError}</p>
                )}
                <button
                  type="button"
                  className="s10-btn-primary"
                  disabled={mutationBlocked}
                  onClick={submitCapacity}
                >
                  {busyKey === "capacity" ? "正在保存…" : "保存每日可用时间"}
                </button>
                <p className="s10-rule-note">
                  修改可用时间不会自动移动或调整任何保护时段。保存使用你开始编辑时的规则版本
                  {capacityBaseRevision === null ? "（尚未开始编辑）" : " r" + String(capacityBaseRevision)}
                  提交；期间若有其他规则变更，保存会被拒绝，需要重新读取后再保存。
                </p>
              </div>
            </div>
          )}
          {tab === "打扰规则" && (
            <div className="s10-tabbody">
              <p className="s10-tabline">每天最多 {disclosure.dailyMax} 次非紧急提醒。</p>
              <p className="s10-tabnote">与注意力队列共用同一份预算。</p>
              <p className="s10-budget-meta" data-budget-day={disclosure.budgetDay}>
                预算日 {disclosure.budgetDay}（{disclosure.timezone}）· 今日已用 {disclosure.used} 次 ·
                剩余 {disclosure.remaining} 次 · 已投递 {disclosure.deliveredCount} 条 · 待投递 {disclosure.queueCount} 条。
              </p>
              <div className="s10-capacity" data-budget-edit="explicit" data-budget-state={busyKey === "budgetMax" ? "saving" : "idle"}>
                <label className="s10-capacity-field">
                  <span>每日提醒上限（次）</span>
                  <input
                    type="number"
                    min={0}
                    max={10}
                    step={1}
                    value={budgetMaxDraft ?? String(disclosure.dailyMax)}
                    disabled={mutationBlocked}
                    onChange={(event) => {
                      const value = event.target.value;
                      setBudgetMaxDraft(value);
                      setBudgetBaseRevision((current) =>
                        current === null ? ruleset.revision : current,
                      );
                    }}
                  />
                </label>
                {budgetFieldError !== null && (
                  <p className="s10-capacity-error" role="alert">{budgetFieldError}</p>
                )}
                <button
                  type="button"
                  className="s10-btn-primary"
                  disabled={mutationBlocked}
                  onClick={submitBudgetMax}
                >
                  {busyKey === "budgetMax" ? "正在保存…" : "保存每日提醒上限"}
                </button>
                <p className="s10-rule-note">
                  修改上限不会清除已用记录、待投递队列或已投递历史；降到已用次数之下时，剩余次数显示为 0。
                  保存使用你开始编辑时的规则版本
                  {budgetBaseRevision === null ? "（尚未开始编辑）" : " r" + String(budgetBaseRevision)}
                  提交；期间若有其他规则变更，保存会被拒绝，需要重新读取后再保存。
                </p>
              </div>
            </div>
          )}
          {tab === "暂停与退出" && (
            <div className="s10-tabbody">
              <p className="s10-tabline">暂停随时可以恢复。</p>
              <p className="s10-tabnote">
                暂停后停止新的自动读取、草稿准备、写入与主动提醒；你手动发起的操作仍须逐项授权。
              </p>
              {resumedInvalidatedCount !== null && (
                <p className="s10-tabnote" data-resume-invalidated={resumedInvalidatedCount}>
                  {resumedInvalidatedCount === 0
                    ? "上次恢复时重校验：没有批准需要失效。"
                    : "上次恢复时重校验：" + resumedInvalidatedCount + " 个批准因状态变化被标记失效。"}
                </p>
              )}
            </div>
          )}
          <div className="s10-pause">
            <div className="s10-pause-info">
              <h3 className="s10-pause-title">暂停全部自动化</h3>
              <p className="s10-pause-note">
                事项与未完成责任保留；手动操作仍须对应许可。
              </p>
              {ruleset.paused && (
                <p className="s10-paused" data-pause-epoch={ruleset.pauseEpoch}>
                  自动化已暂停：不再启动自动步骤与主动提醒。（暂停计次 {ruleset.pauseEpoch}
                  {pauseErrorVisible && actionError !== null && actionError.persistedUnknown
                    ? "；持久层读回未知，未确认已保存"
                    : ""}）
                </p>
              )}
              {pauseErrorVisible && actionError !== null && (
                <div
                  className="s10-error"
                  role="alert"
                  data-error-code={actionError.code}
                  data-error-plan={actionError.plan}
                >
                  <p className="s10-error-title">
                    {actionError.persistedUnknown ? "结果未确认；不会当作已保存" : "操作没有完成"}
                  </p>
                  <p className="s10-error-reason">原因：{actionError.reason}</p>
                  <div className="s10-error-actions">
                    {actionError.command !== null && actionError.plan === "replayExact" && (
                      <button type="button" className="s10-btn-ghost" onClick={retryAction}>
                        重试同一操作
                      </button>
                    )}
                    {!actionError.persistedUnknown && <button type="button" className="s10-btn-ghost" onClick={() => setActionError(null)}>
                      知道了
                    </button>}
                  </div>
                </div>
              )}
            </div>
            {ruleset.paused ? (
              <button
                type="button"
                className="s10-btn-ghost"
                disabled={mutationBlocked}
                onClick={() => togglePause(false)}
              >
                {busyKey === "resume" ? "正在恢复…" : "恢复自动化"}
                <span aria-hidden="true">→</span>
              </button>
            ) : (
              <button
                type="button"
                className="s10-btn-primary"
                disabled={mutationBlocked}
                onClick={() => togglePause(true)}
              >
                {busyKey === "pause" ? "正在暂停…" : "立即暂停"}
                <span aria-hidden="true">‖</span>
              </button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
