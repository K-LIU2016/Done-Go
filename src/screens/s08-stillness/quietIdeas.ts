import type { DomainStore } from "../../domain/store.ts";
import type { DomainState, SaveCaptureDraftCommand } from "../../domain/types.ts";

export function makeQuietIdeaCommand(raw: string, commandId: string, issuedAt: string): SaveCaptureDraftCommand | null {
  if (!raw.trim()) return null;
  return { type: "saveCaptureDraft", commandId, issuedAt, entityId: null, expectedRevision: null, actor: "user", channel: "text", raw };
}

export function selectRecentQuietText(state: DomainState) {
  return Object.values(state.captureDrafts)
    .filter((draft) => draft.status === "open" && draft.channel === "text" && draft.raw.trim())
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    .slice(0, 5);
}

export async function saveQuietIdea(
  store: DomainStore,
  readback: () => DomainState | null,
  command: SaveCaptureDraftCommand,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const result = await store.execute(command);
    if (!result.ok) return { ok: false, reason: result.code + "：" + result.reason };
    const draft = result.data.captureDraft;
    const saved = readback()?.captureDrafts[draft.id];
    if (!saved || saved.revision !== draft.revision || saved.raw !== command.raw) {
      return { ok: false, reason: "本地保存尚未读回确认。文字仍保留，可以重试同一记录。" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "本地保存暂时不可用。文字仍保留，可以重试同一记录。" };
  }
}
