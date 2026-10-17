import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useDomainState } from "../../data/react.ts";
import { defaultUuid } from "../../domain/ids.ts";
import type { DomainStore } from "../../domain/store.ts";
import type {
  Checkpoint,
  DataMode,
  DomainState,
  Draft,
  EntityId,
  Operation,
} from "../../domain/types.ts";
import { retryDomainRuntime, useDomainRuntime } from "../../runtime/index.ts";
import "./s07-session.css";
import { CheckpointNotes } from "./CheckpointNotes.tsx";
import { CheckpointRules } from "./CheckpointRules.tsx";
import { QuietArtwork } from "../../components/QuietArtwork.tsx";

function formatClock(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(ms);
}

function formatStamp(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(ms);
}

function issueCommand(): { commandId: string; actor: "user"; issuedAt: string } {
  return { commandId: defaultUuid(), actor: "user", issuedAt: new Date().toISOString() };
}

interface SessionQuery {
  present: boolean;
  value: string | null;
}

function readSessionQuery(params: URLSearchParams): SessionQuery {
  const raw = params.get("checkpointId");
  if (raw === null) return { present: false, value: null };
  const value = raw.trim();
  return { present: true, value: value === "" ? null : value };
}

function isWithdrawnDraft(draft: Draft): boolean {
  return String(draft.status) === "withdrawn";
}

type DraftBlockedKind = "withdrawn" | "sent" | null;

function draftBlockedKind(draft: Draft | null): DraftBlockedKind {
  if (!draft) return null;
  if (isWithdrawnDraft(draft)) return "withdrawn";
  if (draft.sentAt !== null || String(draft.status) === "sent") return "sent";
  return null;
}

function ownsDraftViaStepReceipts(operation: Operation, draftId: EntityId): boolean {
  return operation.stepReceipts.some(
    (receipt) =>
      receipt.actionKind === "createDraft" && receipt.status === "completed" && receipt.resultRef === draftId,
  );
}

function operationOwnsDraft(operation: Operation, draftId: EntityId): boolean {
  if (operation.resultRefs.includes(draftId)) return true;
  return operation.resultRefs.length === 0 && ownsDraftViaStepReceipts(operation, draftId);
}

type WorkspaceBack =
  | { kind: "available"; href: string }
  | { kind: "unavailable"; reason: string };

function workspaceBackFor(domain: DomainState, checkpoint: Checkpoint): WorkspaceBack {
  if (!checkpoint.draftId) return { kind: "unavailable", reason: "检查点没有关联草稿" };
  const draft = domain.drafts[checkpoint.draftId];
  if (!draft) return { kind: "unavailable", reason: "检查点关联的草稿在当前数据中不存在" };
  if (isWithdrawnDraft(draft)) return { kind: "unavailable", reason: "检查点关联的草稿已撤回；工作台写回不可用" };
  if (draftBlockedKind(draft) === "sent") return { kind: "unavailable", reason: "检查点关联的草稿已发送；工作台写回不可用" };
  const operation = domain.operations[draft.operationId];
  if (!operation || draft.operationId !== operation.id || !operationOwnsDraft(operation, draft.id)) {
    return { kind: "unavailable", reason: "无法证明这份草稿由对应执行操作生成" };
  }
  return {
    kind: "available",
    href: "/workspace?draftId=" + encodeURIComponent(draft.id) + "&operationId=" + encodeURIComponent(operation.id),
  };
}

interface CurrentDrift {
  changed: boolean;
  details: string[];
}

type BoundRefStatus =
  | { kind: "current"; label: string }
  | { kind: "stale"; reason: string };

function boundRefStatus(
  domain: DomainState,
  refId: EntityId,
  boundVersion: number,
  draftId: EntityId | null,
): BoundRefStatus {
  const source = domain.sources[refId];
  if (source) {
    if (source.sourceVersion !== boundVersion) {
      return {
        kind: "stale",
        reason:
          "来源 " + source.connectorId + " 的版本已变化（检查点记录 v" + boundVersion + "，当前 v" + source.sourceVersion + "）",
      };
    }
    return { kind: "current", label: source.connectorId };
  }
  const material = domain.materials[refId];
  if (material) {
    if (!domain.ruleset.grants.readMaterial) {
      return {
        kind: "stale",
        reason:
          "材料 " + material.name + " 处于全局材料读取关闭状态；即使保存时已获授权，现在也不能当作当前可用来源",
      };
    }
    if (material.readPermission !== "granted") {
      return { kind: "stale", reason: "材料 " + material.name + " 未获明确读取授权，不能当作当前可用来源" };
    }
    if (material.draftId !== draftId) {
      return { kind: "stale", reason: "材料 " + material.name + " 未关联到这个检查点的草稿" };
    }
    if (material.version !== boundVersion) {
      return {
        kind: "stale",
        reason: "材料 " + material.name + " 的版本已变化（检查点记录 v" + boundVersion + "，当前 v" + material.version + "）",
      };
    }
    return { kind: "current", label: material.name };
  }
  return { kind: "stale", reason: refId + " 在当前数据中不存在" };
}

function boundRefLabel(domain: DomainState, refId: EntityId): string {
  return domain.sources[refId]?.connectorId ?? domain.materials[refId]?.name ?? refId + "（当前不存在）";
}

// Mirrors the domain resumeCheckpoint comparison basis (bound refs resolve as a
// Source at the bound version OR a Material granted for this checkpoint's draft
// at the bound version while the global readMaterial grant is on; the domain
// handler is authoritative), plus draft version/revision, confirmed section
// versions, current withdrawn/sent state, and legacy metadata completeness, so
// the UI can tell when a previously recorded validation can no longer be
// claimed up-to-date. Read-only: the domain result stays authoritative.
function currentDriftSinceCheckpoint(domain: DomainState, checkpoint: Checkpoint): CurrentDrift {
  const details: string[] = [];
  for (const [sid, boundVersion] of Object.entries(checkpoint.sourceVersionSet)) {
    const status = boundRefStatus(domain, sid, boundVersion, checkpoint.draftId);
    if (status.kind === "stale") {
      details.push(status.reason);
    }
  }
  const draft = checkpoint.draftId ? domain.drafts[checkpoint.draftId] : null;
  if (checkpoint.draftVersion !== null && (!draft || draft.version !== checkpoint.draftVersion)) {
    details.push("草稿版本已变化");
  }
  if (draft && typeof checkpoint.draftRevision === "number" && draft.revision !== checkpoint.draftRevision) {
    details.push("草稿修订号已变化（检查点记录 r" + checkpoint.draftRevision + "，当前 r" + draft.revision + "）");
  }
  const confirmedMismatch = checkpoint.confirmedDecisions.some((cd) => {
    const section = draft?.sections.find((s) => s.id === cd.sectionId);
    return !section || section.contentVersion !== cd.contentVersion || section.reviewStatus !== "confirmed";
  });
  if (confirmedMismatch) details.push("已确认小节与检查点记录不再一致");
  const blocked = draftBlockedKind(draft);
  if (blocked === "withdrawn") {
    details.push("草稿当前已撤回：核对只能作为报告，不会重新激活草稿");
  } else if (blocked === "sent") {
    details.push("草稿当前已发送：核对只能作为报告，不会重新激活或撤回内容");
  }
  if (
    checkpoint.draftId !== null &&
    (checkpoint.draftRevision === undefined ||
      checkpoint.sectionIssues === undefined ||
      checkpoint.materials.some((m) => m.sectionIds === undefined))
  ) {
    details.push("旧检查点缺少修订号/小节问题/材料小节关联元数据，完整性无法证明");
  }
  return { changed: details.length > 0, details };
}

export function SessionScreen() {
  const [searchParams] = useSearchParams();
  const [runtimeEpoch, setRuntimeEpoch] = useState(0);
  const query = readSessionQuery(searchParams);

  return (
    <div className="s07" data-page="s07">
      <header className="s07-head">
        <h1>从刚才那个判断继续。</h1>
        <p>恢复的不只是任务名字，而是你上次离开时真实保存的工作现场。</p>
      </header>
      <SessionRuntime
        key={runtimeEpoch}
        dataMode="fixture"
        query={query}
        onRetrySettled={() => setRuntimeEpoch((epoch) => epoch + 1)}
      />
    </div>
  );
}

interface SessionRuntimeProps {
  dataMode: DataMode;
  query: SessionQuery;
  onRetrySettled: () => void;
}

function SessionRuntime({ dataMode, query, onRetrySettled }: SessionRuntimeProps) {
  const runtime = useDomainRuntime(dataMode);
  const [retrying, setRetrying] = useState(false);

  const retry = () => {
    if (retrying) return;
    setRetrying(true);
    retryDomainRuntime(dataMode)
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
      <div className="s07-boundary" data-runtime-state="loading">
        <h2 className="s07-serif-md">正在连接本地领域数据…</h2>
      </div>
    );
  }
  if (runtime.status === "unavailable") {
    return (
      <div className="s07-boundary s07-boundary-error" data-runtime-state="unavailable">
        <h2 className="s07-serif-md">本地领域数据当前不可读</h2>
        <p className="s07-body" data-runtime-reason>
          {runtime.handle && runtime.handle.status !== "ready"
            ? runtime.handle.status + "：" + runtime.reason
            : "初始化失败：" + runtime.reason}
        </p>
        <p className="s07-note">原始数据已保留，未被清除；存储恢复之前不会显示任何检查点。</p>
        <div className="s07-actions">
          <button
            type="button"
            className="s07-btn-ghost"
            data-runtime-retry
            onClick={retry}
            disabled={retrying}
          >
            {retrying ? "正在重试连接…" : "重试连接本地数据"}
            <span aria-hidden="true">↻</span>
          </button>
        </div>
      </div>
    );
  }
  return (
    <div data-runtime-state="ready">
      <SessionReady store={runtime.runtime.store} query={query} />
    </div>
  );
}

interface SessionReadyProps {
  store: DomainStore;
  query: SessionQuery;
}

function SessionReady({ store, query }: SessionReadyProps) {
  const domain = useDomainState(store);

  if (!query.present) {
    return <SessionCheckpointPicker domain={domain} />;
  }
  if (query.value === null) {
    return <SessionRefusal kind="stillness" />;
  }
  const checkpoint = domain.checkpoints[query.value];
  if (!checkpoint) {
    return <SessionRefusal kind="not-found" />;
  }
  return (
    <SessionCheckpoint
      key={checkpoint.id}
      store={store}
      checkpoint={checkpoint}
      domain={domain}
    />
  );
}

function SessionCheckpointPicker({ domain }: { domain: DomainState }) {
  const checkpoints = Object.values(domain.checkpoints).sort(
    (a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt),
  );
  return (
    <div className="s07-layout">
      <section className="s07-checkpoint" aria-label="检查点索引">
        <span className="s07-chip">工作检查点</span>
        <h2 className="s07-serif-lg">从哪个检查点继续？</h2>
        <p className="s07-body">
          这里只列出本数据空间真实保存过的检查点；不会替你默认挑选。
        </p>
        <div className="s07-ring"><QuietArtwork /></div>
        <div className="s07-checkpoint-foot">
          <p className="s07-serif-md">共 {checkpoints.length} 个检查点</p>
          <p className="s07-note">本地示例数据（fixture）；恢复检查点不会发送任何内容。</p>
        </div>
      </section>
      <section className="s07-restore" aria-label="已保存的检查点" data-checkpoint-list={checkpoints.length === 0 ? "empty" : "ready"}>
        <h3 className="s07-kicker">
          <span className="s07-num">01</span>已保存的检查点（按保存时间）
        </h3>
        {checkpoints.length === 0 ? (
          <div>
            <p className="s07-body" data-checkpoint-empty>
              现在还没有任何已保存的检查点；这里不会显示示例内容顶替。
            </p>
            <div className="s07-actions">
              <Link className="s07-btn-ghost" data-goto-workspace to="/workspace">
                去工作台保存第一个检查点
              </Link>
            </div>
          </div>
        ) : (
          <ul className="s07-checkpoint-items">
            {checkpoints.map((cp) => (
              <li key={cp.id} className="s07-checkpoint-item" data-checkpoint-option={cp.id}>
                <div>
                  <p className="s07-serif-md">保存于 {formatStamp(cp.savedAt)}</p>
                  <p className="s07-note">
                    {cp.nextStep ? "下一步：" + cp.nextStep : "未记录下一步。"}
                  </p>
                </div>
                <Link
                  className="s07-link"
                  data-checkpoint-link={cp.id}
                  to={"/session?checkpointId=" + encodeURIComponent(cp.id)}
                >
                  打开这个检查点
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function SessionRefusal({ kind }: { kind: "stillness" | "not-found" }) {
  const blank = kind === "stillness";
  return (
    <div className="s07-boundary" data-checkpoint-state={blank ? "blank-id" : "not-found"}>
      <h2 className="s07-serif-lg">{blank ? "链接里的检查点 ID 是空的" : "找不到这个检查点"}</h2>
      <p className="s07-body">
        {blank
          ? "链接带了 checkpointId 参数但没有携带 ID；这里不会回退到其他检查点。"
          : "链接指定的检查点在当前数据空间不存在；这里不会用其他检查点或示例内容顶替。"}
      </p>
      <Link className="s07-link" data-checkpoint-index-link to="/session">
        查看已保存的检查点
      </Link>
    </div>
  );
}

interface SessionCheckpointProps {
  store: DomainStore;
  checkpoint: Checkpoint;
  domain: DomainState;
}

function SessionCheckpoint({ store, checkpoint, domain }: SessionCheckpointProps) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const draft = checkpoint.draftId ? domain.drafts[checkpoint.draftId] : null;
  const commitment = draft ? domain.commitments[draft.commitmentId] : null;
  const draftTitle = (commitment?.scope ?? "协同工作") + " · 工作草稿";
  const validation = checkpoint.resumeValidation;
  const drift = currentDriftSinceCheckpoint(domain, checkpoint);
  const back = workspaceBackFor(domain, checkpoint);
  const blocked = draftBlockedKind(draft);
  const savedSectionIssuesExtra = (checkpoint.sectionIssues ?? []).filter(
    (entry) => !checkpoint.openQuestions.includes("[" + entry.sectionId + "] " + entry.issue),
  );

  const resume = async () => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    let result;
    try {
      result = await store.execute({
        type: "resumeCheckpoint",
        ...issueCommand(),
        entityId: checkpoint.id,
        expectedRevision: checkpoint.revision,
      });
    } catch (err) {
      setBusy(false);
      setFailure("命令执行出现意外错误：" + (err instanceof Error ? err.message : String(err)));
      return;
    }
    setBusy(false);
    if (!result.ok) {
      setFailure(result.code + "：" + result.reason + (result.retryable ? "（可重试）" : "（不可重试）"));
      return;
    }
  };

  return (
    <div className="s07-layout" data-checkpoint-state="ready" data-checkpoint-id={checkpoint.id}>
      <section className="s07-checkpoint" aria-label="工作检查点">
        <span className="s07-chip">工作检查点 · {formatClock(checkpoint.savedAt)}</span>
        <h2 className="s07-serif-lg">
          {checkpoint.draftId ? draftTitle : "未关联草稿的检查点"}
        </h2>
        <p className="s07-body">
          {checkpoint.draftId
            ? "保存时记录的草稿版本 v" + (checkpoint.draftVersion ?? "—") +
              (draft ? "；当前草稿已是 v" + draft.version : "；当前数据中找不到这份草稿")
            : "这个检查点保存时没有关联草稿。"}
        </p>
        {checkpoint.draftId !== null && (
          <p
            className="s07-note"
            data-checkpoint-draft-revision={typeof checkpoint.draftRevision === "number" ? String(checkpoint.draftRevision) : "unknown"}
          >
            {typeof checkpoint.draftRevision === "number"
              ? "保存时记录的草稿修订号 r" + checkpoint.draftRevision +
                (draft ? "；当前草稿修订号 r" + draft.revision : "；当前数据中找不到这份草稿")
              : "旧检查点未记录保存时草稿修订号，无法证明完整。"}
          </p>
        )}
        <div className="s07-ring"><QuietArtwork /></div>
        <div className="s07-checkpoint-foot">
          <p className="s07-serif-md">下一步</p>
          <p className="s07-note" data-next-step={checkpoint.nextStep ? "stored" : "none"}>
            {checkpoint.nextStep ? checkpoint.nextStep : "此检查点没有记录下一步。"}
          </p>
          <p className="s07-note">
            保存于 {formatStamp(checkpoint.savedAt)} · 本地示例数据（fixture）；恢复检查点不会发送任何内容。
          </p>
        </div>
      </section>
      <section className="s07-restore" aria-label="恢复工作现场">
        <div
          className={blocked ? "s07-blocked-banner" : "s07-current-state-line"}
          data-current-draft-state={blocked ?? "active"}
          role={blocked ? "alert" : undefined}
        >
          {blocked === "withdrawn"
            ? "当前状态：草稿已撤回。不能重新激活、重新生成、编辑或重新发送这份草稿；已保存的内容与历史记录仍然保留。"
            : blocked === "sent"
              ? "当前状态：草稿已发送。不能编辑、撤回或重新生成已发送的内容；已保存的内容与历史记录仍然保留。"
              : "当前状态：草稿未撤回、未发送，仍处于可继续工作的状态。"}
        </div>
        <h3 className="s07-kicker">
          <span className="s07-num">01</span>上次确认的取舍
        </h3>
        {checkpoint.confirmedDecisions.length === 0 ? (
          <p className="s07-body" data-confirmed-decisions="empty">
            此检查点没有已确认小节的记录。
          </p>
        ) : (
          <ul className="s07-decision-list" data-confirmed-decisions="recorded">
            {checkpoint.confirmedDecisions.map((cd) => {
              const section = draft?.sections.find((s) => s.id === cd.sectionId);
              return (
                <li key={cd.sectionId + ":" + cd.contentVersion} className="s07-confirmed" data-confirmed-decision={cd.sectionId}>
                  <span className="s07-status-ok">当时确认</span>
                  <p>
                    {section ? section.title : "该小节在当前草稿中已不存在（" + cd.sectionId + "）"}
                    {" "}· 记录的正文版本 v{cd.contentVersion}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
        <p className="s07-note">“当时确认”是保存时刻的记录，不代表这些小节现在仍处于已确认状态。</p>

        <h3 className="s07-kicker">
          <span className="s07-num">02</span>当时未决定的问题
        </h3>
        {checkpoint.openQuestions.length === 0 ? (
          <p className="s07-body" data-open-questions="empty">
            此检查点没有未决定问题的记录。
          </p>
        ) : (
          <ul className="s07-note-list" data-open-questions="recorded">
            {checkpoint.openQuestions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        )}

        <div className="s07-divider" role="presentation" />

        <h3 className="s07-kicker">
          <span className="s07-num">03</span>
          {blocked ? "核对报告（不恢复草稿）" : "恢复这个检查点"}
        </h3>
        <p className="s07-body">
          {blocked
            ? "顶部显示的当前状态（已撤回或已发送）使恢复操作不再提供。下面的按钮只调用同一条报告检查命令，更新历史核对报告；它不会恢复、激活或修改草稿。"
            : "恢复会先做一次真实检查：核对来源与已获授权材料的版本、草稿版本和已确认小节。只有你点击下面的按钮才会执行。"}
        </p>
        <div className="s07-actions">
          {blocked ? (
            <button
              type="button"
              className="s07-btn-ghost"
              data-report-recheck
              onClick={resume}
              disabled={busy}
            >
              {busy ? "正在更新报告…" : "更新历史核对报告（不恢复草稿）"}
              <span aria-hidden="true">↻</span>
            </button>
          ) : (
            <button
              type="button"
              className="s07-btn-primary"
              data-resume-checkpoint
              onClick={resume}
              disabled={busy}
            >
              {busy ? "正在检查恢复…" : "恢复到这个检查点"}
              <span aria-hidden="true">→</span>
            </button>
          )}
        </div>
        {failure && (
          <p className="s07-error" data-resume-error>
            {failure}
          </p>
        )}
        {drift.changed && (
          <div className="s07-validation" data-current-drift>
            <p className="s07-warn-strong">当前数据与检查点保存时的记录存在差异，或当前状态有新变化：</p>
            <ul className="s07-note-list">
              {drift.details.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
            <p className="s07-note">
              这是当前差异与说明；恢复检查不会消除这些差异，领域命令结果仍是权威结论。
            </p>
          </div>
        )}
        {validation && (
          <div
            className="s07-validation"
            data-historical-validation={validation.requiresReview ? "requires-review" : "clean"}
            data-validation-at={validation.at}
          >
            <p className={validation.requiresReview ? "s07-warn-strong" : "s07-note-strong"}>
              历史核对报告（{formatStamp(validation.at)}检查时的记录，不是当前结论）：
              {validation.requiresReview ? "检查当时发现偏差，恢复需要复核。" : "检查当时未发现偏差。"}
            </p>
            <p className="s07-note">
              当前状态以本页顶部当前状态与上方当前差异提示为准；这份报告不会随当前数据自动更新。
            </p>
            <details className="s07-history-raw">
              <summary>历史报告原始记录（域命令原始输出，仅供追溯，不代表当前状态）</summary>
              <ul className="s07-note-list">
                {validation.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </details>
            {validation.staleSourceIds.length > 0 && (
              <p className="s07-note">
                变化的来源/材料：{validation.staleSourceIds.map((id) => boundRefLabel(domain, id)).join("、")}
              </p>
            )}
            <p className="s07-note" data-validation-scope>
              这次检查覆盖来源版本、已获授权材料的版本与关联（授权读取、关联同一草稿且版本一致、全局材料读取未关闭才算当前可用；材料小节关联被移除也会记录）、草稿版本与已确认小节，以及草稿当前是否已撤回或已发送（撤回或已发送时检查仅作报告，不会重新激活草稿）；旧格式检查点缺少修订号、小节问题或材料小节关联元数据时，按保守复核处理。结果只代表检查那一刻，不是永久有效的当前状态，也不是完整正文快照。
            </p>
          </div>
        )}

        <div className="s07-divider" role="presentation" />

        <h3 className="s07-kicker">
          <span className="s07-num">04</span>检查点里保存了什么
        </h3>
        <p className="s07-note" data-snapshot-scope>
          检查点保存的是版本化记录（来源版本、确认小节版本、材料清单、草稿版本；新保存的检查点还包括草稿修订号、小节问题清单和材料小节关联），不是当时的完整正文快照。旧格式检查点可能缺少修订号、小节问题或小节关联：缺少表示历史无法证明完整，不会用当前数据补写。
        </p>
        <CheckpointRules checkpoint={checkpoint} current={domain.ruleset} />
        <CheckpointNotes store={store} checkpoint={checkpoint} />
        <div className="s07-materials">
          <span className="s07-materials-label">保存时小节问题记录</span>
          {checkpoint.sectionIssues === undefined ? (
            <p className="s07-note" data-checkpoint-section-issues="unknown">
              旧检查点未记录保存时的小节问题清单，无法证明完整；不会用当前草稿的问题补写。
            </p>
          ) : checkpoint.sectionIssues.length === 0 ? (
            <p className="s07-note" data-checkpoint-section-issues="empty">
              保存时没有记录任何小节问题。
            </p>
          ) : savedSectionIssuesExtra.length === 0 ? (
            <p className="s07-note" data-checkpoint-section-issues="merged">
              保存时记录了 {checkpoint.sectionIssues.length} 条小节问题，已全部合并显示在上面的未决定问题列表（带小节 ID 前缀）。
            </p>
          ) : (
            <div className="s07-material-chips" data-checkpoint-section-issues="recorded">
              {savedSectionIssuesExtra.map((entry, i) => (
                <span
                  key={entry.sectionId + ":" + i}
                  className="s07-chip-plain"
                  data-checkpoint-section-issue={entry.sectionId}
                >
                  {entry.sectionId}：{entry.issue}
                </span>
              ))}
            </div>
          )}
        </div>
        <p className="s07-note">
          这里只显示保存时刻记录的小节问题（未合并进未决定问题列表的额外条目），不会重复渲染，也不会用当前草稿的问题补写。
        </p>
        <div className="s07-materials">
          <span className="s07-materials-label">相关材料</span>
          {checkpoint.materials.length === 0 ? (
            <p className="s07-note" data-materials-empty>保存时没有已登记材料。</p>
          ) : (
            <div className="s07-material-chips" data-checkpoint-materials>
              {checkpoint.materials.map((m) => {
                const material = domain.materials[m.id];
                const recordedUsable =
                  material !== undefined &&
                  material.readPermission === "granted" &&
                  material.draftId === checkpoint.draftId;
                const scope = !material
                  ? "missing"
                  : recordedUsable
                    ? domain.ruleset.grants.readMaterial
                      ? "granted"
                      : "granted-global-off"
                    : "unscoped";
                const savedAssociation =
                  m.sectionIds === undefined
                    ? "保存时未记录小节关联（历史关联无法证明，不按当前材料补写）"
                    : m.sectionIds.length === 0
                      ? "保存时记录的小节关联为空"
                      : "保存时关联小节：" + m.sectionIds.join("、");
                return (
                  <span
                    key={m.id}
                    className="s07-chip-plain"
                    data-checkpoint-material={m.id}
                    data-checkpoint-material-scope={scope}
                  >
                    {m.name} · v{m.version}
                    {" · " + savedAssociation}
                    {scope === "granted"
                      ? " · 已授权读取且关联这份草稿"
                      : scope === "granted-global-off"
                        ? " · 已记录授权读取且关联这份草稿；当前全局材料读取已关闭，不能当作当前可用材料"
                      : scope === "unscoped"
                        ? " · 快照条目：当前看不到对应的授权/草稿关联，不能当作已授权材料"
                        : " · 这条材料记录在当前数据中不存在"}
                  </span>
                );
              })}
            </div>
          )}
        </div>
        <p className="s07-note">
          保存时记录的是已获授权读取、关联这份草稿并且实际应用过的材料（新保存的检查点同时记录每条材料的小节关联 ID）；旧格式检查点可能缺少授权/草稿/小节关联信息，会按上面逐条标注，不会用当前材料补写。小节关联只记录 ID，没有历史标题快照；当前草稿标题不能当作历史记录使用。材料清单是版本化记录，不是完整正文快照。
        </p>
        <div className="s07-materials">
          <span className="s07-materials-label">来源版本记录</span>
          {Object.keys(checkpoint.sourceVersionSet).length === 0 ? (
            <p className="s07-note" data-sources-empty>保存时没有关联来源。</p>
          ) : (
            <div className="s07-material-chips" data-checkpoint-sources>
              {Object.entries(checkpoint.sourceVersionSet).map(([sid, v]) => {
                return (
                  <span key={sid} className="s07-chip-plain" data-checkpoint-source={sid}>
                    {boundRefLabel(domain, sid)} · v{v}
                  </span>
                );
              })}
            </div>
          )}
        </div>

        <h3 className="s07-kicker">
          <span className="s07-num">05</span>当前草稿状态（当前版本，不是历史快照）
        </h3>
        {draft ? (
          <ul className="s07-current-sections" data-current-draft-sections>
            {draft.sections.map((s) => (
              <li key={s.id} data-current-section={s.id}>
                <span>{s.title} · 当前正文 v{s.contentVersion}</span>
                {s.openIssues.length > 0 && (
                  <ul className="s07-note-list" data-current-section-issues>
                    {s.openIssues.map((issue, i) => (
                      <li key={i}>当前待处理问题：{issue}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="s07-note" data-current-draft-missing>
            当前数据中找不到这份草稿，无法显示当前小节状态。
          </p>
        )}

        <div className="s07-divider" role="presentation" />
        <div className="s07-materials">
          <span className="s07-materials-label">完整记录</span>
          {back.kind === "available" ? (
            <Link className="s07-link" data-back-to-workspace to={back.href}>
              查看完整记录（当前草稿）
            </Link>
          ) : (
            <span className="s07-note" data-back-unavailable>
              完整记录当前不可用：{back.reason}；不会跳到其他草稿。
            </span>
          )}
        </div>
        {back.kind === "available" && (
          <div className="s07-actions">
            <Link className="s07-btn-ghost" data-return-workspace to={back.href}>
              回到工作台继续这份草稿
            </Link>
          </div>
        )}
      </section>
    </div>
  );
}
