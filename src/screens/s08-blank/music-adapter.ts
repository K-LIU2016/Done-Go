export type MusicAccess =
  | { connection: "notConnected" | "unavailable"; reason: string }
  | { connection: "connected"; providerId: string; playbackPermission: "granted" | "denied" | "unknown" };

export type MusicPlaybackReceipt =
  | { status: "playing"; requestId: string; providerId: string; playbackRef: string; confirmedAt: string }
  | { status: "unavailable" | "denied" | "unknown"; reason: string };

export interface QuietMusicAdapter {
  inspectAccess(signal: AbortSignal): Promise<MusicAccess>;
  /** Implementations must bind requestId to one resume attempt; never authorize an account here. */
  resumePrevious(input: { requestId: string; signal: AbortSignal }): Promise<MusicPlaybackReceipt>;
  readPlayback(input: { requestId: string; signal: AbortSignal }): Promise<MusicPlaybackReceipt>;
}

export type QuietMusicResult = {
  kind: "notConnected" | "denied" | "unavailable" | "unknown" | "success";
  requestId: string;
  message: string;
  receipt?: Extract<MusicPlaybackReceipt, { status: "playing" }>;
};

type QuietMusicSnapshot = Readonly<{
  busy: boolean;
  pendingRequestId: string | null;
  result: QuietMusicResult | null;
}>;

interface QuietMusicController {
  getSnapshot(): QuietMusicSnapshot;
  subscribe(listener: () => void): () => void;
  run(createRequestId: () => string): Promise<QuietMusicResult | null>;
}

const runtimeControllers = new WeakMap<QuietMusicAdapter, QuietMusicController>();

export function quietMusicController(adapter: QuietMusicAdapter): QuietMusicController {
  const existing = runtimeControllers.get(adapter);
  if (existing) return existing;
  let snapshot: QuietMusicSnapshot = { busy: false, pendingRequestId: null, result: null };
  const listeners = new Set<() => void>();
  const publish = (next: QuietMusicSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const controller: QuietMusicController = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async run(createRequestId) {
      if (snapshot.busy) return null;
      const readbackOnly = snapshot.pendingRequestId !== null;
      const requestId = snapshot.pendingRequestId ?? createRequestId();
      publish({ ...snapshot, busy: true, pendingRequestId: requestId });
      const result = await runQuietMusic(adapter, requestId, { readbackOnly });
      publish({ busy: false, pendingRequestId: result.kind === "unknown" ? requestId : null, result });
      return result;
    },
  };
  runtimeControllers.set(adapter, controller);
  return controller;
}

export const unconfiguredMusicAdapter: QuietMusicAdapter = {
  async inspectAccess() { return { connection: "notConnected", reason: "尚未连接音乐来源，未发起播放请求。连接具体音乐账户需要另行授权。" }; },
  async resumePrevious() { return { status: "unavailable", reason: "尚未配置音乐来源。" }; },
  async readPlayback() { return { status: "unknown", reason: "尚未配置音乐来源，无法核对播放结果。" }; },
};

export async function runQuietMusic(adapter: QuietMusicAdapter, requestId: string, options: { readbackOnly?: boolean; timeoutMs?: number } = {}): Promise<QuietMusicResult> {
  const controller = new AbortController();
  let playbackAttempted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = (kind: QuietMusicResult["kind"], message: string): QuietMusicResult => ({ kind, requestId, message });
  try {
    const work = async (): Promise<QuietMusicResult> => {
      const access = await adapter.inspectAccess(controller.signal);
      if (controller.signal.aborted) return result("unavailable", "音乐来源检查已超时，未继续请求播放。");
      if (access.connection !== "connected") return result(access.connection, access.reason);
      if (!access.providerId.trim()) return result("unavailable", "音乐来源身份不明确，未请求播放。");
      if (access.playbackPermission !== "granted") return result("denied", access.playbackPermission === "denied" ? "音乐来源没有授予播放许可；未请求播放，也不会替你申请新权限。" : "无法确认既有播放许可，未请求播放。");
      playbackAttempted = !options.readbackOnly;
      const receipt = await (options.readbackOnly ? adapter.readPlayback : adapter.resumePrevious).call(adapter, { requestId, signal: controller.signal });
      if (receipt.status !== "playing") return result(receipt.status, receipt.reason);
      if (receipt.requestId !== requestId || receipt.providerId !== access.providerId || !receipt.playbackRef.trim() || !Number.isFinite(Date.parse(receipt.confirmedAt))) {
        return result("unknown", "音乐来源返回的播放回执不完整或不匹配，尚不能确认恢复播放。");
      }
      return { ...result("success", "音乐来源已确认恢复播放；这不会改变你的静默选择，也不计为时间收益。"), receipt };
    };
    const timedOut = new Promise<QuietMusicResult>(resolve => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(result(playbackAttempted || options.readbackOnly ? "unknown" : "unavailable", "音乐来源响应超时；未重新发送播放请求。"));
      }, options.timeoutMs ?? 8000);
    });
    const outcome = await Promise.race([work(), timedOut]);
    if (options.readbackOnly && outcome.kind !== "success") return result("unknown", outcome.message + " 原播放结果仍未确认，后续只查询这次请求。");
    return outcome;
  } catch {
    return result(playbackAttempted || options.readbackOnly ? "unknown" : "unavailable", playbackAttempted || options.readbackOnly ? "音乐来源未返回可核对结果；后续只查询这次请求，不重新播放。" : "暂时无法检查音乐来源，未请求播放。");
  } finally {
    clearTimeout(timer);
  }
}
