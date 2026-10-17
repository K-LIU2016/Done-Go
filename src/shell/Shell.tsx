import { useEffect } from "react";
import type { ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { AuthProvider } from "../auth/AuthProvider";
import { AccountControl } from "../auth/AccountControl";
import "./shell.css";
import "../settings/settings.css";

function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.5 19.5v-9.1L12 4.6l7.5 5.8v9.1" />
      <path d="M4.5 19.5h5.3v-4.4a1.2 1.2 0 0 1 1.2-1.2h2a1.2 1.2 0 0 1 1.2 1.2v4.4h5.3" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="7.5" />
      <path d="M12 8v4.2l2.8 1.6" />
    </svg>
  );
}

function InboxIcon() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.5 13.6 6.9 6a1 1 0 0 1 .95-.7h8.3a1 1 0 0 1 .95.7l2.4 7.6" />
      <path d="M4.5 13.6V18a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-4.4" />
      <path d="M4.5 13.6h4.6c.4 1.6 1.5 2.5 2.9 2.5s2.5-.9 2.9-2.5h4.6" />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4.5c.55 3.9 2.25 5.6 6.15 6.15-3.9.55-5.6 2.25-6.15 6.15-.55-3.9-2.25-5.6-6.15-6.15 3.9-.55 5.6-2.25 6.15-6.15Z" />
    </svg>
  );
}

function BarsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6.5 16.5v-3" />
      <path d="M12 16.5v-7" />
      <path d="M17.5 16.5v-5" />
      <path d="M4.5 19.5h15" />
    </svg>
  );
}

function ShieldCheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4.5c2.2 1.15 4.4 1.75 6.5 1.95 0 5.45-1.8 9.5-6.5 12.4-4.7-2.9-6.5-6.95-6.5-12.4 2.1-.2 4.3-.8 6.5-1.95Z" />
      <path d="m9.4 11.8 1.9 1.9 3.4-3.5" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="5.5" />
      <path d="m15.3 15.3 3.7 3.7" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.2 12a7.2 7.2 0 0 0-.14-1.4l2-1.55-2-3.46-2.36.95a7.3 7.3 0 0 0-2.42-1.4L13.9 2.6h-3.8l-.38 2.54a7.3 7.3 0 0 0-2.42 1.4l-2.36-.95-2 3.46 2 1.55A7.2 7.2 0 0 0 4.8 12c0 .47.05.94.14 1.4l-2 1.55 2 3.46 2.36-.95a7.3 7.3 0 0 0 2.42 1.4l.38 2.54h3.8l.38-2.54a7.3 7.3 0 0 0 2.42-1.4l2.36.95 2-3.46-2-1.55c.09-.46.14-.93.14-1.4Z" />
    </svg>
  );
}

function PorcelainMark() {
  return (
    <img
      className="shell-mark"
      src="/brand/tango-mark.svg"
      alt="Tango Done&Go"
      width={34}
      height={34}
      draggable={false}
    />
  );
}

const NAV_ITEMS = [
  { to: "/", label: "此刻", Icon: HomeIcon },
  { to: "/ledger", label: "时间", Icon: ClockIcon },
  { to: "/inbox", label: "收件", Icon: InboxIcon },
  { to: "/workspace", label: "协同", Icon: SparkleIcon },
  { to: "/review", label: "回顾", Icon: BarsIcon },
  { to: "/boundaries", label: "边界", Icon: ShieldCheckIcon },
];

const PAGE_NUMBERS: Record<string, string> = {
  "/": "01",
  "/ledger": "02",
  "/inbox": "03",
  "/plan": "04",
  "/preview": "05",
  "/workspace": "06",
  "/session": "07",
  "/stillness": "08",
  "/attention": "09",
  "/boundaries": "10",
  "/context": "11",
  "/review": "12",
  "/sync": "13",
  "/capture": "14",
};

export function Shell({ children }: { children: ReactNode }) {
  return <AuthProvider><ShellContent>{children}</ShellContent></AuthProvider>;
}

function ShellContent({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const pageNumber = PAGE_NUMBERS[pathname] ?? "01";
  const pageLabel = pathname === "/settings" ? "设置" : pageNumber + " / 14";

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isK = event.code === "KeyK" || event.key.toLowerCase() === "k";
      if (!isK) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.altKey || event.shiftKey) return;
      if (document.querySelector(".auth-dialog[open]")) return;
      event.preventDefault();
      if (window.location.pathname === "/capture") return;
      navigate("/capture");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pathname, navigate]);

  return (
    <div className="shell" data-shell="">
      <aside className="shell-rail" data-shell-rail="">
        <PorcelainMark />
        <nav className="shell-nav" aria-label="主导航">
          {NAV_ITEMS.map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={to}
            className={({ isActive }) =>
                isActive ? "shell-nav-item is-active" : "shell-nav-item"
              }
            >
              <Icon />
              <span className="shell-nav-label">{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="shell-rail-foot">
          <NavLink to="/settings" className="shell-settings" data-shell-settings="" aria-label="设置">
            <GearIcon />
          </NavLink>
          <NavLink to="/capture" className="shell-search" data-shell-search="" aria-label="搜索 · 快捷输入 ⌘K">
            <span className="shell-search-btn">
              <SearchIcon />
            </span>
            <span className="shell-search-key" aria-hidden="true">⌘ K</span>
          </NavLink>
          <AccountControl />
        </div>
      </aside>
      <div className="shell-main">
        <header className="shell-topbar" data-shell-topbar="">
          <div className="shell-brand" data-shell-brand="">
            <img className="shell-brand-mark" src="/brand/tango-mark.svg" alt="" width={26} height={26} draggable={false} />
            <span className="shell-brand-zh">探戈</span>
            <span className="shell-brand-slash" aria-hidden="true">/</span>
            <span className="shell-brand-en">DONE&amp;GO</span>
          </div>
          <div className="shell-topbar-end">
            <span className="shell-badge" data-shell-badge="">概念设计 · 演示状态</span>
            <span className="shell-date" data-shell-date="">09.12 · 星期六</span>
          </div>
        </header>
        <main className="shell-content" data-shell-content="">{children}</main>
        <footer className="shell-footer" data-shell-footer="">
          <div className="shell-footer-row">
            <span className="shell-footer-brand">探戈 Done&Go</span>
            <span className="shell-footer-note">界面为独立演示状态；不代表已连接、已执行或真实收益。</span>
            <span className="shell-footer-page" data-shell-footer-page="">
              {pageLabel}
            </span>
          </div>
        </footer>
      </div>
    </div>
  );
}

export function MobileStage({ children }: { children: ReactNode }) {
  return (
    <div className="mobile-stage">
      <div className="mobile-frame">{children}</div>
    </div>
  );
}
