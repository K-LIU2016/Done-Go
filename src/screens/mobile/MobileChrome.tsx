import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { BatteryFull, Clock3, Home, MoreHorizontal, Settings, ShieldCheck, Sparkles, Wifi } from "lucide-react";
import "./mobile-chrome.css";

const TABS = [
  { to: "/m/now", label: "此刻", key: "now", icon: Home },
  { to: "/ledger", label: "时间", key: "ledger", icon: Clock3 },
  { to: "/m/plan", label: "协同", key: "plan", icon: Sparkles },
  { to: "/m/auth", label: "我的", key: "auth", icon: ShieldCheck },
];

export function MobileChrome({
  time,
  active,
  children,
  hideNavigation = false,
  pageTitle,
}: {
  time: string;
  active: string;
  children: ReactNode;
  hideNavigation?: boolean;
  pageTitle?: string;
}) {
  return (
    <div className="mchrome">
      <div className="mchrome-status">
        <span className="mchrome-time">{time}</span>
        <span className="mchrome-sig">
          <Wifi size={14} aria-hidden="true" />
          <BatteryFull size={18} aria-hidden="true" />
        </span>
      </div>
      {hideNavigation ? null : (
        <header className="mchrome-heading">
          <img className="mchrome-brandmark" src="/brand/tango-mark.svg" alt="" draggable={false} />
          <span className="mchrome-page-title">{pageTitle ?? (active === "plan" ? "可行方案" : active === "auth" ? "变更预览" : active === "settings" ? "设置" : "Done&Go")}</span>
          <details className="mchrome-more">
            <summary aria-label="更多页面"><MoreHorizontal size={22} aria-hidden="true" /></summary>
            <div className="mchrome-more-menu">
              <NavLink to="/m/settings"><Settings size={17} aria-hidden="true" />设置</NavLink>
              <NavLink to="/capture">快捷输入</NavLink>
            </div>
          </details>
        </header>
      )}
      <div className="mchrome-body" role="region" aria-label={(pageTitle ?? "移动页面") + "内容"} tabIndex={0}>{children}</div>
      {hideNavigation ? null : (
        <nav className="mchrome-tabbar" aria-label="移动端导航">
          {TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={
                tab.key === active ? "mchrome-tab is-active" : "mchrome-tab"
              }
            >
              <tab.icon size={22} strokeWidth={1.7} aria-hidden="true" />
              <span>{tab.label}</span>
            </NavLink>
          ))}
        </nav>
      )}
      {hideNavigation ? null : <div className="mchrome-home-indicator" aria-hidden="true" />}
    </div>
  );
}
