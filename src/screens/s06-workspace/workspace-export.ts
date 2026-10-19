import type { DomainState, Draft } from "../../domain/types.ts";

export interface WorkspaceExportFile {
  filename: string;
  mimeType: string;
  content: string;
}

const draftStates: Record<Draft["status"], string> = {
  generating: "生成中", pendingReview: "待检查", partiallyConfirmed: "部分确认",
  confirmed: "已确认", sent: "已发送", withdrawn: "已撤回",
};

export function buildWorkspaceExport(state: DomainState | null, draftId: string, expectedRevision: number, exportedAt: string):
  { ok: true; file: WorkspaceExportFile } | { ok: false; reason: string } {
  if (!state) return { ok: false, reason: "无法读取持久数据，未生成导出文件。" };
  const draft = state.drafts[draftId];
  if (!draft) return { ok: false, reason: "已保存的数据中没有这份草稿，未导出其他草稿。" };
  if (draft.revision !== expectedRevision) return { ok: false, reason: "草稿版本已经变化，请刷新读取已保存数据、核对后再导出。" };
  const sourceIds = new Set([...draft.sources, ...draft.sections.flatMap(section => section.sourceRefs)]);
  const records = {
    format: "TangoDoneGo-draft-export", schemaVersion: 1, exportedAt, dataMode: state.dataMode,
    notice: "仅导出这份已保存的本地草稿；不包含未保存编辑、其他草稿或材料正文。导出不是确认、发送或外部交付。",
    snapshot: { globalRevision: state.globalRevision, draftSavedAt: draft.updatedAt },
    summary: {
      draftState: draftStates[draft.status], sendState: draft.sentAt === null ? "未发送" : "已发送",
      pendingReviewSectionIds: draft.sections.filter(section => section.reviewStatus !== "confirmed").map(section => section.id),
    },
    commitment: { id: draft.commitmentId, scope: state.commitments[draft.commitmentId]?.scope ?? null },
    draft,
    sources: [...sourceIds].map(id => {
      const source = state.sources[id];
      return source ? { id, connectorId: source.connectorId, sourceVersion: source.sourceVersion, status: source.status, lastSuccessAt: source.lastSuccessAt, accessRevokedAt: source.accessRevokedAt } : { id, status: "unknown", sourceVersion: null };
    }),
    materials: Object.values(state.materials).filter(material => material.draftId === draft.id).map(material => ({
      id: material.id, name: material.name, version: material.version, verified: material.verified,
      readPermission: material.readPermission ?? null, sectionIds: material.sectionIds ?? [],
    })),
  };
  return { ok: true, file: {
    filename: "TangoDoneGo-draft-" + draft.id.replace(/[^a-zA-Z0-9_-]/g, "_") + "-v" + draft.version + ".json",
    mimeType: "application/json;charset=utf-8", content: JSON.stringify(records, null, 2) + "\n",
  } };
}

export function downloadWorkspaceExport(file: WorkspaceExportFile): void {
  const url = URL.createObjectURL(new Blob([file.content], { type: file.mimeType }));
  const link = document.createElement("a");
  try {
    link.href = url;
    link.download = file.filename;
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
