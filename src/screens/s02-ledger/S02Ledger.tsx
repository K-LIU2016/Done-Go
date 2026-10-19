import { useState, type CSSProperties } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowRight,
  Calendar,
  Clock,
  FileText,
  Inbox,
  Lock,
  X,
} from "lucide-react";
import "./s02-ledger.css";
import { useDomainState } from "../../data/react.ts";
import type { CommitmentView, SourceRowView } from "../s01-now/timeSurfaces.ts";
import {
  DAY_TRACK_GEOMETRY,
  formatCapacityWarning,
  formatCoverageText,
  formatIsoDateCn,
  formatIsoTime,
  formatMinuteOfDay,
  formatSourceSyncText,
  selectCapacityView,
  selectMonthSurface,
  selectSourceRows,
  selectTimelineSurface,
  selectWeekSurface,
  weekDatesContaining,
} from "../s01-now/timeSurfaces.ts";
import type { DomainStore, EntityId } from "../../domain/index.ts";
import { retryDomainRuntime, useDomainRuntime } from "../../runtime/index.ts";
import { resolveLedgerContext } from "./ledger-context.ts";

const COMMITMENT_STATUS_LABELS: Record<CommitmentView["status"], string> = {
  active: "已生效",
  deferred: "已推迟",
  done: "已完成",
  cancelled: "已取消",
};

function sourceIconFor(connectorId: string) {
  if (connectorId.includes("calendar")) {
    return <Calendar size={15} aria-hidden="true" />;
  }
  if (connectorId.includes("task")) {
    return <FileText size={15} aria-hidden="true" />;
  }
  return <Inbox size={15} aria-hidden="true" />;
}

export function S02Ledger() {
  const [runtimeEpoch, setRuntimeEpoch] = useState(0);
  return (
    <section className="s02" data-page="s02" aria-label="时间账本 · 责任与边界">
      <header className="s02-head">
        <h1 className="s02-title">时间有去向，也有边界。</h1>
        <p className="s02-sub">
          固定约定、可变计划与静驻分开记录；空白不自动意味着可占用。
        </p>
      </header>
      <S02RuntimeGate
        key={runtimeEpoch}
        onRetrySettled={() => setRuntimeEpoch((epoch) => epoch + 1)}
      />
    </section>
  );
}

function S02RuntimeGate({ onRetrySettled }: { onRetrySettled: () => void }) {
  const runtime = useDomainRuntime("fixture");
  const [retrying, setRetrying] = useState(false);
  if (runtime.status === "loading") {
    return (
      <p className="s02-runtime" role="status" data-runtime-state="loading">
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
      <div className="s02-runtime is-error" data-runtime-state="unavailable">
        <p role="status">
          本地领域数据当前不可读：{runtime.reason}。原始数据已保留，未被清除。
        </p>
        <button
          type="button"
          className="s02-retry"
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
      <S02Ready store={runtime.runtime.store} />
    </div>
  );
}

function S02Ready({ store }: { store: DomainStore }) {
  const navigate = useNavigate();
  const location = useLocation();
  const state = useDomainState(store);
  const [view, setView] = useState<"today" | "week" | "month">("today");
  const [selectedCommitmentId, setSelectedCommitmentId] =
    useState<EntityId | null>(null);
  const context = resolveLedgerContext(state, new URLSearchParams(location.search));
  if (!context.ok) return (
    <div className="s02-runtime is-error" role="alert" data-ledger-context="invalid">
      <p>无法定位这条时间记录：{context.reason}</p>
      <p>没有自动切换日期、意图或保护时段。</p>
      <Link className="s02-empty-action" to="/ledger">查看当前账本</Link>
    </div>
  );
  const date = context.date;
  const capacity = selectCapacityView(state, date);
  const surface = selectTimelineSurface(state, date, {
    ...DAY_TRACK_GEOMETRY,
    trackHeightPx: 630,
  });
  const week = selectWeekSurface(state, weekDatesContaining(date));
  const month = view === "month" ? selectMonthSurface(state, date) : null;
  const sources = selectSourceRows(state);
  const timezone = state.ruleset.timezone;
  const selectedDetail =
    [...surface.blocks, ...surface.unscheduled].find(
      (item) => item.id === selectedCommitmentId,
    ) ?? null;
  const visibleLanes = surface.protectedLanes.filter((lane) => lane.visible);
  const boardIsEmpty = surface.blocks.length === 0 && visibleLanes.length === 0;
  const selectCommitment = (id: EntityId) => {
    setSelectedCommitmentId((current) => (current === id ? null : id));
  };
  const firstOverlap = surface.overlapSegments[0];
  const estimateFits =
    capacity.kind === "surplus" || capacity.kind === "balanced";
  const hourCount = surface.hourLabels.length;
  const hourPercent = (index: number) =>
    (index / (hourCount - 1)) * 100 + "%";
  return (
    <div className="s02-grid" data-ledger-date={date} data-ledger-intent={context.intent?.id} data-ledger-block={context.block?.blockId}>
      <article className="s02-board" aria-label={formatIsoDateCn(date) + " 时间安排"}>
        {context.block && context.intent && (
          <section className="s02-focused-context" aria-label="从此刻定位的保护时段" data-ledger-context="matched">
            <p className="s02-stillness-title"><Lock size={14} aria-hidden="true" />已定位：同一段受保护的静驻</p>
            <p className="s02-stillness-time">{formatIsoDateCn(date)} · {formatIsoTime(context.block.range.start)}—{formatIsoTime(context.block.range.end)}</p>
            <p className="s02-stillness-note">时区 {context.block.range.timezone} · {context.block.purpose ? "用途：" + context.block.purpose : "没有设置用途，也成立"}</p>
            <p className="s02-context-intent">关联意图：{context.intent.verbatim || "已保存的结构化意图"}{context.intent.status === "paused" ? "（已暂停使用，既有边界仍保留）" : ""}</p>
            {!visibleLanes.some(lane => lane.blockId === context.block?.blockId) && <p className="s02-stillness-note">此时段在下方默认时间轴范围外；完整记录已在这里定位，不代表时段不存在。</p>}
            <Link className="s02-empty-action" to={"/m/now?intentId=" + encodeURIComponent(context.intent.id)}>返回此刻</Link>
          </section>
        )}
        <div className="s02-board-head">
          <h2 className="s02-date">{formatIsoDateCn(date)}</h2>
          <div className="s02-toggle" role="group" aria-label="时间范围">
            <button
              type="button"
              aria-pressed={view === "today"}
              className={view === "today" ? "is-on" : ""}
              onClick={() => setView("today")}
            >
              {context.block ? "当日" : "今日"}
            </button>
            <button
              type="button"
              aria-pressed={view === "week"}
              className={view === "week" ? "is-on" : ""}
              onClick={() => setView("week")}
            >
              本周
            </button>
            <button
              type="button"
              aria-pressed={view === "month"}
              className={view === "month" ? "is-on" : ""}
              onClick={() => setView("month")}
            >
              本月
            </button>
          </div>
          <span className="s02-tz">
            <Clock size={14} aria-hidden="true" />
            当前时区 · {timezone}
          </span>
        </div>

        {view === "today" ? (
          boardIsEmpty ? (
            <div className="s02-empty">
              <p>这一天还没有已保存的安排或保护时段。</p>
              <p className="s02-empty-note">
                空白不代表空闲；记录后才会出现在账本里。
              </p>
              <button
                type="button"
                className="s02-empty-action"
                data-capture-link
                onClick={() => navigate("/capture")}
              >
                去记录一条安排
                <ArrowRight size={15} aria-hidden="true" />
              </button>
            </div>
          ) : (
            <div className="s02-table">
              <div
                className="s02-timetable"
                role="group"
                aria-label="今日时间安排表；屏幕较窄时可左右滚动查看完整时间轴"
                tabIndex={0}
              >
                <div className="s02-cols" aria-hidden="true">
                  <span>时间</span>
                  <span>安排与责任</span>
                  <span>你选择的边界</span>
                </div>
                <div className="s02-track-wrap">
                  <div className="s02-hours">
                    {surface.hourLabels.map((label, index) => (
                      <span key={label} style={{ top: hourPercent(index) }}>
                        {label}
                      </span>
                    ))}
                  </div>
                  <div className="s02-track">
                    <div className="s02-lines" aria-hidden="true">
                      {surface.hourLabels.map((label, index) => (
                        <span
                          key={label}
                          className="s02-gridline"
                          style={{ top: hourPercent(index) }}
                        />
                      ))}
                      {visibleLanes.map((lane) => (
                        <span
                          key={lane.id}
                          className="s02-boundary"
                          style={{ top: lane.topPx + "px" }}
                        />
                      ))}
                    </div>
                    <div className="s02-blocks">
                      {surface.overlapSegments.map((segment) => (
                        <span
                          key={segment.commitmentId + "-" + segment.blockId}
                          className="s02-overflow-seg"
                          aria-hidden="true"
                          style={{
                            top: segment.topPx + "px",
                            height: segment.heightPx + "px",
                          }}
                        />
                      ))}
                      {surface.blocks.map((block) => {
                        const selected = selectedCommitmentId === block.id;
                        const blockKind =
                          block.mobility === "fixed"
                            ? "is-meeting"
                            : block.deadline
                              ? "is-report"
                              : "is-admin";
                        return (
                          <button
                            type="button"
                            key={block.id}
                            className={
                              "s02-block " +
                              blockKind +
                              (selected ? " is-selected" : "")
                            }
                            style={{
                              top: block.topPx + "px",
                              height: block.heightPx + "px",
                            }}
                            data-commitment-id={block.id}
                            aria-expanded={selected}
                            aria-controls={
                              selected ? "s02-commitment-detail" : undefined
                            }
                            onClick={() => selectCommitment(block.id)}
                          >
                            <span className="s02-block-title">
                              {block.scope ?? "未命名责任"}
                              {block.mobility === "fixed" ? (
                                <Lock size={14} aria-hidden="true" />
                              ) : null}
                            </span>
                            <span
                              className="s02-block-meta"
                              data-effort-unknown={
                                block.effortEstimateMinutes === null
                                  ? "true"
                                  : undefined
                              }
                            >
                              {block.effortEstimateMinutes === null
                                ? "预计投入未知"
                                : "预计投入 " +
                                  block.effortEstimateMinutes +
                                  " 分钟 · " +
                                  (block.mobility === "fixed"
                                    ? "固定约定"
                                    : "暂定计划")}
                            </span>
                            {block.deadline ? (
                              <span className="s02-chip">
                                {formatIsoTime(block.deadline)} 前提交
                              </span>
                            ) : null}
                          </button>
                        );
                      })}
                      {firstOverlap ? (
                        <p
                          className="s02-overwarn"
                          style={{
                            top:
                              firstOverlap.topPx + firstOverlap.heightPx + 6 + "px",
                          }}
                        >
                          <AlertTriangle size={14} aria-hidden="true" />
                          超出边界 {surface.totalOverlapMinutes} 分钟
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <div className="s02-edge">
                    <div className="s02-edge-lines" aria-hidden="true">
                      {surface.hourLabels.map((label, index) => (
                        <span key={label} className="s02-gridline" style={{ top: hourPercent(index) }} />
                      ))}
                    </div>
                    {visibleLanes.every((lane) => lane.topPx >= 100) ? (
                      <p className="s02-open-time-note">未提前安排的时间 ≠ 必须工作</p>
                    ) : null}
                    {visibleLanes.map((lane) => (
                      <div
                        key={lane.id}
                        className={"s02-stillness" + (lane.blockId === context.block?.blockId ? " is-linked" : "")}
                        data-protected-block-id={lane.blockId}
                        aria-current={lane.blockId === context.block?.blockId ? "true" : undefined}
                        style={{ top: lane.topPx + "px", "--protected-height": lane.heightPx + "px" } as CSSProperties}
                        tabIndex={0}
                        role="group"
                        aria-label={"受保护时段 " + formatMinuteOfDay(lane.startMinute) + " 至 " + formatMinuteOfDay(lane.endMinute)}
                      >
                        <p className="s02-stillness-title">
                          <Lock size={14} aria-hidden="true" />
                          {lane.blockId === context.block?.blockId ? "已定位 · 受保护的静驻" : "受保护的静驻"}
                        </p>
                        <p className="s02-stillness-time">
                          {formatMinuteOfDay(lane.startMinute)}
                          {"—"}
                          {formatMinuteOfDay(lane.endMinute)}
                        </p>
                        <p className="s02-stillness-note">
                          {lane.purpose
                            ? "用途：" + lane.purpose + "。不接受自动填充。"
                            : "没有设置用途，也不接受自动填充。"}
                        </p>
                      </div>
                    ))}
                    {visibleLanes.length === 0 ? (
                      <div className="s02-stillness s02-stillness-missing">
                        <p className="s02-stillness-title">还没有设置保护时段</p>
                        <button
                          type="button"
                          className="s02-stillness-action"
                          data-capture-link
                          onClick={() => navigate("/capture")}
                        >
                          去设置保护时段
                          <ArrowRight size={15} aria-hidden="true" />
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
              {surface.unscheduled.length > 0 ? (
                <div className="s02-unscheduled">
                  <p className="s02-unscheduled-label">
                    另有 {surface.unscheduled.length} 条责任已保存但未安排具体时间：
                  </p>
                  <div className="s02-unscheduled-list">
                    {surface.unscheduled.map((item) => {
                      const selected = selectedCommitmentId === item.id;
                      return (
                        <button
                          type="button"
                          key={item.id}
                          className={
                            "s02-unscheduled-item" +
                            (selected ? " is-selected" : "")
                          }
                          data-commitment-id={item.id}
                          aria-expanded={selected}
                          aria-controls={
                            selected ? "s02-commitment-detail" : undefined
                          }
                          onClick={() => selectCommitment(item.id)}
                        >
                          {item.scope ?? "未命名责任"}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
              <p className="s02-board-note">
                需要改变完成路径，或由你重新决定可变事项。
              </p>
              {selectedDetail ? (
                <S02CommitmentDetail
                  commitment={selectedDetail}
                  onClose={() => setSelectedCommitmentId(null)}
                />
              ) : null}
            </div>
          )
        ) : view === "week" ? (
          <div className="s02-week">
            <ol className="s02-week-list">
              {week.days.map((day) => (
                <li
                  key={day.date}
                  className={
                    "s02-week-day" + (day.hasStoredRecords ? "" : " is-unknown") + (context.block && day.date === date ? " is-linked" : "")
                  }
                  data-week-date={day.date}
                  data-has-records={day.hasStoredRecords ? "true" : "false"}
                >
                  <span className="s02-week-day-date" aria-current={context.block && day.date === date ? "date" : undefined}>
                    {day.weekdayLabel} {formatIsoDateCn(day.date)}
                    {context.block && day.date === date ? " · 已定位日期" : ""}
                  </span>
                  <span className="s02-week-day-detail">
                    {day.hasStoredRecords
                      ? day.commitmentCount +
                        " 项责任" +
                        (day.unknownEffortCount > 0
                          ? " · " +
                            day.unknownEffortCount +
                            " 项投入未知"
                          : day.knownEffortMinutes > 0
                            ? " · 估计投入 " +
                              day.knownEffortMinutes +
                              " 分钟"
                            : "") +
                        (day.protectedCount > 0
                          ? " · " + day.protectedCount + " 段静驻"
                          : "") +
                        (day.overlapMinutes > 0
                          ? " · 越界 " + day.overlapMinutes + " 分钟"
                          : "")
                      : "没有已保存记录 · 覆盖未知"}
                  </span>
                </li>
              ))}
            </ol>
            <p className="s02-week-note">
              本周只汇总已保存的本地记录；没有记录的日期覆盖未知，不代表空闲。
            </p>
            <p className="s02-week-src">
              数据来源：本机已保存的领域记录（{timezone}），不包含未接入来源。
            </p>
          </div>
        ) : month ? (
          <div className="s02-month" data-month-label={month.label}>
            <p className="s02-month-label">{month.label}</p>
            <div className="s02-month-grid" role="table" aria-label={month.label + "逐日汇总"}>
              <div className="s02-month-head" role="row">
                {["周一", "周二", "周三", "周四", "周五", "周六", "周日"].map((d) => (
                  <span key={d} role="columnheader">{d}</span>
                ))}
              </div>
              {month.weeks.map((weekDays, weekIndex) => (
                <div key={weekIndex} className="s02-month-row" role="row">
                  {weekDays.map((day) => {
                    const inMonth = day.date.slice(5, 7) === String(month.month).padStart(2, "0");
                    const isLinked = context.block !== null && day.date === date;
                    return (
                      <div
                        key={day.date}
                        role="cell"
                        className={
                          "s02-month-cell" +
                          (inMonth ? "" : " is-outside") +
                          (day.hasStoredRecords ? "" : " is-unknown") +
                          (isLinked ? " is-linked" : "")
                        }
                        data-month-date={day.date}
                        data-has-records={day.hasStoredRecords ? "true" : "false"}
                      >
                        <span className="s02-month-cell-date" aria-current={isLinked ? "date" : undefined}>
                          {Number(day.date.slice(8, 10))}
                        </span>
                        {day.hasStoredRecords ? (
                          <span className="s02-month-cell-detail">
                            {day.commitmentCount > 0 ? day.commitmentCount + " 项" : ""}
                            {day.protectedCount > 0 ? (day.commitmentCount > 0 ? " · " : "") + day.protectedCount + " 段静驻" : ""}
                            {day.overlapMinutes > 0 ? " · 越界 " + day.overlapMinutes + " 分" : ""}
                          </span>
                        ) : (
                          <span className="s02-month-cell-detail">无记录</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            <p className="s02-month-note">
              本月只汇总已保存的本地记录；没有记录的日期覆盖未知，不代表空闲。
            </p>
            <p className="s02-month-src">
              数据来源：本机已保存的领域记录（{timezone}），不包含未接入来源。
            </p>
          </div>
        ) : null}
      </article>

      <div className="s02-side">
        <aside className="s02-panel" aria-label={context.block ? "所选日期的容量" : "今天的容量"}>
          <p className="s02-panel-kicker">01 · {context.block ? "所选日期的容量" : "今天的容量"}</p>
          <dl className="s02-rows">
            <div className="s02-row">
              <dt>{context.block ? "当日可用容量" : "今日可用容量"}</dt>
              <dd>{capacity.capacityMinutes} 分钟</dd>
            </div>
            <div className="s02-row">
              <dt>当前预计投入</dt>
              <dd data-effort-unknown={capacity.unknownEffortCount > 0 ? "true" : undefined}>
                {capacity.unknownEffortCount > 0
                  ? "未知 · " + capacity.unknownEffortCount + " 项"
                  : capacity.committedKnownMinutes + " 分钟"}
              </dd>
            </div>
            {capacity.kind === "deficit" ? (
              <div className="s02-row is-gap">
                <dt>容量缺口</dt>
                <dd>{capacity.gapMinutes} 分钟</dd>
              </div>
            ) : capacity.kind === "surplus" ? (
              <div className="s02-row">
                <dt>估计余量</dt>
                <dd>
                  {capacity.gapMinutes === null
                    ? "未知"
                    : -capacity.gapMinutes + " 分钟"}
                </dd>
              </div>
            ) : capacity.kind === "balanced" ? (
              <div className="s02-row">
                <dt>与容量相比</dt>
                <dd>持平</dd>
              </div>
            ) : (
              <div className="s02-row is-gap">
                <dt>与容量相比</dt>
                <dd>未知</dd>
              </div>
            )}
          </dl>
          <p className="s02-capacity-note">{formatCapacityWarning(capacity)}</p>
          {estimateFits && surface.totalOverlapMinutes > 0 ? (
            <p className="s02-mismatch" data-mismatch="true">
              <AlertTriangle size={14} aria-hidden="true" />
              预计投入虽在容量内，但仍有计划时段与静驻重叠{" "}
              {surface.totalOverlapMinutes} 分钟。
            </p>
          ) : null}
        </aside>

        <aside className="s02-panel" aria-label="每件事都保留来源">
          <p className="s02-panel-kicker">02 · 每件事都保留来源</p>
          <dl className="s02-rows">
            {sources.map((row) => (
              <S02SourceRow key={row.id} row={row} />
            ))}
            {sources.length === 0 ? (
              <div className="s02-row">
                <dt>来源</dt>
                <dd>未见已记录来源</dd>
              </div>
            ) : null}
          </dl>
          <p className="s02-src-note">
            未接入来源的安排不在账本内；缺失区间按未知处理，不算空闲。
          </p>
        </aside>

        <aside className="s02-panel is-action" aria-label="移动，不等于节省">
          <h2 className="s02-panel-title">移动，不等于节省。</h2>
          <p className="s02-panel-body">
            如果把工作移到明天，今天会更宽裕，但未来责任仍在。页面的改动只是估计值。
          </p>
          <button
            type="button"
            className="s02-primary"
            onClick={() => navigate("/plan")}
          >
            查看可行方案
            <ArrowRight size={18} aria-hidden="true" />
          </button>
        </aside>
      </div>
    </div>
  );
}

function S02SourceRow({ row }: { row: SourceRowView }) {
  return (
    <div className="s02-row" data-source-status={row.status}>
      <dt>
        {sourceIconFor(row.connectorId)}
        {row.connectorId}
      </dt>
      <dd className={row.status === "connected" ? "is-ok" : "is-miss"}>
        {formatSourceSyncText(row)} · {formatCoverageText(row)}
      </dd>
    </div>
  );
}

function S02CommitmentDetail({
  commitment,
  onClose,
}: {
  commitment: CommitmentView;
  onClose: () => void;
}) {
  const label = commitment.scope ?? "未命名责任";
  const schedule = commitment.schedule;
  const scheduleText = schedule
    ? formatIsoDateCn(schedule.date) +
      " " +
      (schedule.startMinute === null
        ? "—:—"
        : formatMinuteOfDay(schedule.startMinute)) +
      "–" +
      (schedule.endMinute === null
        ? "—:—"
        : formatMinuteOfDay(schedule.endMinute)) +
      "（" +
      schedule.timezone +
      "）"
    : "未安排具体时间";
  const sourceParts = [
    commitment.provenanceOrigin,
    commitment.provenanceNote,
    commitment.requestSourceRef
      ? "sourceRef " + commitment.requestSourceRef
      : null,
  ].filter((part): part is string => part !== null);
  return (
    <div
      className="s02-detail"
      id="s02-commitment-detail"
      role="region"
      aria-label={"责任详情 · " + label}
      data-commitment-id={commitment.id}
    >
      <div className="s02-detail-head">
        <h3 className="s02-detail-title">{label}</h3>
        <button
          type="button"
          className="s02-detail-close"
          onClick={onClose}
          aria-label="关闭责任详情"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <dl className="s02-detail-rows">
        <div className="s02-detail-row">
          <dt>状态</dt>
          <dd>{COMMITMENT_STATUS_LABELS[commitment.status]}</dd>
        </div>
        <div className="s02-detail-row">
          <dt>机动性</dt>
          <dd>
            {commitment.mobility === "fixed"
              ? "固定约定 · 不自动移动"
              : "可变 · 由你重新决定"}
          </dd>
        </div>
        <div className="s02-detail-row">
          <dt>时间安排</dt>
          <dd>{scheduleText}</dd>
        </div>
        <div className="s02-detail-row">
          <dt>预计投入</dt>
          <dd
            data-effort-unknown={
              commitment.effortEstimateMinutes === null ? "true" : undefined
            }
          >
            {commitment.effortEstimateMinutes === null
              ? "未知 · 未记录估计投入"
              : commitment.effortEstimateMinutes + " 分钟（估计值，非实际节省）"}
          </dd>
        </div>
        <div className="s02-detail-row">
          <dt>截止</dt>
          <dd>
            {commitment.deadline
              ? formatIsoTime(commitment.deadline) + " 前提交"
              : "无"}
          </dd>
        </div>
        <div className="s02-detail-row">
          <dt>来源</dt>
          <dd>{sourceParts.length > 0 ? sourceParts.join(" · ") : "未记录"}</dd>
        </div>
        <div className="s02-detail-row">
          <dt>批准记录</dt>
          <dd>{commitment.acceptedBy ?? "无"}</dd>
        </div>
      </dl>
      <p className="s02-detail-note">本页面不会自动移动或修改此责任。</p>
    </div>
  );
}
