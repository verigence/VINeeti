// The signed-in frame around every screen: sidebar on a wide screen; on a phone a compact top bar,
// a bottom tab bar and a "More" sheet. All three menus are drawn from the list in nav.ts.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "../api";
import { personName } from "../labels";
import { canApprove, destinationsFor, isActive, tabsFor, type Destination } from "../nav";
import { productName } from "../product";
import { Link, useRouter } from "../router";
import { Routes } from "../routes";
import { AlertsContext, useSession, type AlertsState } from "../session";
import type { AlertRow } from "../types";
import { StatusBars } from "./AppBars";
import { Dialog } from "./Dialog";
import { Icon } from "./icons";
import { Button } from "./ui";

const countText = (n: number) => (n > 99 ? "99+" : String(n));

export function Shell() {
  const { me, can, signOut, roleLabel } = useSession();
  const { path } = useRouter();
  const [moreOpen, setMoreOpen] = useState(false);
  const [alerts, setAlerts] = useState<{ rows: AlertRow[]; loading: boolean; error: string | null }>({ rows: [], loading: true, error: null });
  const [pending, setPending] = useState(0);
  const approver = canApprove(can);

  const reload = useCallback(async () => {
    const [rows, overview] = await Promise.allSettled([api.alerts(), approver ? api.overview() : Promise.resolve(null)]);
    if (rows.status === "fulfilled") setAlerts({ rows: rows.value, loading: false, error: null });
    else setAlerts((a) => ({ rows: a.rows, loading: false, error: errorMessage(rows.reason) }));
    if (overview.status === "fulfilled" && overview.value) {
      const o = overview.value;
      setPending((can("booking.approve") ? o.bookings.awaiting_approval : 0) + (can("exception.decide") ? o.approvals.exceptions_pending : 0));
    }
  }, [approver, can]);

  // Badges are refreshed when the screen changes, once a minute, and after every action (see useAction).
  useEffect(() => {
    void reload();
  }, [reload, path]);
  useEffect(() => {
    const t = window.setInterval(() => void reload(), 60_000);
    return () => window.clearInterval(t);
  }, [reload]);
  useEffect(() => setMoreOpen(false), [path]);

  const unread = alerts.rows.filter((a) => !a.read_at).length;
  const unreadAlarms = me.receives_alarms ? alerts.rows.filter((a) => a.is_alarm && !a.read_at).length : 0;
  const state = useMemo<AlertsState>(() => ({ alerts: alerts.rows, unread, unreadAlarms, loading: alerts.loading, error: alerts.error, pendingApprovals: pending, reload }), [alerts, unread, unreadAlarms, pending, reload]);

  const all = destinationsFor(can);
  const tabs = tabsFor(can);
  const more = all.filter((d) => !tabs.includes(d));
  // People who receive alarms see the count of unread alarms on Home; everyone else, their unread alerts.
  const homeCount = me.receives_alarms ? unreadAlarms : unread;
  const homeWord = me.receives_alarms ? "unread alarms" : "unread alerts";
  const badgeOf = (d: Destination) => (d.badge === "alerts" ? homeCount : d.badge === "approvals" ? pending : 0);
  const badgeWord = (d: Destination) => (d.badge === "alerts" ? homeWord : "waiting for a decision");
  const bellTo = me.receives_alarms && unreadAlarms > 0 ? "/#alarms" : "/#alerts";
  const moreActive = more.some((d) => isActive(d.to, path)) || path.startsWith("/account");
  const product = productName(me.app_name);

  return (
    <AlertsContext.Provider value={state}>
      <div className="shell">
        <a href="#main" className="skip-link">
          Skip to content
        </a>

        {/* Wide screens: sidebar with every destination. */}
        <aside className="sidebar">
          <div className="brand">
            <img src="/brand/wordmark-light.png" alt={product} className="brand-wordmark" />
            <span className="brand-dealer">{me.tenant.name}</span>
            <span className="brand-oem">{me.tenant.oem}</span>
          </div>
          <nav aria-label="Main">
            <ul className="nav">
              {all.map((d) => (
                <li key={d.to}>
                  <Link to={d.to} className={`nav-link${isActive(d.to, path) ? " nav-active" : ""}`} aria-current={isActive(d.to, path) ? "page" : undefined}>
                    <Icon name={d.icon} />
                    <span className="nav-label">{d.label}</span>
                    {badgeOf(d) > 0 && (
                      <span className={`nav-badge${d.badge === "alerts" && me.receives_alarms ? " nav-badge-alarm" : ""}`}>
                        {countText(badgeOf(d))}
                        <span className="sr-only"> {badgeWord(d)}</span>
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          {/* Who makes it, in JBR Consulting's own logo rather than words set in the page's type. */}
          <div className="sidebar-foot">
            <span className="sidebar-foot-label">A product by</span>
            <img src="/brand/jbr-light.png" alt="JBR Consulting" />
          </div>
        </aside>

        <div className="content">
          <header className="topbar">
            {/* The mark as drawn on the white bar of a wide screen, and the light version on the navy bar of a phone. */}
            <img src="/brand/mark.png" alt="" className="topbar-mark topbar-mark-dark" />
            <img src="/brand/mark-light.png" alt="" className="topbar-mark topbar-mark-light" />
            <div className="topbar-tenant">
              <span className="tenant-name">{me.tenant.name}</span>
              <span className="tenant-oem">{me.tenant.oem}</span>
            </div>
            <Link to={bellTo} className="topbar-alerts" aria-label={homeCount ? `${me.receives_alarms ? "Alarms" : "Alerts"}: ${homeCount} unread` : "Alerts"}>
              <Icon name="bell" size={22} />
              {homeCount > 0 && <span className={`nav-badge${me.receives_alarms ? " nav-badge-alarm" : ""}`}>{countText(homeCount)}</span>}
            </Link>
            <div className="topbar-user">
              <div className="user-id">
                <span className="user-name">{personName(me.user.name)}</span>
                <span className="user-role">{roleLabel(me.user.role)}</span>
              </div>
              <Link to="/account/password" className="user-link">
                <Icon name="key" size={16} />
                Change password
              </Link>
              <button type="button" className="user-link" onClick={() => void signOut()}>
                <Icon name="logout" size={16} />
                Sign out
              </button>
            </div>
          </header>
          <StatusBars />
          <main id="main" className="main" tabIndex={-1}>
            <Routes />
          </main>
        </div>

        {/* Phones: the main destinations as tabs at the bottom, everything else under "More". */}
        <nav className="tabbar" aria-label="Main">
          {tabs.map((d) => {
            const active = isActive(d.to, path);
            return (
              <Link key={d.to} to={d.to} className={`tabbar-item${active ? " tabbar-active" : ""}`} aria-current={active ? "page" : undefined}>
                <span className="tabbar-icon">
                  <Icon name={d.icon} size={22} />
                  {d.badge === "approvals" && pending > 0 && (
                    <span className="nav-badge">
                      {countText(pending)}
                      <span className="sr-only"> {badgeWord(d)}</span>
                    </span>
                  )}
                  {d.badge === "alerts" && me.receives_alarms && unreadAlarms > 0 && (
                    <span className="nav-badge nav-badge-alarm">
                      {countText(unreadAlarms)}
                      <span className="sr-only"> {homeWord}</span>
                    </span>
                  )}
                </span>
                <span className="tabbar-label">{d.label}</span>
              </Link>
            );
          })}
          <button type="button" className={`tabbar-item${moreActive ? " tabbar-active" : ""}`} aria-haspopup="dialog" aria-expanded={moreOpen} onClick={() => setMoreOpen(true)}>
            <span className="tabbar-icon">
              <Icon name="more" size={22} />
            </span>
            <span className="tabbar-label">More</span>
          </button>
        </nav>

        {moreOpen && (
          <Dialog
            title="More"
            full
            onClose={() => setMoreOpen(false)}
            footer={
              <Button onClick={() => setMoreOpen(false)} data-autofocus="">
                Close
              </Button>
            }
          >
            <div className="more-user">
              <span className="user-name">{personName(me.user.name)}</span>
              <span className="user-role">
                {roleLabel(me.user.role)} · {me.tenant.name}
              </span>
            </div>
            <ul className="more-list">
              {more.map((d) => (
                <li key={d.to}>
                  <Link to={d.to} className={`more-item${isActive(d.to, path) ? " more-active" : ""}`} aria-current={isActive(d.to, path) ? "page" : undefined} onClick={() => setMoreOpen(false)}>
                    <Icon name={d.icon} size={22} />
                    <span className="more-label">{d.label}</span>
                    {badgeOf(d) > 0 && (
                      <span className="nav-badge">
                        {countText(badgeOf(d))}
                        <span className="sr-only"> {badgeWord(d)}</span>
                      </span>
                    )}
                    <Icon name="chevron" size={18} />
                  </Link>
                </li>
              ))}
            </ul>
            <ul className="more-list more-account">
              <li>
                <Link to="/account/password" className={`more-item${path.startsWith("/account") ? " more-active" : ""}`} onClick={() => setMoreOpen(false)}>
                  <Icon name="key" size={22} />
                  <span className="more-label">Change password</span>
                  <Icon name="chevron" size={18} />
                </Link>
              </li>
              <li>
                <button type="button" className="more-item" onClick={() => void signOut()}>
                  <Icon name="logout" size={22} />
                  <span className="more-label">Sign out</span>
                </button>
              </li>
            </ul>
            <p className="more-product">
              <img src="/brand/wordmark.png" alt={product} className="more-wordmark" />
              <img src="/brand/lockup.png" alt="A product by JBR Consulting" className="more-lockup" />
            </p>
          </Dialog>
        )}
      </div>
    </AlertsContext.Provider>
  );
}
