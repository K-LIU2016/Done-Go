import { useState } from "react";
import { useDomainState } from "../../data/react.ts";
import type { DomainStore } from "../../domain/store.ts";
import {
	currentRetainedObservations,
	isWeekConfirmationStale,
	latestWeekConfirmationForPeriod,
} from "../../domain/contextReviewModel.ts";
import type { WeeklyFeedbackValue } from "../../domain/contextReviewModel.ts";
import { ContextReviewSurface } from "../s11-context/context-review-runtime.tsx";
import { useContextReviewActions } from "../s11-context/use-context-review-actions.ts";
import "./s12-review.css";

const FEELINGS: Array<{ label: string; value: WeeklyFeedbackValue }> = [
	{ label: "更有掌控", value: "more-control" },
	{ label: "差不多", value: "same" },
	{ label: "反而更难", value: "harder" },
	{ label: "跳过", value: "skipped" },
];
function monday(day: string) {
	const date = new Date(day + "T00:00:00Z");
	date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
	return date.toISOString().slice(0, 10);
}
export function S12Review() {
	return (
		<ContextReviewSurface>
			{(store) => <ReviewContent store={store} />}
		</ContextReviewSurface>
	);
}
function ReviewContent({ store }: { store: DomainStore }) {
	const state = useDomainState(store);
	const actions = useContextReviewActions(store);
	const [weekStart, setWeekStart] = useState(() =>
		monday(state.attention.budget.budgetDay),
	);
	const [editingFeeling, setEditingFeeling] = useState(false);
	const [minutes, setMinutes] = useState<Record<string, string>>({});
	const timezone = state.ruleset.timezone;
	const weekEnd = new Date(Date.parse(weekStart + "T00:00:00Z") + 7 * 86400000)
		.toISOString()
		.slice(0, 10);
	const observations = currentRetainedObservations(state.contextReview).filter(
		(item) =>
			item.date >= weekStart &&
			item.date < weekEnd &&
			item.timezone === timezone,
	);
	const blocks = Object.values(state.protectedBlocks).filter(
		(block) =>
			block.status === "active" &&
			block.range.timezone === timezone &&
			block.range.start.slice(0, 10) >= weekStart &&
			block.range.start.slice(0, 10) < weekEnd,
	);
	const superseded = new Set(
		state.ledger.map((item) => item.supersedesId).filter(Boolean),
	);
	const ledger = state.ledger.filter(
		(item) =>
			!superseded.has(item.id) &&
			item.effectiveDate >= weekStart &&
			item.effectiveDate < weekEnd,
	);
	const feeling =
		state.contextReview.weeklyFeedback[weekStart + "@" + timezone];
	const confirmation = latestWeekConfirmationForPeriod(
		state.contextReview,
		weekStart,
		timezone,
	);
	const confirmed =
		confirmation &&
		!isWeekConfirmationStale(confirmation, {
			ledger: state.ledger,
			observations: state.contextReview.retainedObservations,
		});
	const retained = observations.reduce(
		(sum, item) => sum + item.observedMinutes,
		0,
	);
	const intended = blocks.reduce(
		(sum, item) =>
			sum + (Date.parse(item.range.end) - Date.parse(item.range.start)) / 60000,
		0,
	);
	const bars = Array.from({ length: 7 }, (_, index) => {
		const day = new Date(
			Date.parse(weekStart + "T00:00:00Z") + index * 86400000,
		)
			.toISOString()
			.slice(0, 10);
		const records = observations.filter((item) => item.date === day);
		return {
			day,
			minutes: records.reduce((sum, item) => sum + item.observedMinutes, 0),
			known: records.length > 0,
		};
	});
	const max = Math.max(60, ...bars.map((bar) => bar.minutes));
	return (
		<section className="s12" data-page="s12" aria-label="时间回顾">
			<header className="s12-head">
				<h1 className="s12-title">记下保留的生活，不夸大节省。</h1>
				<p className="s12-sub">
					本周回顾 · {weekStart} 起 · {timezone} ·{" "}
					{state.dataMode === "fixture" ? "合成演示空间" : "本地记录"}
				</p>
				<label>
					回顾日期{" "}
					<input
						type="date"
						value={weekStart}
						onChange={(event) => {
							if (event.target.value) {
								setWeekStart(monday(event.target.value));
								setEditingFeeling(false);
							}
						}}
					/>
				</label>
			</header>
			<div className="s12-grid">
				<article className="s12-card s12-card-main">
					<p className="s12-badge">由你回顾确认</p>
					<p className="s12-kept">
						{observations.length
							? observations.length + " 段时间已有观察记录。"
							: "实际保留的时间，等待你回顾。"}
					</p>
					<p className="s12-sum">
						希望保留 {intended} 分钟 ·{" "}
						{observations.length
							? "已观察保留 " + retained + " 分钟"
							: "实际保留未知"}
					</p>
					<div className="s12-chart">
						{bars.map((bar, index) => (
							<div key={bar.day} className="s12-bar-slot">
								<span className="s12-bar-day">周{"一二三四五六日"[index]}</span>
								<div
									role="img"
									aria-label={
										bar.day +
										(bar.known ? " 保留 " + bar.minutes + " 分钟" : " 尚未观察")
									}
									className={
										bar.known ? "s12-bar-track" : "s12-bar-track is-unknown"
									}
								>
									<span
										className="s12-bar"
										style={{ width: (bar.minutes / max) * 100 + "%" }}
									/>
								</div>
								<span className="s12-bar-value">
									{bar.known ? bar.minutes : "未知"}
								</span>
							</div>
						))}
					</div>
					<div
						className="s12-chart-scale"
						aria-label={"横轴范围：0 至 " + max + " 分钟"}
					>
						<span>0</span>
						<span>{max} 分钟</span>
					</div>
					<p className="s12-note">
						未知不是零；希望保留的时长也不等于实际得到保留。
					</p>
					{blocks.length === 0 && (
						<p className="s12-note">这一周没有可回顾的保护时段。</p>
					)}
					{blocks.map((block) => {
						const observation = observations.find(
							(item) => item.protectedBlockId === block.id,
						);
						const duration =
							(Date.parse(block.range.end) - Date.parse(block.range.start)) /
							60000;
						const amount = minutes[block.id] ?? "";
						return (
							<div key={block.id}>
								<p>
									{block.range.start.slice(0, 16).replace("T", " ")} · 计划{" "}
									{duration} 分钟
								</p>
								{observation && (
									<p className="s12-note">
										已观察 {observation.observedMinutes} 分钟 ·{" "}
										{observation.outcome === "not-retained"
											? "未能保住"
											: "得到部分或全部保留"}
									</p>
								)}
								<label>
									实际保留分钟{" "}
									<input
										type="number"
										min="0"
										max={duration}
										step="1"
										value={amount}
										disabled={actions.busy}
										onChange={(event) =>
											setMinutes((previous) => ({
												...previous,
												[block.id]: event.target.value,
											}))
										}
									/>
								</label>
								<button
									className="s12-feel-btn"
									disabled={
										actions.busy ||
										amount.trim() === "" ||
										!Number.isInteger(Number(amount)) ||
										Number(amount) < 0 ||
										Number(amount) > duration
									}
									onClick={() => {
										const common = {
											actor: "user" as const,
											blockId: block.id,
											blockRevision: block.revision,
											date: block.range.start.slice(0, 10),
											observedMinutes: Number(amount),
											outcome:
												Number(amount) === 0
													? ("not-retained" as const)
													: Number(amount) === duration
														? ("retained" as const)
														: ("partly" as const),
										};
										void actions.run(
											observation
												? {
														...common,
														type: "correctObservation",
														observationId: observation.id,
														expectedRevision: observation.revision,
													}
												: { ...common, type: "recordObservation" },
										);
									}}
								>
									{observation ? "更正观察" : "确认观察"}
								</button>
							</div>
						);
					})}
					<button
						className="s12-feel-btn"
						disabled={actions.busy || !!confirmed}
						onClick={() =>
							void actions.run({
								type: "confirmWeek",
								actor: "user",
								weekStart,
								timezone,
							})
						}
					>
						{confirmed ? "本周记录已确认" : "确认已回顾本周记录"}
					</button>
					{confirmation && !confirmed && (
						<p className="s12-note">记录有变化，需要重新确认。</p>
					)}
				</article>
				<div className="s12-side">
					<article className="s12-card">
						<h2 className="s12-card-title">01 三种时间，分别记账</h2>
						<ul className="s12-ledger">
							<li>
								<span
									className={
										"s12-ledger-value " +
										(observations.length ? "is-numeric" : "is-unknown")
									}
								>
									{observations.length ? retained + " 分钟" : "尚未观察"}
								</span>
								<div className="s12-ledger-description">
									<span className="s12-ledger-label">得到保留</span>
									<span className="s12-ledger-note">
										观察结果，不等于产品净节省。
									</span>
								</div>
							</li>
							<li>
								<span className="s12-ledger-value is-numeric">
									{
										observations.filter(
											(item) => item.outcome === "not-retained",
										).length
									}{" "}
									段已记录
								</span>
								<div className="s12-ledger-description">
									<span className="s12-ledger-label">未能保住</span>
									<span className="s12-ledger-note">
										未观察的时段不计为失败。
									</span>
								</div>
							</li>
							<li>
								<span
									className={
										"s12-ledger-value " +
										(ledger.some(
											(item) =>
												item.category === "supervisionCost" &&
												item.certainty === "measured",
										)
											? "is-numeric"
											: "is-unknown")
									}
								>
									{ledger.some(
										(item) =>
											item.category === "supervisionCost" &&
											item.certainty === "measured",
									)
										? ledger
												.filter(
													(item) =>
														item.category === "supervisionCost" &&
														item.certainty === "measured",
												)
												.reduce((sum, item) => sum + (item.minutes ?? 0), 0) +
											" 分钟"
										: "尚未测量"}
								</span>
								<div className="s12-ledger-description">
									<span className="s12-ledger-label">额外投入</span>
									<span className="s12-ledger-note">
										作为成本记录，而不是忽略。
									</span>
								</div>
							</li>
						</ul>
						<details>
							<summary>查看账本与观察明细</summary>
							{ledger.map((item) => (
								<p key={item.id}>
									{
										{
											protectedDuration: "计划保护时长",
											estimatedHumanReduction: "预估投入减少",
											futureDebt: "未来负担",
											supervisionCost: "监督投入",
											measuredNetSaving: "已测量净节省",
										}[item.category]
									}{" "}
									· {item.minutes ?? "未知"} 分钟 ·{" "}
									{
										{ estimated: "预估", measured: "已测量", unknown: "未知" }[
											item.certainty
										]
									}{" "}
									· {item.note} · 记录 {item.id}
								</p>
							))}
							{observations.map((item) => (
								<p key={item.id}>
									{item.date} · {item.observedMinutes} 分钟 · 保护时段{" "}
									{item.protectedBlockId} 版本 {item.blockRevision}
								</p>
							))}
						</details>
					</article>
					<article className="s12-card s12-card-feedback">
						<h2 className="s12-card-title">02 真正的净节省，尚未测量</h2>
						<p className="s12-note">
							需要比较没有静驻时的同类任务，并把监督、纠错与未来负担计入。当前不显示一个看似精确的“省时总数”。
						</p>
						<p className="s12-ask">这一周，你对自己的时间是否更有掌控?</p>
						<div className="s12-feelings">
							{FEELINGS.map((item) => (
								<button
									key={item.value}
									type="button"
									className={
										"s12-feel-btn" +
										(item.value === "skipped" ? " is-skip" : "")
									}
									aria-pressed={feeling?.value === item.value}
									disabled={actions.busy || (!!feeling && !editingFeeling)}
									onClick={() => {
										void actions.run({
											type: "upsertWeeklyFeedback",
											actor: "user",
											weekStart,
											timezone,
											value: item.value,
											expectedRevision: feeling?.revision ?? null,
										});
										setEditingFeeling(false);
									}}
								>
									{item.label}
								</button>
							))}
						</div>
						{feeling && (
							<>
								<p className="s12-thanks">
									{feeling.value === "skipped"
										? "已记录跳过，不会重复催问。"
										: "已记录：" +
											FEELINGS.find((item) => item.value === feeling.value)
												?.label}
								</p>
								<button
									className="s12-feel-btn"
									disabled={actions.busy}
									onClick={() => setEditingFeeling(true)}
								>
									修改本周反馈
								</button>
							</>
						)}
					</article>
				</div>
			</div>
			{actions.message && <p role="status">{actions.message}</p>}
			{actions.retryable && (
				<button disabled={actions.busy} onClick={() => void actions.retry()}>
					重试保存原操作
				</button>
			)}
		</section>
	);
}
