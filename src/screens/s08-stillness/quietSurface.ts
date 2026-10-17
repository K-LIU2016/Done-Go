import type {
  DomainState,
  ProtectedBlock,
  QuietSession,
} from "../../domain/types.ts";

export type QuietBlockSelection =
  | { kind: "selected"; block: ProtectedBlock }
  | { kind: "empty" }
  | { kind: "notFound"; blockId: string; reason: string };

export function selectProtectedBlock(
  state: DomainState,
  explicitBlockId: string | null,
): QuietBlockSelection {
  if (explicitBlockId !== null) {
    const match = Object.values(state.protectedBlocks).find(
      (b) => b.blockId === explicitBlockId,
    );
    if (!match) {
      return {
        kind: "notFound",
        blockId: explicitBlockId,
        reason: "没有匹配这个 ID 的保护时段记录",
      };
    }
    if (match.status !== "active") {
      return {
        kind: "notFound",
        blockId: explicitBlockId,
        reason: "这个保护时段已结束或已释放",
      };
    }
    return { kind: "selected", block: match };
  }
  const active = Object.values(state.protectedBlocks).filter(
    (b) => b.status === "active",
  );
  if (active.length === 0) return { kind: "empty" };
  const chosen = active.reduce((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? a : b;
    return a.id > b.id ? a : b;
  });
  return { kind: "selected", block: chosen };
}

export function selectLatestQuietSession(
  state: DomainState,
  blockId: string,
): QuietSession | null {
  const sessions = Object.values(state.quietSessions).filter(
    (s) => s.blockId === blockId,
  );
  if (sessions.length === 0) return null;
  return sessions.reduce((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? a : b;
    return a.id > b.id ? a : b;
  });
}

export function shouldOpenQuietSession(latest: QuietSession | null): boolean {
  return latest === null;
}

export function verifyDecisionRecorded(
  state: DomainState,
  sessionId: string,
  decision: "keepStill" | "exit",
): boolean {
  const session = state.quietSessions[sessionId];
  return session !== undefined && session.decision === decision;
}

export function planQuietClose(state: DomainState, persisted: DomainState | null, sessionId: string): "preserve" | "unverified" | "recordExit" {
  const session = state.quietSessions[sessionId];
  const saved = persisted?.quietSessions[sessionId];
  if (session?.decision !== "keepStill" && saved?.decision !== "keepStill") return "recordExit";
  return session?.decision === "keepStill" && session.suppressPrompts &&
    saved?.decision === "keepStill" && saved.suppressPrompts && saved.revision === session.revision
    ? "preserve" : "unverified";
}

export function formatIsoClock(value: string): string | null {
  const match = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})(?::\d{2})?/.exec(value);
  return match === null ? null : match[1];
}

export interface QuietBlockSurface {
  start: string | null;
  end: string | null;
  timezone: string;
  purpose: string | null;
}

export function describeQuietBlock(block: ProtectedBlock): QuietBlockSurface {
  return {
    start: formatIsoClock(block.range.start),
    end: formatIsoClock(block.range.end),
    timezone: block.range.timezone,
    purpose: block.purpose,
  };
}

export function quietCoverageKnown(
  session: QuietSession | null,
): boolean | null {
  return session === null ? null : session.coverageSnapshot.known;
}

export type QuietRetryPlan = "replayExact" | "rederiveFromState";

export function planQuietRetry(failureCode: string): QuietRetryPlan {
  return failureCode === "REVISION_CONFLICT"
    ? "rederiveFromState"
    : "replayExact";
}

const QUIET_RETURN_BASE = "http://quiet.return.invalid";
const QUIET_ROUTE_PATHS = new Set(["/stillness", "/m/stillness"]);

export type QuietReturnToRejection =
  | "missing"
  | "notInternal"
  | "external"
  | "quietLoop";

export type QuietReturnToResolution =
  | { ok: true; path: string }
  | { ok: false; reason: QuietReturnToRejection };

function quietReturnHasForbiddenChar(raw: string): boolean {
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) {
      return true;
    }
    if (/\s/u.test(ch)) {
      return true;
    }
  }
  return false;
}

export function validateQuietReturnTo(
  raw: string | null | undefined,
): QuietReturnToResolution {
  if (raw === null || raw === undefined || raw.length === 0) {
    return { ok: false, reason: "missing" };
  }
  if (quietReturnHasForbiddenChar(raw)) {
    return { ok: false, reason: "notInternal" };
  }
  if (!raw.startsWith("/")) {
    return { ok: false, reason: "notInternal" };
  }
  if (raw.startsWith("//") || raw.includes("\\")) {
    return { ok: false, reason: "external" };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw, QUIET_RETURN_BASE);
  } catch {
    return { ok: false, reason: "notInternal" };
  }
  if (parsed.origin !== QUIET_RETURN_BASE) {
    return { ok: false, reason: "external" };
  }
  const barePath =
    parsed.pathname.length > 1 && parsed.pathname.endsWith("/")
      ? parsed.pathname.slice(0, -1)
      : parsed.pathname;
  if (
    QUIET_ROUTE_PATHS.has(parsed.pathname) ||
    QUIET_ROUTE_PATHS.has(barePath)
  ) {
    return { ok: false, reason: "quietLoop" };
  }
  return { ok: true, path: raw };
}

export function selectQuietEntryOrigin(
  rawReturnTo: string | null | undefined,
  fallback: string,
): string {
  const check = validateQuietReturnTo(rawReturnTo);
  return check.ok ? check.path : fallback;
}

export interface QuietExitSelection {
  queryReturnTo: string | null | undefined;
  sessionOriginRoute: string | null | undefined;
  fallback: string;
}

export function selectQuietExitTarget(selection: QuietExitSelection): string {
  for (const candidate of [
    selection.queryReturnTo,
    selection.sessionOriginRoute,
  ]) {
    const check = validateQuietReturnTo(candidate);
    if (check.ok) {
      return check.path;
    }
  }
  return selection.fallback;
}

export function describeQuietExecuteFailure(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return "本地记录提交失败：" + error.message + "；结果未知，不会当作已保存。";
  }
  return "本地记录提交出现未知异常；结果未知，不会当作已保存。";
}
