import { useState } from "react";
import { Check, Handshake, Pencil, RotateCcw, X } from "lucide-react";
import { useDomainState } from "../../data/react.ts";
import type { ReadyDomainRuntime } from "../../runtime/index.ts";
import type { AgreementRequest, AgreementTerms } from "../../domain/agreementModel.ts";
import type { DomainCommand } from "../../domain/types.ts";

interface AgreementPanelProps {
  handle: ReadyDomainRuntime;
}

const PARTY_LABELS: Record<string, string> = {
  user: "我",
  "colleague-chen": "同事·陈",
};

function statusLabel(request: AgreementRequest): string {
  if (request.agreement) return "已形成约定";
  if (request.status === "rejected") return "已拒绝";
  if (request.status === "withdrawn") return "已撤回";
  if (request.status === "expired") return "已过期";
  return "等待双方确认";
}

function responseLabel(status: string): string {
  return status === "accepted" ? "已接受" : status === "rejected" ? "已拒绝" : "待回应";
}

function nextCounterTerms(terms: AgreementTerms): AgreementTerms {
  const base = terms.effortRange.max ?? terms.effortRange.min ?? 60;
  return { ...terms, effortRange: { ...terms.effortRange, max: base + 15 } };
}

export function AgreementPanel({ handle }: AgreementPanelProps) {
  const state = useDomainState(handle.store);
  const request = Object.values(state.agreementRequests).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const [actorId, setActorId] = useState("user");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!request) return null;
  const version = request.versions.find((candidate) => candidate.version === request.currentVersion);
  if (!version) return null;
  const actorResponse = request.responses[actorId];
  const parties = [request.proposerId, request.recipientId];
  const isTerminal = ["withdrawn", "expired", "rejected", "agreed"].includes(request.status);

  const execute = (key: string, command: DomainCommand) => {
    setPending(key);
    setError(null);
    void handle.store.execute(command).then((result) => {
      setPending(null);
      if (!result.ok) setError(result.code + "：" + result.reason);
    });
  };

  const respond = (response: "accepted" | "rejected") => {
    if (isTerminal || !actorResponse) return;
    execute(response, {
      type: "respondAgreementRequest",
      commandId: "p1-agreement-" + response + "-" + request.id + "-r" + request.revision + "-" + actorId,
      entityId: request.id,
      expectedRevision: request.revision,
      actor: "user",
      actorId,
      termsVersion: version.version,
      termsHash: version.termsHash,
      response,
      issuedAt: new Date().toISOString(),
    });
  };

  const counter = () => {
    if (isTerminal) return;
    execute("counter", {
      type: "counterProposeAgreement",
      commandId: "p1-agreement-counter-" + request.id + "-r" + request.revision + "-" + actorId,
      entityId: request.id,
      expectedRevision: request.revision,
      actor: "user",
      actorId,
      terms: nextCounterTerms(version.terms),
      issuedAt: new Date().toISOString(),
    });
  };

  const withdraw = () => {
    if (isTerminal) return;
    execute("withdraw", {
      type: "withdrawAgreementRequest",
      commandId: "p1-agreement-withdraw-" + request.id + "-r" + request.revision + "-" + actorId,
      entityId: request.id,
      expectedRevision: request.revision,
      actor: "user",
      actorId,
      issuedAt: new Date().toISOString(),
    });
  };

  return (
    <aside className="s03-panel s03-agreement" aria-label="双人协商协议" data-agreement-state={request.status}>
      <div className="s03-agreement-head">
        <p className="s03-panel-kicker"><Handshake size={14} aria-hidden="true" /> P1 · 双人协商</p>
        <span className="s03-agreement-status">{statusLabel(request)}</span>
      </div>
      <h2 className="s03-panel-title">请求不等于承诺，双方同版才成立。</h2>
      <p className="s03-panel-body">当前条款 v{version.version} · hash {version.termsHash} · 过期 {request.expiresAt.slice(0, 16).replace("T", " ")}</p>
      <dl className="s03-agreement-terms">
        <div><dt>事项</dt><dd>{version.terms.purpose}</dd></div>
        <div><dt>投入</dt><dd>{version.terms.effortRange.min ?? "?"}–{version.terms.effortRange.max ?? "?"} 分钟</dd></div>
        <div><dt>截止</dt><dd>{version.terms.deadline?.slice(0, 16).replace("T", " ") ?? "尚未约定"}</dd></div>
      </dl>
      <div className="s03-agreement-parties">
        {parties.map((party) => {
          const response = request.responses[party];
          return <span key={party}><b>{PARTY_LABELS[party] ?? party}</b> {responseLabel(response?.status ?? "pending")}</span>;
        })}
      </div>
      <div className="s03-agreement-switch" aria-label="演示视角">
        <span>当前视角</span>
        {parties.map((party) => <button key={party} type="button" className={actorId === party ? "is-on" : ""} onClick={() => setActorId(party)}>{PARTY_LABELS[party] ?? party}</button>)}
      </div>
      <div className="s03-agreement-actions">
        <button type="button" className="s03-primary" onClick={() => respond("accepted")} disabled={isTerminal || pending !== null || actorResponse?.status === "accepted"}>
          <Check size={15} aria-hidden="true" /> {pending === "accepted" ? "正在接受…" : "接受此版本"}
        </button>
        <button type="button" className="s03-secondary" onClick={counter} disabled={isTerminal || pending !== null}>
          <Pencil size={15} aria-hidden="true" /> {pending === "counter" ? "正在提交…" : "提出修改（+15 分钟）"}
        </button>
        <button type="button" className="s03-tertiary" onClick={() => respond("rejected")} disabled={isTerminal || pending !== null}>
          <X size={15} aria-hidden="true" /> 拒绝
        </button>
        <button type="button" className="s03-tertiary" onClick={withdraw} disabled={isTerminal || pending !== null}>
          <RotateCcw size={15} aria-hidden="true" /> 撤回
        </button>
      </div>
      {request.agreement ? <p className="s03-agreement-formed" role="status"><Check size={15} aria-hidden="true" /> 已形成 Agreement；执行授权仍为空（{request.agreement.executionRefs.length}）</p> : null}
      {error ? <p className="s03-action-error" role="alert">{error}</p> : null}
      <p className="s03-agreement-note">这是本地 fixture 协商演示，演示时钟固定在 2026-09-12。真实环境由登录身份决定 actorId，服务端持久层负责版本与幂等校验。</p>
    </aside>
  );
}
