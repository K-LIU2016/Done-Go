import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowRight, Lock, Sparkles } from "lucide-react";
import { QuietArtwork } from "../../components/QuietArtwork.tsx";
import { useDomainState } from "../../data/react.ts";
import { retryDomainRuntime, useDomainRuntime, type ReadyDomainRuntime } from "../../runtime/index.ts";
import { ProtectedBlockForm } from "../../components/ProtectedBlockForm.tsx";
import { selectSurfaceDate } from "../s01-now/timeSurfaces.ts";
import { MobileChrome } from "../mobile/MobileChrome";
import { buildMobileNowSurfaceModel } from "./mobile-now-context.ts";
import "./s15-m-now.css";
import { buildMobileNowActions } from "./mobile-now-actions.ts";

export function S15MNow() {
  const [runtimeEpoch, setRuntimeEpoch] = useState(0);
  return (
    <div data-page="s15">
      <MobileChrome time="17:00" active="now">
        <S15RuntimeBody
          key={runtimeEpoch}
          onRetrySettled={() => setRuntimeEpoch((epoch) => epoch + 1)}
        />
      </MobileChrome>
    </div>
  );
}

function S15RuntimeBody({ onRetrySettled }: { onRetrySettled: () => void }) {
  const runtime = useDomainRuntime("fixture");
  const [retrying, setRetrying] = useState(false);
  if (runtime.status === "loading") {
    return (
      <section className="s15" aria-label="移动端此刻">
        <p className="s15-note" role="status" data-runtime-state="loading">
          正在连接本地领域数据…
        </p>
      </section>
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
      <section className="s15" aria-label="移动端此刻">
        <p className="s15-note" role="status" data-runtime-state="unavailable">
          本地领域数据当前不可读：{runtime.reason}。原始数据已保留，未被清除。
        </p>
        <button
          type="button"
          className="s15-cta"
          data-runtime-retry
          onClick={retry}
          disabled={retrying}
        >
          {retrying ? "正在重试连接…" : "重试连接本地数据"}
        </button>
      </section>
    );
  }
  return <S15Ready handle={runtime.runtime} />;
}

function S15Ready({ handle }: { handle: ReadyDomainRuntime }) {
  const store = handle.store;
  const navigate = useNavigate();
  const location = useLocation();
  const state = useDomainState(store);
  const searchParams = new URLSearchParams(location.search);
  const model = buildMobileNowSurfaceModel(
    state,
    searchParams.getAll("intentId"),
  );
  const actions = buildMobileNowActions(state, model);
  if (!model.ready) {
    const standaloneBlocks = model.reason === "noApplicableIntent"
      ? Object.values(state.protectedBlocks).filter(block => block.status === "active" && block.intentId === null)
      : [];
    return (
      <section className="s15" aria-label="移动端此刻" data-s15-intent-routing="fail-closed">
        <h1 className="s15-title">{model.title}</h1>
        <article className="s15-card" role="alert" data-s15-intent-routing-reason={model.reason}>
          <p className="s15-note">{model.detail}</p>
          {standaloneBlocks.map(block => (
            <div key={block.id} className="s15-saved-protection">
              <p className="s15-note">已保存的保护时间：{block.range.start} — {block.range.end}（{block.range.timezone}）</p>
              <p className="s15-note">{block.purpose || "没有设置用途，也成立。"}</p>
              <Link className="s15-setup" to={"/m/stillness?" + new URLSearchParams({ blockId: block.blockId, returnTo: "/m/now" }).toString()}>进入这段静驻<ArrowRight size={16} aria-hidden="true" /></Link>
            </div>
          ))}
          {actions.setupHref && <ProtectedBlockForm store={store} readPersistedState={() => handle.persistence.readFreshState()} intentId={null} initialDate={selectSurfaceDate(state)} />}
        </article>
      </section>
    );
  }
  const timeCard = <>
    <p className="s15-kicker"><Lock size={14} aria-hidden="true" />你的时间意图</p>
    {model.heroRangeLabel !== null ? <p className="s15-range">{model.heroRangeLabel}</p> : null}
    <p className="s15-note">{model.heroNote}</p>
    {model.warningTone === "warm" ? (
      <p className="s15-warn" role="status" data-s15-capacity={model.capacity.kind}><AlertTriangle size={14} aria-hidden="true" />{model.warningText}</p>
    ) : <p className="s15-note" data-s15-capacity={model.capacity.kind}>{model.warningText}</p>}
  </>;
  return (
    <section className="s15" aria-label="移动端此刻">
      <p className="s15-date" data-s15-intent={model.intentId}>{model.dateLabel}</p>
      <div className="s15-hero">
        <h1 className="s15-title">{model.intentSource === "explicit" ? "把这段时间，" : "把今晚，"}<br />留给自己。</h1>
        <QuietArtwork className="s15-hero-art" />
      </div>

      {actions.ledgerHref ? (
        <Link className="s15-card s15-time-card" to={actions.ledgerHref} aria-label={model.dateLabel + " " + model.heroRangeLabel + "，在时间账本中查看"}>
          {timeCard}
          <span className="s15-card-link">在时间账本中查看<ArrowRight size={16} aria-hidden="true" /></span>
        </Link>
      ) : (
        <article className="s15-card s15-time-card">
          {timeCard}
          {actions.setupHref && <ProtectedBlockForm store={store} readPersistedState={() => handle.persistence.readFreshState()} intentId={model.intentId} initialDate={model.capacity.date} />}
        </article>
      )}

      <h2 className="s15-decide-title">现在，只需一个决定。</h2>
      <article className="s15-card s15-decision-card">
        <p className="s15-decide-lead"><Sparkles size={21} aria-hidden="true" />换一种做法，保住这一小时。</p>
        <p className="s15-note">
          AI 先准备报告，你从检查开始。预计减少投入，不悄悄降低交付标准。
        </p>
        <button
          type="button"
          className="s15-cta"
          onClick={() => navigate(model.planHref)}
        >
          查看两条路径
          <ArrowRight size={18} aria-hidden="true" />
        </button>
      </article>

      <p className="s15-foot-note">{model.modificationFootnote}</p>

      <p className="s15-demo">界面演示 · 非真实账户数据</p>
    </section>
  );
}
