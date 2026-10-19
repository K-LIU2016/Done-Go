import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createDomainStore, FIXTURE_IDS } from "../../domain/index.ts";
import { buildWorkspaceExport } from "./workspace-export.ts";

async function draftState() {
  const store = createDomainStore({ dataMode: "fixture" });
  const base = { actor: "user" as const, issuedAt: "2026-09-13T12:00:00Z" };
  const plan = await store.execute({ ...base, commandId: "export-plan", type: "selectPlan", entityId: FIXTURE_IDS.intent, expectedRevision: 1, kind: "A" });
  assert.ok(plan.ok);
  const approval = await store.execute({ ...base, commandId: "export-grant", type: "grantApproval", entityId: plan.data.plan.id, expectedRevision: plan.data.plan.revision, changeSetId: plan.data.changeSet.id, grants: ["readMaterial", "createLocalDraft", "updateEstimate"] });
  assert.ok(approval.ok);
  assert.ok((await store.execute({ ...base, commandId: "export-start", type: "startOperation", entityId: approval.data.approval.id, expectedRevision: approval.data.approval.revision, approvalId: approval.data.approval.id })).ok);
  return structuredClone(store.getState());
}

test("export serializes only the selected saved draft, preserving versions, sources, open issues and unsent state", async () => {
  const state = await draftState();
  const draft = Object.values(state.drafts)[0];
  draft.sections[0].content = "真实正文\n第二行 <script>只作为文本</script>";
  draft.sections[0].openIssues = ["金额尚未核对"];
  draft.openQuestions = ["等待人工成本"];
  state.drafts.unrelated = { ...draft, id: "unrelated", sections: [{ ...draft.sections[0], content: "其他草稿不能导出" }] };
  const before = JSON.stringify(state);
  const result = buildWorkspaceExport(state, draft.id, draft.revision, "2026-09-13T13:00:00Z");
  assert.ok(result.ok);
  assert.match(result.file.filename, /^TangoDoneGo-draft-.+-v\d+\.json$/);
  assert.equal(result.file.mimeType, "application/json;charset=utf-8");
  const exported = JSON.parse(result.file.content);
  assert.equal(exported.format, "TangoDoneGo-draft-export");
  assert.equal(exported.dataMode, "fixture");
  assert.deepEqual(exported.draft, draft);
  assert.equal(exported.summary.sendState, "未发送");
  assert.deepEqual(exported.summary.pendingReviewSectionIds, draft.sections.filter(section => section.reviewStatus !== "confirmed").map(section => section.id));
  assert.ok(exported.sources.length > 0);
  assert.doesNotMatch(result.file.content, /其他草稿不能导出/);
  assert.equal(JSON.stringify(state), before);
});

test("withdrawn export keeps the withdrawal event and never turns withdrawal into sent", async () => {
  const state = await draftState();
  const draft = Object.values(state.drafts)[0];
  draft.status = "withdrawn";
  draft.withdrawal = { withdrawnAt: "2026-09-13T13:01:00Z", reason: "保留审计，不再使用" };
  const result = buildWorkspaceExport(state, draft.id, draft.revision, "2026-09-13T13:02:00Z");
  assert.ok(result.ok);
  const exported = JSON.parse(result.file.content);
  assert.equal(exported.summary.draftState, "已撤回");
  assert.equal(exported.summary.sendState, "未发送");
  assert.deepEqual(exported.draft.withdrawal, draft.withdrawal);
});

test("missing persisted data, unknown draft and changed revision refuse export instead of falling back", async () => {
  const state = await draftState();
  const draft = Object.values(state.drafts)[0];
  assert.equal(buildWorkspaceExport(null, draft.id, draft.revision, "2026-09-13T13:00:00Z").ok, false);
  assert.equal(buildWorkspaceExport(state, "missing", draft.revision, "2026-09-13T13:00:00Z").ok, false);
  assert.equal(buildWorkspaceExport(state, draft.id, draft.revision + 1, "2026-09-13T13:00:00Z").ok, false);
});

test("S06 exposes a selected-draft download action locked during unresolved writes", () => {
  const source = readFileSync(new URL("./WorkspaceScreen.tsx", import.meta.url), "utf8");
  assert.match(source, /data-workspace-export/);
  assert.match(source, /onClick=\{exportDraft\}/);
  assert.match(source, /disabled=\{busy !== null \|\| commandState\.busy \|\| commandState\.pending !== null\}/);
  assert.match(source, /buildWorkspaceExport\(fresh\.envelope\.state, draft\.id, draft\.revision/);
  assert.match(source, /downloadWorkspaceExport\(result\.file\)/);
});
