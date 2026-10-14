// The platform console at /platform: the deployment's own administrator ("super admin"). It has its own
// sign-in and shows only what belongs to the deployment — which dealerships exist, how big each one is,
// and what has been done here. No dealership's customers, bookings or stock are reachable from it.
import { useCallback, useEffect, useState } from "react";
import { ApiError, errorMessage } from "../api";
import { BrandFoot } from "../components/Brand";
import { Dialog } from "../components/Dialog";
import { Button, Card, Chip, type Column, DataTable, Empty, Field, Notice, PasswordInput, Stat } from "../components/ui";
import { fmtDateTime, fmtNumber } from "../format";
import { PRODUCT } from "../product";

interface Admin { id: string; name: string; mobile: string; must_change_password: boolean }
interface Tenant { id: string; slug: string; name: string; oem: string; timezone: string; is_active: boolean; created_at: string; outlets: number; users: number; cars_in_stock: number; open_bookings: number; last_file_at: string | null }
interface AuditRow { id: string; actor: string; actor_name: string | null; action: string; entity: string | null; detail: Record<string, unknown>; at: string }

async function call<R>(method: string, path: string, body?: unknown): Promise<R> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? "ERROR", json?.error?.message ?? `Request failed (${res.status})`);
  return json as R;
}

const ACTIONS: Record<string, string> = {
  PLATFORM_ADMIN_CREATED: "Platform administrator created",
  PLATFORM_ADMIN_PASSWORD_SET: "Platform password set by the deployment",
  PLATFORM_PASSWORD_CHANGED: "Platform password changed",
  TENANT_CREATED: "Dealership created",
  TENANT_ACTIVATED: "Dealership switched on",
  TENANT_DEACTIVATED: "Dealership switched off",
  TENANT_ADMIN_PASSWORD_RESET: "Dealership administrator given a new password",
};

export function PlatformConsole() {
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [phase, setPhase] = useState<"loading" | "anon" | "ready">("loading");
  const load = useCallback(async () => {
    try {
      setAdmin(await call<Admin>("GET", "/api/platform/me"));
      setPhase("ready");
    } catch {
      setAdmin(null);
      setPhase("anon");
    }
  }, []);
  useEffect(() => void load(), [load]);

  if (phase === "loading") return <div className="auth" />;
  if (phase === "anon" || !admin) return <SignIn onSignedIn={load} />;
  if (admin.must_change_password) return <ChangePassword onDone={load} />;
  return <Console admin={admin} onSignedOut={load} />;
}

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="auth">
      <div className="auth-middle">
        {/* One card, as on the dealership's own sign-in. */}
        <div className="auth-panel">
          <img src="/brand/wordmark.png" alt={PRODUCT} className="auth-lockup" />
          <h1 className="auth-title">{title}</h1>
          {children}
        </div>
      </div>
      <BrandFoot />
    </div>
  );
}

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [mobile, setMobile] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call("POST", "/api/platform/login", { mobile, password });
      onSignedIn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Frame title="Sign in">
      <form onSubmit={submit} className="form-grid">
        <Field label="Mobile number" hint="The platform administrator's number, as set on the deployment.">
          <input type="tel" inputMode="tel" autoComplete="username" value={mobile} onChange={(e) => setMobile(e.target.value)} required />
        </Field>
        <Field label="Password">
          <PasswordInput label="Password" value={password} onChange={setPassword} autoComplete="current-password" required />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
        <Button type="submit" variant="primary" busy={busy}>Sign in</Button>
        <p className="muted">This is not a dealership sign-in: the people who work at a dealership sign in on the main screen.</p>
      </form>
    </Frame>
  );
}

function ChangePassword({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call("POST", "/api/platform/change-password", { current, next });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Frame title="Set a new password">
      <form onSubmit={submit} className="form-grid">
        <Field label="Current password">
          <PasswordInput label="Current password" value={current} onChange={setCurrent} autoComplete="current-password" required />
        </Field>
        <Field label="New password" hint="At least 10 characters, with a letter and a number.">
          <PasswordInput label="New password" value={next} onChange={setNext} autoComplete="new-password" required />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
        <Button type="submit" variant="primary" busy={busy}>Save</Button>
      </form>
    </Frame>
  );
}

function Console({ admin, onSignedOut }: { admin: Admin; onSignedOut: () => void }) {
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [audit, setAudit] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [password, setPassword] = useState<{ dealer: string; name: string; mobile: string; temporary_password: string } | null>(null);
  const refresh = useCallback(async () => {
    try {
      setTenants(await call<Tenant[]>("GET", "/api/platform/tenants"));
      setAudit(await call<AuditRow[]>("GET", "/api/platform/audit"));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const columns: Column<Tenant>[] = [
    { header: "Dealership", primary: true, cell: (t) => (<><span className="strong">{t.name}</span><span className="sub">{t.oem} · dealer code {t.slug}</span></>) },
    { header: "Outlets", num: true, cell: (t) => t.outlets },
    { header: "People", num: true, cell: (t) => t.users },
    { header: "Cars in stock", num: true, cell: (t) => fmtNumber(t.cars_in_stock) },
    { header: "Open bookings", num: true, cell: (t) => fmtNumber(t.open_bookings) },
    { header: "Last DMS file", cell: (t) => (t.last_file_at ? fmtDateTime(t.last_file_at) : <span className="muted">None yet</span>) },
    { header: "State", status: true, cell: (t) => (t.is_active ? <Chip tone="green">Active</Chip> : <Chip tone="red">Switched off</Chip>) },
    {
      header: "Actions",
      actions: true,
      cell: (t) => (
        <>
          <Button size="sm" onClick={() => act(async () => setPassword(await call("POST", `/api/platform/tenants/${t.slug}/admin-password`, {})))}>Reset admin</Button>
          <Button size="sm" onClick={() => act(() => call("PATCH", `/api/platform/tenants/${t.slug}`, { is_active: !t.is_active }))}>{t.is_active ? "Switch off" : "Switch on"}</Button>
        </>
      ),
    },
  ];

  return (
    <div className="platform">
      <header className="platform-bar">
        <img src="/brand/wordmark.png" alt={PRODUCT} className="platform-wordmark" />
        <div className="platform-who">
          <span className="strong">{admin.name}</span>
          <span className="sub">Platform console</span>
        </div>
        <Button size="sm" onClick={() => act(async () => { await call("POST", "/api/platform/logout"); onSignedOut(); })}>Sign out</Button>
      </header>
      <main className="platform-main">
        {error && <Notice tone="error">{error}</Notice>}
        <div className="tiles">
          <Stat label="Dealerships" value={fmtNumber(tenants?.length ?? 0)} />
          <Stat label="Active" value={fmtNumber((tenants ?? []).filter((t) => t.is_active).length)} />
          <Stat label="Cars in stock" value={fmtNumber((tenants ?? []).reduce((n, t) => n + t.cars_in_stock, 0))} />
          <Stat label="Open bookings" value={fmtNumber((tenants ?? []).reduce((n, t) => n + t.open_bookings, 0))} />
        </div>
        <Card title="Dealerships on this deployment" actions={<Button variant="primary" size="sm" onClick={() => setAdding(true)}>Add a dealership</Button>} flush>
          {tenants?.length ? <DataTable columns={columns} rows={tenants} rowKey={(t) => t.id} caption="Dealerships" /> : <Empty title="No dealership yet" hint="Add the first one; its administrator then signs in on the main screen." />}
        </Card>
        <Card title="What has been done here" flush>
          {audit?.length ? (
            <DataTable
              columns={[
                { header: "When", primary: true, cell: (r) => fmtDateTime(r.at) },
                { header: "What", cell: (r) => ACTIONS[r.action] ?? r.action },
                { header: "Dealership", cell: (r) => (r.detail?.slug as string) ?? <span className="muted">–</span> },
                { header: "By", cell: (r) => r.actor_name ?? r.actor },
              ]}
              rows={audit}
              rowKey={(r) => r.id}
              caption="Platform audit trail"
            />
          ) : (
            <Empty title="Nothing yet" />
          )}
        </Card>
      </main>

      {adding && <AddDealership onClose={() => setAdding(false)} onDone={async (made) => { setAdding(false); setPassword(made); await refresh(); }} />}
      {password && (
        <Dialog title="Temporary password" onClose={() => setPassword(null)}>
          <p>
            {password.name} ({password.mobile}) at <span className="strong">{password.dealer}</span> can sign in on the main screen with this password and must replace it at once.
          </p>
          <p className="mono strong one-time-password">{password.temporary_password}</p>
          <Notice tone="warn">It is shown here this once. Pass it on by a means you trust; it cannot be read again.</Notice>
          <Button variant="primary" onClick={() => setPassword(null)}>Done</Button>
        </Dialog>
      )}
    </div>
  );
}

function AddDealership({ onClose, onDone }: { onClose: () => void; onDone: (made: { dealer: string; name: string; mobile: string; temporary_password: string }) => void }) {
  const [form, setForm] = useState({ slug: "", name: "", oem: "Mahindra", admin_name: "", admin_mobile: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call("POST", "/api/platform/tenants", { slug: form.slug.trim().toLowerCase(), name: form.name.trim(), oem: form.oem.trim(), admin: { name: form.admin_name.trim(), mobile: form.admin_mobile.trim(), password: form.password } });
      onDone({ dealer: form.slug.trim().toLowerCase(), name: form.admin_name.trim(), mobile: form.admin_mobile.trim(), temporary_password: form.password });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Add a dealership" onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <Field label="Dealership name">
          <input value={form.name} onChange={set("name")} required />
        </Field>
        <Field label="Dealer code" hint="Lowercase letters, digits and hyphens. Only needed at sign-in when a mobile number is used at two dealerships.">
          <input value={form.slug} onChange={set("slug")} required />
        </Field>
        <Field label="Manufacturer" hint="The DMS file layout follows this. Mahindra is the layout this version reads.">
          <input value={form.oem} onChange={set("oem")} required />
        </Field>
        <Field label="System Admin: name">
          <input value={form.admin_name} onChange={set("admin_name")} required />
        </Field>
        <Field label="System Admin: mobile number">
          <input type="tel" inputMode="tel" value={form.admin_mobile} onChange={set("admin_mobile")} required />
        </Field>
        <Field label="First password" hint="At least 8 characters with a letter and a number. They must replace it at first sign-in.">
          <PasswordInput label="First password" value={form.password} onChange={(v) => set("password")({ target: { value: v } } as any)} autoComplete="new-password" required />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
        <Button type="submit" variant="primary" busy={busy}>Create the dealership</Button>
      </form>
    </Dialog>
  );
}
