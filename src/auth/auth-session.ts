import { AuthError } from "./auth-client.ts";
import { createAuthController } from "./auth-controller.ts";
import type { AuthState } from "./auth-controller.ts";

export function resolveAuthDataOwner(state: AuthState): string {
  if (state.loading || !state.status || state.error) throw new AuthError("登录状态尚未确认，请重新连接账号服务。");
  return state.user?.id ?? "guest";
}

let reloadQueued = false;
let channel: BroadcastChannel | null = null;

function reloadForIdentityChange(broadcast = true) {
  if (typeof window === "undefined" || reloadQueued) return;
  reloadQueued = true;
  try { if (broadcast) channel?.postMessage("identity-changed"); } catch { channel = null; }
  // Allow the completed account action to close its dialog before navigation.
  window.setTimeout(() => window.location.reload(), 0);
}

const controller = createAuthController(undefined, reloadForIdentityChange);
let restoring: Promise<void> | null = null;
let openedOwner: string | null = null;

export function getBrowserAuthController() { return controller; }

export function restoreAuthSession(): Promise<void> {
  if (!restoring) {
    if (!channel && typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
      try {
        channel = new BroadcastChannel("tango-donego:auth-session");
        channel.onmessage = (event: MessageEvent<unknown>) => {
          if (event.data === "identity-changed") reloadForIdentityChange(false);
        };
      } catch { channel = null; }
    }
    restoring = controller.refresh().then(() => {
      const state = controller.getSnapshot();
      if (!state.loading && state.status && !state.error) openedOwner = resolveAuthDataOwner(state);
    }).finally(() => { restoring = null; });
  }
  return restoring;
}

export function getAuthDataOwner(): string {
  if (openedOwner === null) throw new AuthError("登录状态尚未确认，请重新连接账号服务。");
  return openedOwner;
}

/** Non-throwing view for device-level preferences; null means the session is not confirmed yet. */
export function peekAuthDataOwner(): string | null {
  return openedOwner;
}
