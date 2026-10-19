import { useEffect, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { getAuthDataOwner, getBrowserAuthController, restoreAuthSession } from "./auth-session";
import { getAppearanceStore } from "../appearance/browser.ts";
import "./auth.css";

export function AuthBootstrap({ children }: { children: ReactNode }) {
  const controller = getBrowserAuthController();
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [openedOwner, setOpenedOwner] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void restoreAuthSession().then(() => {
      if (active && !controller.getSnapshot().error) {
        setOpenedOwner(getAuthDataOwner());
        getAppearanceStore().refreshFromStorage();
      }
    });
    return () => { active = false; };
  }, [controller]);
  async function retry() {
    await restoreAuthSession();
    if (!controller.getSnapshot().error) {
      setOpenedOwner(getAuthDataOwner());
      getAppearanceStore().refreshFromStorage();
    }
  }
  if (state.loading) return <main className="auth-bootstrap" role="status"><p>正在确认登录状态…</p></main>;
  if (openedOwner === null && (!state.status || state.error)) return <main className="auth-bootstrap"><h1>暂时无法打开你的静驻</h1><p role="alert">{state.error ?? "账号服务尚未返回登录状态。"}</p><button className="auth-secondary" onClick={() => void retry()}>重新连接</button></main>;
  const owner = state.user?.id ?? "guest";
  if (openedOwner === null) return <main className="auth-bootstrap" role="status"><p>正在确认登录状态…</p></main>;
  if (openedOwner !== owner) return <main className="auth-bootstrap" role="status"><p>正在切换账号数据…</p></main>;
  return children;
}
