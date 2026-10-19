import { useState } from "react";
import { Link } from "react-router-dom";
import { Download, FolderLock, ShieldQuestion } from "lucide-react";
import { useDomainState } from "../../data/react.ts";
import type { DomainStore } from "../../domain/store.ts";
import { ContextReviewSurface } from "./context-review-runtime.tsx";
import { useContextReviewActions } from "./use-context-review-actions.ts";
import { IntentCard } from "./IntentCard.tsx";
import "./s11-context.css";

export function S11Context() {
	return (
		<ContextReviewSurface>
			{(store) => <ContextContent store={store} />}
		</ContextReviewSurface>
	);
}

function ContextContent({ store }: { store: DomainStore }) {
	const state = useDomainState(store);
	const actions = useContextReviewActions(store);
	const [tab, setTab] = useState("intent");
	const [exported, setExported] = useState(false);
	const [exportKinds, setExportKinds] = useState({
		intents: true,
		inferences: true,
		review: true,
	});
	const inferences = Object.values(state.contextReview.inferences).filter(
		(item) => item.status !== "deleted",
	);
	const exportRecords = () => {
		const records = {
			format: "TangoDoneGo-context-export",
			version: 1,
			exportedAt: new Date().toISOString(),
			dataMode: state.dataMode,
			intents: exportKinds.intents
				? Object.values(state.intents).map(
						({
							id,
							revision,
							verbatim,
							parsedFields,
							constraints,
							status,
							provenance,
						}) => ({
							id,
							revision,
							verbatim,
							parsedFields,
							constraints,
							status,
							provenance,
						}),
					)
				: [],
			inferences: exportKinds.inferences
				? Object.values(state.contextReview.inferences).map(
						({
							id,
							revision,
							statement,
							evidenceSummary,
							status,
							provenance,
							reviewDueAt,
							deletedAt,
						}) => ({
							id,
							revision,
							statement,
							evidenceSummary,
							status,
							provenance,
							reviewDueAt,
							deletedAt,
						}),
					)
				: [],
			weeklyFeedback: exportKinds.review
				? Object.values(state.contextReview.weeklyFeedback)
				: [],
			retainedObservations: exportKinds.review
				? Object.values(state.contextReview.retainedObservations)
				: [],
		};
		const url = URL.createObjectURL(
			new Blob([JSON.stringify(records, null, 2)], {
				type: "application/json",
			}),
		);
		const link = document.createElement("a");
		link.href = url;
		link.download = "TangoDoneGo-my-records.json";
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
		setExported(true);
	};
	return (
		<section className="s11" data-page="s11" aria-label="私人上下文">
			<header className="s11-head">
				<h1 className="s11-title">了解你，不等于占有你。</h1>
				<p className="s11-sub">
					事实、意图与系统推测分开保存。你可以修正，也可以带走。
				</p>
			</header>
			<div className="s11-grid">
			<nav className="s11-tablist" aria-label="私人上下文分区">
				{[
					{ id: "intent", label: "我的意图" },
					{ id: "sources", label: "事实与来源" },
					{ id: "inference", label: "系统推测" },
				].map((item) => (
					<button
						key={item.id}
						type="button"
						aria-pressed={tab === item.id}
						className={tab === item.id ? "s11-tab is-active" : "s11-tab"}
						onClick={() => {
							setTab(item.id);
							document.getElementById("context-" + item.id)?.focus();
						}}
					>
						{item.label}
					</button>
				))}
			</nav>
				<article
					className="s11-panel"
					id="context-intent"
					tabIndex={-1}
					aria-label="我的意图"
				>
					<p className="s11-panel-kicker">最近想留给自己的时间</p>
					<p className="s11-badge">由你明确表达 · 本地意图记录</p>
					{Object.values(state.intents).map((intent) => <IntentCard key={intent.id} intent={intent} store={store} />)}
					{Object.keys(state.intents).length === 0 && (
						<p className="s11-note">还没有保存的意图。</p>
					)}
					<Link className="s11-btn" to="/capture">
						记录新的意图
					</Link>
				</article>
				<aside
					className="s11-sidebar"
					id="context-sources"
					tabIndex={-1}
					aria-label="事实与来源"
				>
				<article className="s11-panel s11-source-panel">
					<p className="s11-panel-kicker">已接入的来源与范围</p>
					<p className="s11-badge">
						{Object.keys(state.sources).length} 个来源记录
					</p>
					<ul className="s11-sources">
						{Object.values(state.sources).map((source) => (
							<li key={source.id}>
								<span>
									{source.connectorId === "fixture-calendar"
										? "演示日历"
										: source.connectorId}
									{source.dataMode === "fixture" ? " · 演示" : ""}
								</span>
								<span className="s11-src-state">
									{
										{
											connected: "已连接",
											stale: "需要更新",
											error: "同步失败",
											revoked: "已撤销",
											unconnected: "尚未连接",
										}[source.status]
									}{" "}
									·{" "}
									{source.coverage.known
										? source.coverage.intervals.length + " 段已知范围"
										: "覆盖未知"}
								</span>
							</li>
						))}
					</ul>
				</article>
				<article className="s11-panel" aria-label="权限与导出">
					<p className="s11-panel-kicker">随时收回未来的访问。</p>
					<p className="s11-note">
						撤销权限会停止后续读取；已经传出的副本不能被假定全部收回。
					</p>
					<fieldset className="s11-export-options">
						<legend>选择导出的记录</legend>
						{(
							[
								{ key: "intents", label: "意图" },
								{ key: "inferences", label: "推测" },
								{ key: "review", label: "回顾" },
							] as const
						).map((item) => (
							<label className="s11-export-option" key={item.key}>
								<input
									type="checkbox"
									checked={exportKinds[item.key]}
									onChange={(event) =>
										setExportKinds((previous) => ({
											...previous,
											[item.key]: event.target.checked,
										}))
									}
								/>
								{item.label}{" "}
							</label>
						))}
					</fieldset>
					<div className="s11-actions">
						<Link to="/boundaries" className="s11-btn">
							<FolderLock size={15} aria-hidden="true" />
							管理来源权限
						</Link>
						<button
							type="button"
							className="s11-btn s11-btn-ghost"
							disabled={!Object.values(exportKinds).some(Boolean)}
							onClick={exportRecords}
						>
							<Download size={15} aria-hidden="true" />
							导出我的记录
						</button>
					</div>
					<p className="s11-note">
						导出意图、推测与回顾记录；不包含密钥、连接凭据或材料正文。
					</p>
					{exported && <p role="status">已生成本地 JSON 下载。</p>}
				</article>
				</aside>
				<article
					className="s11-panel"
					id="context-inference"
					tabIndex={-1}
					aria-label="系统推测"
				>
					<p className="s11-panel-kicker">{inferences.length} 条系统推测</p>
					{inferences.length === 0 && (
						<p className="s11-note">
							暂无系统推测。没有证据时，不替你定义偏好。
						</p>
					)}
					{state.dataMode === "fixture" &&
						Object.keys(state.contextReview.inferences).length === 0 && (
							<button
								className="s11-btn s11-btn-ghost"
								disabled={actions.busy}
								onClick={() =>
									void actions.run({
										type: "createInference",
										actor: "user",
										statement: "你可能更愿意从修改草稿开始。",
										evidenceRefs: [
											"fixture-writing-choice-1",
											"fixture-writing-choice-2",
										],
										evidenceSummary:
											"两次合成写作选择，仅用于展示推测的确认、驳回与删除，不代表你的真实行为。",
										reviewDueAt: new Date(
											Date.now() + 7 * 86400000,
										).toISOString(),
										provenance: {
											origin: "fixture",
											note: "用户明确载入的设计演示推测",
										},
									})
								}
							>
								载入一条演示推测
							</button>
						)}
					{inferences.map((item) => (
						<div key={item.id} className="s11-card">
							<p className="s11-card-line">{item.statement}</p>
							<p className="s11-note">依据：{item.evidenceSummary}</p>
							<p className="s11-card-src">
								{item.dataMode === "fixture" ? "演示推测 · " : "系统推测 · "}
								{
									{
										pending: "待确认",
										acknowledged: "大致成立",
										rejected: "已驳回",
										deleted: "已删除",
									}[item.status]
								}{" "}
								·{" "}
								{item.reviewDueAt
									? "复查日期 " + item.reviewDueAt.slice(0, 10)
									: "尚无复查日期"}
							</p>
							{item.status === "rejected" ? (
								<p className="s11-reject-note">
									已标记为不准确。这条推测不会再被默默套用。
								</p>
							) : (
								<div className="s11-actions">
									<button
										className="s11-btn"
										disabled={actions.busy || item.status === "acknowledged"}
										onClick={() =>
											void actions.run({
												type: "acknowledgeInference",
												actor: "user",
												inferenceId: item.id,
												expectedRevision: item.revision,
											})
										}
									>
										这对我大致成立
									</button>
									<button
										className="s11-btn s11-btn-ghost"
										disabled={actions.busy}
										onClick={() =>
											void actions.run({
												type: "rejectInference",
												actor: "user",
												inferenceId: item.id,
												expectedRevision: item.revision,
											})
										}
									>
										并不准确
									</button>
								</div>
							)}
							<button
								type="button"
								className="s11-btn s11-btn-ghost"
								disabled={actions.busy}
								onClick={() => {
									if (
										window.confirm(
											"删除这条推测的文本与证据摘要？保留最小删除标记，避免再次套用。",
										)
									)
										void actions.run({
											type: "deleteInference",
											actor: "user",
											inferenceId: item.id,
											expectedRevision: item.revision,
										});
								}}
							>
								<ShieldQuestion size={15} aria-hidden="true" />
								删除这条推测
							</button>
						</div>
					))}
				</article>
			</div>
			{actions.message && <p role="status">{actions.message}</p>}
			{actions.retryable && (
				<button disabled={actions.busy} onClick={() => void actions.retry()}>
					重试保存原操作
				</button>
			)}
			<footer className="s11-foot">
				不把点击、接受率或使用时长当作你的生活目标。
			</footer>
		</section>
	);
}
