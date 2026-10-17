import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarCheck, CloudOff, ExternalLink, RefreshCw } from "lucide-react";
import { useDomainState } from "../../data/react.ts";
import type { DomainStore } from "../../domain/store.ts";
import type { Source, SourceProvider } from "../../domain/types.ts";
import type { SourceRevocationCommand } from "../../domain/handlers/sourceRevocation.ts";
import { ContextReviewSurface } from "../s11-context/context-review-runtime.tsx";
import { useContextReviewActions } from "../s11-context/use-context-review-actions.ts";
import "./s13-sync.css";
import { describeSourceRevocation, executeSourceRevocation, makeLocalRevocation, makeProviderRevocation } from "./source-revocation-surface.ts";

const commandIdentity = () => ({ commandId: crypto.randomUUID(), issuedAt: new Date().toISOString() });

function RevocationReceipt({ source }: { source: Source }) {
	const receipt = describeSourceRevocation(source);
	return <>
		<br />本地后续读取：已停止
		<br />{receipt.status}
		<br />申请时间：{receipt.requestedAt ?? "未记录"}
		<br />回执时间：{receipt.checkedAt ?? "尚未确认"}
		<br />{receipt.detail}
	</>;
}

function sourceProvider(source: Source): SourceProvider {
	const unavailable = async () => ({
		ok: false as const,
		reason: "此来源没有可用的外部连接适配器；未发起外部读取。",
	});
	const snapshot = async () =>
		source.dataMode === "fixture" &&
		source.connectorId === "fixture-calendar" &&
		source.lastUsableSnapshot
			? {
					ok: true as const,
					value: {
						intervals: source.lastUsableSnapshot.intervals,
						version: source.sourceVersion,
					},
				}
			: unavailable();
	return {
		readSnapshot: snapshot,
		sync: snapshot,
		executeAllowedAction: unavailable,
		readback: unavailable,
		revokeAccess: unavailable,
	};
}
function originalUrl(source: Source): string | null {
	if (!source.externalObjectId) return null;
	try {
		const url = new URL(source.externalObjectId);
		return url.protocol === "https:" && !url.username && !url.password
			? url.href
			: null;
	} catch {
		return null;
	}
}
export function S13Sync() {
	return (
		<ContextReviewSurface>
			{(store) => <SyncContent store={store} />}
		</ContextReviewSurface>
	);
}
function SyncContent({ store }: { store: DomainStore }) {
	const state = useDomainState(store);
	const actions = useContextReviewActions(store);
	const [syncing, setSyncing] = useState(false);
	const [message, setMessage] = useState("");
	const [revokeTarget, setRevokeTarget] = useState<Source | null>(null);
	const [pendingRevocation, setPendingRevocation] = useState<SourceRevocationCommand | null>(null);
	const running = useRef(false);
	const sources = Object.values(state.sources);
	const localMode = state.contextReview.localOnly?.enabled === true;
	const unknown =
		sources.length === 0 ||
		sources.some(
			(source) =>
				source.status !== "connected" ||
				!source.coverage.known ||
				source.lastUsableSnapshot?.stale,
		);
	const sourceUrl = sources.map(originalUrl).find((url) => url !== null);
	const sendRevocation = async (command: SourceRevocationCommand) => {
		if (running.current || actions.busy) return;
		running.current = true;
		setSyncing(true);
		setRevokeTarget(null);
		setMessage(command.type === "revokeSourceAccess" ? "正在确认本地停止读取。" : "正在确认撤权回执，本地仍停止读取。");
		try {
			const result = await executeSourceRevocation(store, command, commandIdentity);
			if (!result.ok) {
				setPendingRevocation(result.pending);
				setMessage("撤权记录尚未确认：" + result.reason + " 不会自动重新开放读取。");
				return;
			}
			setPendingRevocation(null);
			const receipt = describeSourceRevocation(result.source);
			setMessage(receipt.status + "。" + receipt.detail);
		} finally { running.current = false; setSyncing(false); }
	};
	const revoke = () => {
		if (!revokeTarget || pendingRevocation) return;
		return sendRevocation(makeLocalRevocation(revokeTarget, commandIdentity()));
	};
	const retry = async () => {
		if (running.current || pendingRevocation) return;
		running.current = true;
		setSyncing(true);
		setMessage("");
		try {
			let failed = false;
			for (const sourceId of Object.keys(store.getState().sources)) {
				const source = store.getState().sources[sourceId];
				const result = await store.execute({
					type: "syncSource",
					commandId: crypto.randomUUID(),
					entityId: source.id,
					expectedRevision: source.revision,
					actor: "user",
					issuedAt: new Date().toISOString(),
					provider: sourceProvider(source),
				});
				if (!result.ok) {
					failed = true;
					setMessage("同步未确认：" + result.reason);
					break;
				}
				if (result.data.syncResult !== "success") failed = true;
			}
			if (!sources.length) setMessage("尚无来源可重新同步。");
			else
				setMessage(
					(previous) =>
						previous ||
						(failed
							? "部分来源未更新。保留旧快照，保护状态保持待确认。"
							: "已重新核验来源记录。演示适配器结果不表示真实账号已同步。"),
				);
		} catch (error) {
			setMessage(
				"同步结果未确认：" +
					(error instanceof Error ? error.message : String(error)),
			);
		} finally {
			running.current = false;
			setSyncing(false);
		}
	};
	return (
		<section className="s13" data-page="s13" aria-label="同步状态">
			<header className="s13-head">
				<h1 className="s13-title">不知道的时候，就说不知道。</h1>
				<p className="s13-sub">
					数据未同步不等于没有安排。外部保护未核验，就保持待确认。
				</p>
			</header>
			<div className="s13-layout">
			<div className="s13-main">
				<span className="s13-chip">
					{localMode
						? "暂用本地计划"
						: unknown
							? "部分来源未同步"
							: "本地来源记录已知"}
				</span>
			<article className="s13-alert">
				<CloudOff size={22} aria-hidden="true" />
				<div>
					<h2 className="s13-alert-title">外部日历保护，仍需单独核验。</h2>
					<p className="s13-alert-body">
						来源读取成功不等于已写入外部保护事件。演示来源不会连接你的真实账号。
					</p>
				</div>
			</article>
			<div className="s13-grid">
				<article className="s13-card">
					<h2 className="s13-card-title">本地规则仍然有效</h2>
					{Object.values(state.protectedBlocks)
						.filter((block) => block.status === "active")
						.map((block) => (
							<p key={block.id} className="s13-card-line">
								{block.range.start.slice(0, 16).replace("T", " ")}—
								{block.range.end.slice(11, 16)} 不接受静驻内部的自动填充。
							</p>
						))}
				</article>
				<article className="s13-card">
					<h2 className="s13-card-title">外部日历保护待确认</h2>
					<p className="s13-card-line">
						闲忙投影和写入结果需要单独回读。不会显示“已全面保护”。
					</p>
				</article>
			</div>
			<div className="s13-actions s13-recheck">
				<button type="button" className="s13-btn"
					disabled={syncing || actions.busy || pendingRevocation !== null || sources.length === 0}
					onClick={() => void retry()}>
					<RefreshCw size={15} aria-hidden="true" />
					{syncing ? "正在重新核验" : "重新同步与核验"}
				</button>
				{sourceUrl ? (
					<a href={sourceUrl} target="_blank" rel="noreferrer" className="s13-btn s13-btn-ghost">
						<ExternalLink size={15} aria-hidden="true" />打开原日历
					</a>
				) : (
					<button type="button" className="s13-btn s13-btn-ghost" disabled title="来源未提供可验证的原日历链接">
						<ExternalLink size={15} aria-hidden="true" />原日历链接不可用
					</button>
				)}
			</div>
			<footer className="s13-foot">失败记录会保留；重试不会创建新的保护事件。</footer>
			</div>
			<aside className="s13-sidebar" aria-label="来源与本地接管">
			<section className="s13-source-panel" aria-label="目前知道什么">
			<h2 className="s13-card-title">目前知道什么</h2>
			<ul className="s13-sources">
				{sources.map((source) => (
					<li key={source.id}>
						<span className="s13-source-name">
							{source.connectorId === "fixture-calendar"
								? "演示日历"
								: source.connectorId}
							{source.dataMode === "fixture" ? " · 合成演示" : ""}
						</span>
						<span
							className={
								source.status === "connected"
									? "s13-source-state is-ok"
									: "s13-source-state"
							}
						>
							{
								{
									connected: "已连接",
									stale: "需要更新",
									error: "同步失败",
									revoked: "已撤销",
									unconnected: "尚未连接",
								}[source.status]
							}{" "}
							· 版本 {source.sourceVersion}
							<br />
							最近成功：{source.lastSuccessAt ?? "尚未同步"}
							<br />
							{source.coverage.known
								? source.coverage.intervals.length + " 段已知范围"
								: "范围未知"}
							{source.lastUsableSnapshot?.stale ? " · 旧快照已标记过期" : ""}
							{source.lastError && (
								<>
									<br />
									失败记录：{source.lastError}
								</>
							)}
							{source.status === "revoked" && <RevocationReceipt source={source} />}
						</span>
						<button type="button" className="s13-btn s13-btn-ghost"
							disabled={syncing || actions.busy || pendingRevocation !== null || (source.status === "revoked" && source.revocation?.remoteOutcome === "confirmed")}
							onClick={() => source.status === "revoked" ? void sendRevocation(makeProviderRevocation(source, commandIdentity())) : setRevokeTarget(source)}>
							{source.status === "revoked" ? source.revocation?.remoteOutcome === "confirmed" ? "已停止读取" : "重试确认撤权回执" : "停止读取此来源"}
						</button>
					</li>
				))}
			</ul>
			{revokeTarget && (
				<section className="s13-card" aria-label="确认停止读取来源">
					<h2 className="s13-card-title">停止读取{revokeTarget.dataMode === "fixture" ? "演示来源" : "此来源"}？</h2>
					<p>将停止后续读取，使依赖此来源的未执行方案失效。历史记录保留，已传出的副本不会因此被召回。</p>
					{revokeTarget.dataMode === "fixture" && <p>此操作仅作用于合成演示数据，不修改真实账户权限。</p>}
					<div className="s13-actions">
						<button type="button" className="s13-btn" disabled={syncing || actions.busy || pendingRevocation !== null} onClick={() => void revoke()}>确认停止读取</button>
						<button type="button" className="s13-btn s13-btn-ghost" disabled={syncing} onClick={() => setRevokeTarget(null)}>取消</button>
					</div>
				</section>
			)}
			{pendingRevocation && (
				<section className="s13-card" aria-label="未确认的撤权记录">
					<p className="s13-card-line">{pendingRevocation.type === "revokeSourceAccess" ? "本地停止读取" : "供应商撤权回执"}的写入尚未确认。请先重试原记录，再继续其他来源操作。</p>
					<button type="button" className="s13-btn" disabled={syncing || actions.busy} onClick={() => void sendRevocation(pendingRevocation)}>重试保存原撤权记录</button>
				</section>
			)}
			{sources.length === 0 && (
				<p className="s13-note">尚未连接任何来源，外部安排未知。</p>
			)}
			</section>
			<section className="s13-fallback" aria-label="本地接管">
			<h2 className="s13-card-title">可以继续，不必假装完整。</h2>
			<p className="s13-note">
				暂时使用本地计划时，不会把未知时段分配给新的自动任务；你仍可以在原工具中接管。
			</p>
			<div className="s13-actions">
				<button
					type="button"
					className="s13-btn s13-btn-ghost"
					disabled={actions.busy || syncing || pendingRevocation !== null}
					onClick={() =>
						void actions.run({
							type: localMode ? "returnToConnected" : "enterLocalOnly",
							actor: "user",
						})
					}
				>
					<CalendarCheck size={15} aria-hidden="true" />
					{localMode ? "核验后返回连接模式" : "暂用本地计划"}
				</button>
				<Link to="/boundaries" className="s13-btn s13-btn-ghost">
					管理读取权限
				</Link>
			</div>
			</section>
			</aside>
			</div>
			{syncing && (
				<p className="s13-live" role="status">
					正在保存与核验来源状态。
				</p>
			)}
			{message && (
				<p className="s13-live" role="status">
					{message}
				</p>
			)}
			{actions.message && (
				<p className="s13-live" role="status">
					{actions.message}
				</p>
			)}
			{actions.retryable && (
				<button disabled={actions.busy || syncing || pendingRevocation !== null} onClick={() => void actions.retry()}>
					重试保存原操作
				</button>
			)}
			{localMode && (
				<p className="s13-live is-ok">
					已暂用本地计划。未知时段不会分配给新的自动任务。返回连接模式前需重新核验全部来源。
				</p>
			)}
		</section>
	);
}
