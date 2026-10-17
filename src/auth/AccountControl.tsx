import { useEffect, useRef, useState } from "react";
import { AuthDialog } from "./AuthDialog";
import { useAuth } from "./use-auth";

export function AccountControl() {
  const { user, loading } = useAuth();
  const [open, setOpen] = useState(false);
  const identity = useRef<{ owner: string | undefined; reloading: boolean } | null>(null);
  const owner = user?.id;
  useEffect(() => {
    if (loading) return;
    if (identity.current === null) {
      identity.current = { owner, reloading: false };
      return;
    }
    if (identity.current.owner !== owner && !identity.current.reloading) {
      identity.current.reloading = true;
      window.location.reload();
    }
  }, [loading, owner]);
  const name = user?.displayName || user?.email || "登录";
  return <div className="shell-account">
    <button type="button" className="shell-account-button" data-shell-avatar="" title={user ? `${name} · ${user.email}` : "登录 Tango Done&Go"} aria-label={user ? `${name} · ${user.email} · 我的账号` : "登录 Tango Done&Go"} onClick={() => setOpen(true)}>
      <span className="shell-avatar-disc" aria-hidden="true">{user ? Array.from(name).slice(0, 2).join("").toUpperCase() : "入"}</span>
      <span className="shell-account-label">{loading ? "确认中" : name}</span>
    </button>
    {open && <AuthDialog onClose={() => setOpen(false)} />}
  </div>;
}
