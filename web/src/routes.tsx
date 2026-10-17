// Which screen answers which address. A new screen is one entry here (and one in nav.ts if it has a
// place in the menus). Patterns are matched in order; ":name" captures a path segment.

import { useEffect, type ReactNode } from "react";
import { Empty, PageHeader } from "./components/ui";
import { canApprove, canLoadFiles, canSeePayments, type Can } from "./nav";
import { AnalyticsPage } from "./pages/Analytics";
import { AdminPage } from "./pages/Admin";
import { ApprovalsPage } from "./pages/Approvals";
import { AuditPage } from "./pages/Audit";
import { BookingDetailPage } from "./pages/BookingDetail";
import { BookingFormPage } from "./pages/BookingForm";
import { BookingsPage } from "./pages/Bookings";
import { BoardPage } from "./pages/Board";
import { DashboardsPage } from "./pages/Dashboards";
import { EodPage } from "./pages/Eod";
import { HomePage } from "./pages/Home";
import { ChangePasswordForm } from "./pages/Login";
import { MasterPage } from "./pages/Master";
import { OwnerPage } from "./pages/Owner";
import { PaymentsPage } from "./pages/Payments";
import { ReconDetailPage, ReconPage } from "./pages/Recon";
import { TakeCarBackPage } from "./pages/TakeCarBack";
import { StockPage } from "./pages/Stock";
import { VehicleDetailPage } from "./pages/VehicleDetail";
import { WhatsAppPage } from "./pages/WhatsApp";
import { Link, matchPath, useRouter } from "./router";
import { useSession } from "./session";

interface Route {
  path: string;
  /** Who may open it; everyone signed in when left out. */
  allowed?: (can: Can) => boolean;
  render: (params: Record<string, string>, can: Can) => ReactNode;
}

const canAdmin = (can: Can) => can("admin.users") || can("admin.settings");
const canEod = (can: Can) => canLoadFiles(can) || can("recon.view");
const waTab = (tab: string) => (["messages", "test", "log", "replies"].includes(tab) ? (tab as "messages" | "test" | "log" | "replies") : null);

const ROUTES: Route[] = [
  { path: "/", render: () => <HomePage /> },
  {
    path: "/account/password",
    render: () => (
      <>
        <PageHeader title="Change password" subtitle="You will stay signed in on this device. Other devices are signed out." />
        <div className="narrow">
          <ChangePasswordForm />
        </div>
      </>
    ),
  },

  { path: "/stock", allowed: (can) => can("stock.view"), render: () => <StockPage tab="summary" /> },
  { path: "/stock/check", allowed: (can) => can("stock.view"), render: () => <StockPage tab="check" /> },
  { path: "/stock/browse", allowed: (can) => can("stock.view"), render: () => <StockPage tab="browse" /> },
  { path: "/stock/cars", allowed: (can) => can("stock.view"), render: () => <StockPage tab="cars" /> },
  { path: "/stock/cars/:id", allowed: (can) => can("stock.view"), render: (p) => <VehicleDetailPage key={p.id} id={p.id} /> },

  { path: "/bookings", allowed: (can) => can("booking.view"), render: () => <BookingsPage /> },
  { path: "/bookings/new", allowed: (can) => can("booking.create"), render: () => <BookingFormPage key="new" /> },
  { path: "/bookings/:id/edit", allowed: (can) => can("booking.create"), render: (p) => <BookingFormPage key={p.id} id={p.id} /> },
  { path: "/bookings/:id", allowed: (can) => can("booking.view"), render: (p) => <BookingDetailPage key={p.id} id={p.id} /> },

  { path: "/approvals", allowed: canApprove, render: () => <ApprovalsPage /> },
  { path: "/take-car-back", allowed: (can) => can("exception.request"), render: () => <TakeCarBackPage /> },

  { path: "/payments", allowed: canSeePayments, render: () => <PaymentsPage /> },

  { path: "/owner", allowed: (can) => can("owner.view"), render: () => <OwnerPage tab="overview" /> },
  { path: "/owner/out-of-turn", allowed: (can) => can("owner.view"), render: () => <OwnerPage tab="out-of-turn" /> },
  { path: "/owner/measures", allowed: (can) => can("owner.view"), render: () => <OwnerPage tab="measures" /> },

  { path: "/board", allowed: (can) => can("dashboards.view") && can("booking.view_all"), render: () => <BoardPage /> },
  { path: "/dashboards", allowed: (can) => can("dashboards.view"), render: () => <DashboardsPage tab="allocation" /> },
  { path: "/dashboards/allocation", allowed: (can) => can("dashboards.view"), render: () => <DashboardsPage tab="allocation" /> },
  { path: "/dashboards/orders", allowed: (can) => can("dashboards.view"), render: () => <DashboardsPage tab="orders" /> },
  { path: "/dashboards/delayed", allowed: (can) => can("dashboards.view"), render: () => <DashboardsPage tab="delayed" /> },
  { path: "/dashboards/offers", allowed: (can) => can("dashboards.view"), render: () => <DashboardsPage tab="offers" /> },

  { path: "/analytics", allowed: (can) => can("dashboards.view"), render: () => <AnalyticsPage tab="ageing" /> },
  { path: "/analytics/ageing", allowed: (can) => can("dashboards.view"), render: () => <AnalyticsPage tab="ageing" /> },
  { path: "/analytics/not-picked-up", allowed: (can) => can("booking.view_all"), render: () => <AnalyticsPage tab="not-picked-up" /> },
  { path: "/analytics/sales", allowed: (can) => can("dashboards.view"), render: () => <AnalyticsPage tab="sales" /> },
  { path: "/analytics/allocations", allowed: (can) => can("dashboards.view"), render: () => <AnalyticsPage tab="allocations" /> },
  { path: "/analytics/stock-days", allowed: (can) => can("stock.view"), render: () => <AnalyticsPage tab="stock-days" /> },
  { path: "/eod", allowed: canEod, render: () => <EodPage /> },
  // The earlier "Data upload" address still works.
  { path: "/uploads", allowed: canEod, render: () => <Redirect to="/eod" /> },

  { path: "/recon", allowed: (can) => can("recon.view"), render: () => <ReconPage /> },
  { path: "/recon/:id", allowed: (can) => can("recon.view"), render: (p) => <ReconDetailPage key={p.id} id={p.id} /> },

  { path: "/master", allowed: (can) => can("master.manage"), render: () => <MasterPage tab="variants" /> },
  { path: "/master/colours", allowed: (can) => can("master.manage"), render: () => <MasterPage tab="colours" /> },

  { path: "/whatsapp", allowed: (can) => can("wa.view"), render: () => <WhatsAppPage tab="connection" /> },
  { path: "/whatsapp/:tab", allowed: (can) => can("wa.view"), render: (p) => (waTab(p.tab) ? <WhatsAppPage tab={waTab(p.tab)!} /> : <NotFound />) },

  { path: "/admin", allowed: canAdmin, render: (_p, can) => <AdminPage tab={can("admin.users") ? "users" : "rules"} /> },
  { path: "/admin/users", allowed: (can) => can("admin.users"), render: () => <AdminPage tab="users" /> },
  { path: "/admin/roles", allowed: canAdmin, render: () => <AdminPage tab="roles" /> },
  { path: "/admin/outlets", allowed: (can) => can("admin.users"), render: () => <AdminPage tab="outlets" /> },
  { path: "/admin/rules", allowed: (can) => can("admin.settings"), render: () => <AdminPage tab="rules" /> },

  { path: "/audit", allowed: (can) => can("audit.view"), render: () => <AuditPage /> },
];

function Redirect({ to }: { to: string }) {
  const { navigate } = useRouter();
  useEffect(() => navigate(to, { replace: true }), [navigate, to]);
  return null;
}

function NoAccess() {
  return (
    <>
      <PageHeader title="Not available" />
      <Empty
        title="Your role does not include this screen."
        hint="Ask your administrator if you need access."
        action={
          <Link to="/" className="btn btn-secondary">
            Back to Home
          </Link>
        }
      />
    </>
  );
}

function NotFound() {
  return (
    <>
      <PageHeader title="Page not found" />
      <Empty
        title="There is nothing at this address."
        action={
          <Link to="/" className="btn btn-secondary">
            Back to Home
          </Link>
        }
      />
    </>
  );
}

export function Routes(): ReactNode {
  const { path } = useRouter();
  const { can } = useSession();
  for (const route of ROUTES) {
    const params = matchPath(route.path, path);
    if (!params) continue;
    if (route.allowed && !route.allowed(can)) return <NoAccess />;
    return route.render(params, can);
  }
  return <NotFound />;
}
