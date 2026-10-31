import { useRef, useState } from "react";
import { api } from "../api";
import { ConfirmDialog, Dialog } from "../components/Dialog";
import { Icon } from "../components/icons";
import { Async, Button, Card, Check, Chip, CopyField, DataTable, Disclosure, Empty, Field, Notice, PageHeader, RadioGroup, Select, Tabs, type Column } from "../components/ui";
import { fmtMobile, fmtNumber, plural } from "../format";
import { useAction, useLoad } from "../hooks";
import { plainText } from "../labels";
import { useSession } from "../session";
import { SystemTab } from "./Insights";
import type { EmployeeImportResult, Outlet, Role, RoleInfo, RolesResponse, UserInput, UserRow } from "../types";
import { RulesTab } from "./AdminRules";

type Tab = "outlets" | "users" | "roles" | "rules" | "health";

export function AdminPage({ tab }: { tab: Tab }) {
  const { can } = useSession();
  const tabs = [
    ...(can("admin.users") ? [{ to: "/admin/users", label: "Users" }] : []),
    { to: "/admin/roles", label: "Roles and controls" },
    ...(can("admin.users") ? [{ to: "/admin/outlets", label: "Outlets" }] : []),
    ...(can("admin.settings") ? [{ to: "/admin/rules", label: "Rules and settings" }] : []),
    ...(can("admin.settings") ? [{ to: "/admin/health", label: "System health (new)" }] : []),
  ];
  return (
    <>
      <PageHeader title="Settings" subtitle="The people who use VINeeti here, the outlets, and the rules the system follows." />
      <Tabs current={`/admin/${tab}`} tabs={tabs} />
      {tab === "outlets" && <OutletsTab />}
      {tab === "users" && <UsersTab />}
      {tab === "roles" && <RolesTab />}
      {tab === "rules" && <RulesTab />}
      {tab === "health" && <SystemTab />}
    </>
  );
}

// ---------------------------------------------------------------- outlets
function OutletsTab() {
  const { refresh } = useSession();
  const load = useLoad(() => api.outlets(), "admin:outlets");
  const action = useAction();
  const [dialog, setDialog] = useState<{ outlet?: Outlet } | null>(null);
  const [toggling, setToggling] = useState<Outlet | null>(null);
  const reload = async () => {
    await Promise.all([load.reload(), refresh()]);
  };

  const columns: Column<Outlet>[] = [
    { header: "Outlet", primary: true, cell: (o) => <span className="strong">{o.name}</span> },
    { header: "Code", cell: (o) => <span className="mono">{o.code}</span> },
    { header: "City", cell: (o) => o.city ?? <span className="muted">—</span>, hideIfEmpty: (o) => !o.city },
    { header: "Address", cell: (o) => o.address ?? <span className="muted">—</span>, hideIfEmpty: (o) => !o.address },
    { header: "Status", status: true, cell: (o) => (o.is_active ? <Chip tone="green">Active</Chip> : <Chip tone="grey">Inactive</Chip>) },
    {
      header: "Actions",
      actions: true,
      cell: (o) => (
        <span className="row-actions">
          <Button size="sm" onClick={() => setDialog({ outlet: o })}>
            Edit
          </Button>
          <Button size="sm" variant={o.is_active ? "danger" : "secondary"} onClick={() => setToggling(o)}>
            {o.is_active ? "Deactivate" : "Reactivate"}
          </Button>
        </span>
      ),
    },
  ];

  return (
    <>
      <Card
        title="Outlets"
        note="Showrooms and stockyards of the dealership. Outlets are also created automatically from the DMS files, by their Dealer Location Code."
        actions={
          <Button variant="primary" icon="plus" onClick={() => setDialog({})}>
            Add outlet
          </Button>
        }
        flush
      >
        <Async load={load} empty={<Empty title="No outlets yet" />}>
          {(rows) => <DataTable columns={columns} rows={rows} rowKey={(o) => o.id} caption="Outlets" />}
        </Async>
      </Card>
      {dialog && (
        <OutletDialog
          outlet={dialog.outlet}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void reload();
          }}
        />
      )}
      {toggling && (
        <ConfirmDialog
          title={toggling.is_active ? `Deactivate ${toggling.name}?` : `Reactivate ${toggling.name}?`}
          message={toggling.is_active ? "New bookings and transfers can no longer use this outlet. Existing cars and bookings stay where they are." : "The outlet becomes available again for bookings and transfers."}
          confirmLabel={toggling.is_active ? "Deactivate outlet" : "Reactivate outlet"}
          danger={Boolean(toggling.is_active)}
          busy={action.busy}
          error={action.error}
          onCancel={() => {
            action.clearError();
            setToggling(null);
          }}
          onConfirm={async () => {
            const res = await action.run(() => api.updateOutlet(toggling.id, { is_active: !toggling.is_active }), { quiet: true, success: `${toggling.name} ${toggling.is_active ? "deactivated" : "reactivated"}.` });
            if (res) {
              setToggling(null);
              await reload();
            }
          }}
        />
      )}
    </>
  );
}

function OutletDialog({ outlet, onClose, onDone }: { outlet?: Outlet; onClose: () => void; onDone: () => void }) {
  const action = useAction();
  const [code, setCode] = useState(outlet?.code ?? "");
  const [name, setName] = useState(outlet?.name ?? "");
  const [city, setCity] = useState(outlet?.city ?? "");
  const [address, setAddress] = useState(outlet?.address ?? "");
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim() || (!outlet && !code.trim())) return setProblem("Enter the outlet's code and name.");
    setProblem(null);
    const res = outlet
      ? await action.run(() => api.updateOutlet(outlet.id, { name: name.trim(), city: city.trim(), address: address.trim() }), { quiet: true, success: "Outlet saved." })
      : await action.run(() => api.createOutlet({ code: code.trim(), name: name.trim(), city: city.trim() || undefined, address: address.trim() || undefined }), { quiet: true, success: `Outlet ${name.trim()} added.` });
    if (res) onDone();
  };

  return (
    <Dialog
      title={outlet ? `Edit ${outlet.name}` : "Add an outlet"}
      onClose={() => !action.busy && onClose()}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button onClick={onClose} disabled={action.busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={action.busy}>
            {outlet ? "Save" : "Add outlet"}
          </Button>
        </>
      }
    >
      <div className="form-stack">
        {outlet ? (
          <p>
            <span className="muted">Code: </span>
            <span className="mono">{outlet.code}</span> <span className="hint">The code cannot be changed, because the DMS files refer to it.</span>
          </p>
        ) : (
          <Field label="Outlet code" hint="The Dealer Location Code the DMS files use for this outlet.">
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} className="mono" autoComplete="off" maxLength={20} />
          </Field>
        )}
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={80} />
        </Field>
        <Field label="City" optional>
          <input value={city} onChange={(e) => setCity(e.target.value)} autoComplete="off" maxLength={80} />
        </Field>
        <Field label="Address" optional hint="Read out to a customer who has to collect a car from this branch." wide>
          <textarea value={address} onChange={(e) => setAddress(e.target.value)} rows={2} maxLength={300} />
        </Field>
        {(problem || action.error) && <Notice tone="error">{problem ?? plainText(action.error)}</Notice>}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- users
function UsersTab() {
  const { me, roleLabel, outletName } = useSession();
  const users = useLoad(() => api.users(), "admin:users");
  const outlets = useLoad(() => api.outlets(), "admin:outlets");
  const roles = useLoad(() => api.roles(), "admin:roles");
  const [dialog, setDialog] = useState<{ user?: UserRow } | null>(null);
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const [removing, setRemoving] = useState<UserRow | null>(null);

  const columns: Column<UserRow>[] = [
    {
      header: "Name",
      primary: true,
      cell: (u) => (
        <>
          <span className="strong">{u.name}</span>
          {u.id === me.user.id && <span className="sub">This is you</span>}
        </>
      ),
    },
    { header: "Status", status: true, cell: (u) => (u.is_active ? <Chip tone="green">Active</Chip> : <Chip tone="grey">Inactive</Chip>) },
    { header: "Mobile (sign-in ID)", cell: (u) => fmtMobile(u.mobile) },
    { header: "Role", cell: (u) => roleLabel(u.role) },
    { header: "Outlets", cell: (u) => (u.all_outlets ? "All outlets" : u.outlet_ids.length ? u.outlet_ids.map((id) => outletName(id)).join(", ") : <span className="danger">None chosen</span>) },
    { header: "Segments", hideIfEmpty: (u) => !u.segments?.length, cell: (u) => (u.segments?.length ? u.segments.map((k) => me.segments.find((s) => s.key === k)?.short ?? k).join(", ") : <span className="muted">All</span>) },
    { header: "DMS ID", hideIfEmpty: (u) => !u.dms_code, cell: (u) => (u.dms_code ? <span className="mono">{u.dms_code}</span> : <span className="muted">—</span>) },
    {
      header: "Password",
      hideIfEmpty: (u) => !(u.is_active && u.must_change_password),
      cell: (u) => (u.is_active && u.must_change_password ? <Chip tone="amber">Temporary, to be replaced</Chip> : <span className="muted">Set</span>),
    },
    {
      header: "Actions",
      actions: true,
      cell: (u) => (
        <span className="row-actions">
          <Button size="sm" onClick={() => setDialog({ user: u })}>
            Edit
          </Button>
          {u.id !== me.user.id && (
            <>
              <Button size="sm" onClick={() => setResetting(u)}>
                Reset password
              </Button>
              <Button size="sm" variant="danger" onClick={() => setRemoving(u)}>
                Remove
              </Button>
            </>
          )}
        </span>
      ),
    },
  ];

  return (
    <>
      <Card
        title="Users"
        note="A person's mobile number is their ID: they sign in with it and a password."
        actions={
          <Button variant="primary" icon="plus" onClick={() => setDialog({})}>
            Add user
          </Button>
        }
        flush
      >
        <Async load={users} empty={<Empty title="No users yet" />}>
          {(rows) => (
            <>
              <p className="list-count">{plural(rows.length, "user")}</p>
              <DataTable columns={columns} rows={rows} rowKey={(u) => u.id} caption="Users" />
            </>
          )}
        </Async>
      </Card>
      <EmployeeSheetCard onLoaded={() => void users.reload()} />
      {dialog && (
        <UserDialog
          user={dialog.user}
          roles={roles.data?.roles ?? []}
          outlets={(outlets.data ?? []).filter((o) => o.is_active || dialog.user?.outlet_ids.includes(o.id))}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void users.reload();
          }}
        />
      )}
      {resetting && (
        <ResetPasswordDialog
          user={resetting}
          onClose={() => {
            setResetting(null);
            void users.reload();
          }}
        />
      )}
      {removing && (
        <RemoveUserDialog
          user={removing}
          onClose={() => setRemoving(null)}
          onDone={() => {
            setRemoving(null);
            void users.reload();
          }}
        />
      )}
    </>
  );
}


function UserDialog({ user, roles, outlets, onClose, onDone }: { user?: UserRow; roles: RoleInfo[]; outlets: Outlet[]; onClose: () => void; onDone: () => void }) {
  const { me, refresh } = useSession();
  const action = useAction();
  // Labels come from the server; the one-line purpose of each role is shown under the picker.
  const roleOptions = roles.length ? roles.map((r) => ({ value: r.role, label: r.label })) : (Object.entries(me.role_labels) as [Role, string][]).map(([value, label]) => ({ value, label }));
  const [name, setName] = useState(user?.name ?? "");
  const [mobile, setMobile] = useState("");
  const [role, setRole] = useState<Role | "">(user?.role ?? "");
  const [scope, setScope] = useState<"all" | "some">(user ? (user.all_outlets ? "all" : "some") : "some");
  const [outletIds, setOutletIds] = useState<string[]>(user?.outlet_ids ?? []);
  const [segmentScope, setSegmentScope] = useState<"all" | "some">(user?.segments?.length ? "some" : "all");
  const [segments, setSegments] = useState<string[]>(user?.segments ?? []);
  const [email, setEmail] = useState(user?.email ?? "");
  const [dmsCode, setDmsCode] = useState(user?.dms_code ?? "");
  const [active, setActive] = useState(user ? Boolean(user.is_active) : true);
  const [problem, setProblem] = useState<string | null>(null);
  // Only ever set on a deployment with no mail account, where the password has to be read out by hand.
  const [made, setMade] = useState<{ name: string; password: string } | null>(null);
  const self = user?.id === me.user.id;
  const info = roles.find((r) => r.role === role);

  const changeRole = (r: string) => {
    setRole(r as Role | "");
    // Roles that look across the dealership default to every outlet, as the server does.
    const wide = roles.find((x) => x.role === r)?.tenant_wide;
    if (!user && r && wide !== undefined) setScope(wide ? "all" : "some");
  };
  const toggleOutlet = (id: string, on: boolean) => setOutletIds((list) => (on ? [...new Set([...list, id])] : list.filter((x) => x !== id)));
  const toggleSegment = (key: string, on: boolean) => setSegments((list) => (on ? [...new Set([...list, key])] : list.filter((x) => x !== key)));

  const submit = async () => {
    if (!name.trim()) return setProblem("Enter the person's name.");
    if (!user && mobile.replace(/\D/g, "").length < 10) return setProblem("Enter a 10-digit mobile number.");
    if (!role) return setProblem("Choose a role.");
    if (!user && !/^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(email.trim())) return setProblem("Enter the person's email address: the temporary password is sent to it.");
    if (scope === "some" && !outletIds.length) return setProblem("Choose at least one outlet, or give access to all outlets.");
    if (segmentScope === "some" && !segments.length) return setProblem("Tick at least one segment, or let the person work with every segment.");
    setProblem(null);
    const body: UserInput = { name: name.trim(), role, all_outlets: scope === "all", outlet_ids: scope === "all" ? [] : outletIds, dms_code: dmsCode.trim() || null, segments: segmentScope === "all" ? [] : segments, email: email.trim() || undefined };
    if (user && !self) body.is_active = active;
    const res = user
      ? await action.run(() => api.updateUser(user.id, body), { quiet: true, success: `${name.trim()} saved.` })
      : await action.run(() => api.createUser({ ...body, dms_code: dmsCode.trim() || undefined, mobile: mobile.trim() }), { quiet: true, success: `${name.trim()} added. The sign-in details are on their way to ${email.trim()}.` });
    // Without a mail account there is nothing in flight and the password has to be passed on by hand.
    if (res && !user && "temporary_password" in res && res.temporary_password) setMade({ name: name.trim(), password: res.temporary_password });
    if (res) {
      if (self) await refresh();
      if (!(res && !user && "temporary_password" in res && res.temporary_password)) onDone();
    }
  };

  if (made)
    return (
      <Dialog
        title={`${made.name} added`}
        onClose={onDone}
        footer={
          <Button variant="primary" onClick={onDone} data-autofocus="">
            Done
          </Button>
        }
      >
        <div className="form-stack">
          <Notice tone="warn" title="Copy the temporary password now. ">
            This deployment has no mail account set up, so nothing could be sent. The password is shown here this once and will not be shown again.
          </Notice>
          <CopyField label="Temporary password" value={made.password} />
          <p className="muted">{made.name} is asked to replace it when they first sign in.</p>
        </div>
      </Dialog>
    );

  return (
    <Dialog
      title={user ? `Edit ${user.name}` : "Add a user"}
      wide
      onClose={() => !action.busy && onClose()}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button onClick={onClose} disabled={action.busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={action.busy}>
            {user ? "Save" : "Add user"}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={80} />
        </Field>
        {user ? (
          <Field label="Mobile number" hint="The mobile number is the person's ID and cannot be changed. Add a new user for a new number.">
            <input value={fmtMobile(user.mobile)} readOnly disabled />
          </Field>
        ) : (
          <Field label="Mobile number" hint="The person's ID: they sign in with this number.">
            <input value={mobile} onChange={(e) => setMobile(e.target.value)} type="tel" inputMode="numeric" autoComplete="off" maxLength={16} />
          </Field>
        )}
        <Field label="Role" hint={self ? "You cannot change your own role." : info?.purpose}>
          <Select value={role} onChange={changeRole} options={roleOptions} placeholder="Choose a role" disabled={self} />
        </Field>
        <Field label="Email address" hint="Where the sign-in details are sent. The person signs in with their mobile number, not this.">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" inputMode="email" />
        </Field>
        <Field label="DMS ID" optional hint="The person's ID in the DMS (SC Mile Id), so their bookings in the booking sheet reach them.">
          <input value={dmsCode} onChange={(e) => setDmsCode(e.target.value.toUpperCase())} autoComplete="off" maxLength={40} className="mono" />
        </Field>
        <div className="field-wide">
          <RadioGroup
            legend="Outlets"
            value={scope}
            onChange={setScope}
            options={[
              { value: "all", label: "All outlets, including ones added later" },
              { value: "some", label: "Only the outlets ticked below" },
            ]}
          />
          {scope === "some" && (
            <fieldset className="check-grid">
              <legend className="sr-only">Outlets this user works in</legend>
              {outlets.length ? (
                outlets.map((o) => (
                  <Check key={o.id} checked={outletIds.includes(o.id)} onChange={(on) => toggleOutlet(o.id, on)}>
                    {o.name}
                    {o.is_active ? "" : " (inactive)"}
                  </Check>
                ))
              ) : (
                <span className="muted">Loading outlets…</span>
              )}
            </fieldset>
          )}
        </div>
        {me.segments.length > 0 && (
          <div className="field-wide">
            <RadioGroup
              legend="Vehicle segments"
              value={segmentScope}
              onChange={setSegmentScope}
              options={[
                { value: "all", label: "Every segment" },
                { value: "some", label: "Only the segments ticked below", help: "The person then sees, books and raises requests for cars of those segments only. Approvals are not affected: approvers decide every segment." },
              ]}
            />
            {segmentScope === "some" && (
              <fieldset className="check-grid">
                <legend className="sr-only">Segments this user works with</legend>
                {me.segments.map((sg) => (
                  <Check key={sg.key} checked={segments.includes(sg.key)} onChange={(on) => toggleSegment(sg.key, on)}>
                    {sg.label} ({sg.short})
                  </Check>
                ))}
              </fieldset>
            )}
          </div>
        )}
        {user ? (
          <div className="field-wide">
            <Check checked={active} onChange={setActive} disabled={self} hint={self ? "You cannot switch off your own access." : "When unticked, the person is signed out everywhere and can no longer sign in. Their bookings and history are kept."}>
              Active
            </Check>
          </div>
        ) : (
          <div className="field-wide">
            <p className="muted">The password is made by the system and emailed to {email.trim() || "the address above"}. Nobody here chooses it or needs to see it, and the person is asked to replace it when they first sign in.</p>
          </div>
        )}
      </div>
      {(problem || action.error) && <Notice tone="error">{problem ?? plainText(action.error)}</Notice>}
    </Dialog>
  );
}

/**
 * Removes an account added by mistake. Only one that has done nothing: as soon as there is a booking,
 * a request or a file against the name, the dealership's own record needs it, and the server refuses
 * and says so. That refusal is the normal answer here, not an error to be worked around.
 */
function RemoveUserDialog({ user, onClose, onDone }: { user: UserRow; onClose: () => void; onDone: () => void }) {
  const action = useAction();
  const remove = async () => {
    const res = await action.run(() => api.deleteUser(user.id), { quiet: true, success: `${user.name} removed.` });
    if (res) onDone();
  };
  return (
    <Dialog
      title={`Remove ${user.name}?`}
      onClose={() => !action.busy && onClose()}
      footer={
        <>
          <Button onClick={onClose} disabled={action.busy}>
            Cancel
          </Button>
          <Button variant="danger" busy={action.busy} onClick={() => void remove()} data-autofocus="">
            Remove
          </Button>
        </>
      }
    >
      <div className="form-stack">
        <p className="muted">
          The account and its outlets and segments go for good. This can only be done while {user.name} has no history: if they have raised or approved anything, or uploaded a file, the account is kept and switched off instead so the record still reads
          properly — untick Active on their row to do that.
        </p>
        {action.error && <Notice tone="error">{plainText(action.error)}</Notice>}
      </div>
    </Dialog>
  );
}

/** The server makes a new temporary password and shows it this once. */
function ResetPasswordDialog({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const action = useAction();
  const [password, setPassword] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const reset = async () => {
    const res = await action.run(() => api.resetUserPassword(user.id), { quiet: true, success: `Password reset for ${user.name}.` });
    // Shown either way now: the message goes out after the answer, so whether it arrived is not yet
    // known here, and a password nobody can read is worse than one read off a screen.
    if (res) setPassword(res.temporary_password);
    if (res) setSentTo(res.emailing || res.emailed ? res.email ?? null : null);
    if (res) setDone(true);
  };

  return (
    <Dialog
      title={`Reset password for ${user.name}`}
      onClose={() => !action.busy && onClose()}
      footer={
        done ? (
          <Button variant="primary" onClick={onClose} data-autofocus="">
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose} disabled={action.busy}>
              Cancel
            </Button>
            <Button variant="primary" busy={action.busy} onClick={() => void reset()} data-autofocus="">
              Reset password
            </Button>
          </>
        )
      }
    >
      <div className="form-stack">
        {done ? (
          <>
            {sentTo ? (
              <Notice tone="ok" title="On its way. ">
                The new password is being emailed to {sentTo}. If it cannot be sent you will see an alert; the password below is the same one.
              </Notice>
            ) : (
              <Notice tone="warn" title="Copy the temporary password now. ">
                It could not be emailed, so it is shown here this once and will not be shown again.
              </Notice>
            )}
            {password && <CopyField label="Temporary password" value={password} />}
            <p className="muted">{user.name} is signed out on every device and is asked to replace this password at the next sign-in.</p>
          </>
        ) : (
          <p className="muted">A new temporary password is made and shown here once. {user.name} is signed out on every device and must replace it at the next sign-in. This also unlocks an account locked after wrong attempts.</p>
        )}
        {action.error && <Notice tone="error">{plainText(action.error)}</Notice>}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- the employee sheet
const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Hands the browser a CSV of the people just created, with the temporary password of each. */
function downloadCreated(created: EmployeeImportResult["created"]) {
  const rows = [["Name", "Mobile", "Role", "Outlets", "Temporary password"], ...created.map((c) => [c.name, c.mobile, c.role_label, c.outlets, c.temporary_password])];
  const blob = new Blob([rows.map((r) => r.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "new-users.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function EmployeeSheetCard({ onLoaded }: { onLoaded: () => void }) {
  const action = useAction();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<{ result: EmployeeImportResult; filename: string } | null>(null);

  const submit = async () => {
    if (!file) return;
    const res = await action.run(() => api.importEmployees(file), { quiet: true, success: `${file.name} loaded.` });
    if (res) {
      setResult({ result: res, filename: file.name });
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      onLoaded();
    }
  };
  const r = result?.result;

  return (
    <Card
      title="Load employee sheet"
      note="Add or update many people at once. The sheet to fill in already lists the sales consultants found in the booking sheet. Nobody is removed or switched off by a sheet."
      actions={
        <a className="btn btn-secondary" href={api.employeeTemplateUrl} download>
          <Icon name="download" size={16} />
          <span>Download the sheet to fill in</span>
        </a>
      }
    >
      <form
        className="form-stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="field">
          <span className="field-label">Filled-in sheet</span>
          <input ref={inputRef} type="file" accept=".xlsx,.csv" disabled={action.busy} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <span className="hint">Columns: Name, Mobile, Role, Outlets (codes separated by commas, or ALL), DMS ID, Email.</span>
        </label>
        {action.error && <Notice tone="error">{plainText(action.error)}</Notice>}
        <div className="form-actions">
          <Button type="submit" variant="primary" icon="upload" busy={action.busy} disabled={!file}>
            Load employee sheet
          </Button>
        </div>
      </form>
      {r && (
        <div className="result" aria-live="polite">
          <h3 className="section-title">Result for {result.filename}</h3>
          <p>
            {plural(r.row_count, "row")} read · {fmtNumber(r.created.length)} created · {fmtNumber(r.updated.length)} updated · {fmtNumber(r.unchanged)} unchanged · {plural(r.errors.length, "error")}
          </p>
          {r.created.length > 0 && (
            <>
              {r.created.some((c) => c.temporary_password) ? (
                <>
                  <Notice tone="warn" title="Temporary passwords are shown this once. ">
                    This deployment has no mail account set up, so nothing could be sent. Download the list or copy them now; each person is asked to replace theirs at first sign-in.
                    {r.otp_available ? " People can instead set their own password from the sign-in page with a WhatsApp code." : ""}
                  </Notice>
                  <div className="form-actions">
                    <Button icon="download" onClick={() => downloadCreated(r.created)}>
                      Download this list (CSV)
                    </Button>
                  </div>
                </>
              ) : (
                <Notice tone="ok" title="Everyone is being written to. ">
                  Each person gets their own temporary password by email, so none is shown here. If one cannot be sent you will see an alert, and Reset password on their row sends it again.
                </Notice>
              )}
              <h4 className="result-title">Created ({r.created.length})</h4>
              <div className="boxed-table">
                <DataTable
                  columns={[
                    { header: "Name", primary: true, cell: (c) => <span className="strong">{c.name}</span> },
                    { header: "Mobile", cell: (c) => fmtMobile(c.mobile) },
                    { header: "Role", cell: (c) => c.role_label },
                    { header: "Outlets", cell: (c) => c.outlets },
                    { header: "Temporary password", hideIfEmpty: (c) => !c.temporary_password, cell: (c) => (c.temporary_password ? <span className="mono">{c.temporary_password}</span> : <span className="muted">Emailed</span>) },
                  ]}
                  rows={r.created}
                  rowKey={(c) => c.mobile}
                  caption="People created"
                />
              </div>
            </>
          )}
          {r.updated.length > 0 && (
            <>
              <h4 className="result-title">Updated ({r.updated.length})</h4>
              <ul className="plain-list">
                {r.updated.map((u) => (
                  <li key={u.mobile}>
                    <span className="strong">{u.name}</span> ({fmtMobile(u.mobile)}, {u.role_label}): {u.changes.join("; ")}
                  </li>
                ))}
              </ul>
            </>
          )}
          {r.errors.length > 0 && (
            <Disclosure summary={`Rows with errors (${fmtNumber(r.errors.length)})`} open>
              <ul className="plain-list">
                {r.errors.map((e) => (
                  <li key={`${e.row}:${e.key}`}>
                    Row {e.row}, {e.key}: {plainText(e.message)}
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- roles and controls (read-only)
function RolesTab() {
  const load = useLoad(() => api.roles(), "admin:roles");
  return (
    <Async load={load} isEmpty={() => false}>
      {(d) => <RolesView d={d} />}
    </Async>
  );
}

function RolesView({ d }: { d: RolesResponse }) {
  const permissions = Object.entries(d.permission_labels);
  const label = (role: Role) => d.roles.find((r) => r.role === role)?.label ?? role;
  const names = (list: Role[]) => (list.length ? list.map(label).join(", ") : "Nobody");

  return (
    <>
      <Card title="Approvals and alarms" note="Set under Rules and settings.">
        <dl className="facts">
          <div>
            <dt>Approve bookings</dt>
            <dd>{names(d.booking_approver_roles)}</dd>
          </div>
          <div>
            <dt>Approve exceptions</dt>
            <dd>{names(d.exception_approver_roles)}</dd>
          </div>
          <div>
            <dt>Receive alarms</dt>
            <dd>{names(d.alarm_roles)}</dd>
          </div>
        </dl>
      </Card>
      <Card title="Roles and controls" note="What each role may do. This table cannot be edited. A role acts only within the outlets, and the vehicle segments, it is given." flush>
        {/* Wide screens: one grid, permissions down the side and roles across the top. */}
        <div className="table-scroll only-wide">
          <table className="table matrix">
            <caption className="sr-only">Permissions by role</caption>
            <thead>
              <tr>
                <th scope="col">Control</th>
                {d.roles.map((r) => (
                  <th key={r.role} scope="col" className="matrix-role" title={r.purpose}>
                    {r.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {permissions.map(([key, text]) => (
                <tr key={key}>
                  <th scope="row">{text}</th>
                  {d.roles.map((r) => {
                    const yes = (r.permissions as string[]).includes(key);
                    return (
                      <td key={r.role} className={`matrix-cell${yes ? " matrix-yes" : ""}`}>
                        {yes ? (
                          <>
                            <Icon name="check" size={15} />
                            <span className="sr-only">Yes</span>
                          </>
                        ) : (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="sr-only">No</span>
                          </>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* Phones: one section per role that opens to show what the role may and may not do. */}
        <div className="role-list only-phone">
          {d.roles.map((r) => {
            const allowed = permissions.filter(([key]) => (r.permissions as string[]).includes(key));
            const denied = permissions.filter(([key]) => !(r.permissions as string[]).includes(key));
            return (
              <details key={r.role} className="role-item">
                <summary>
                  <span className="strong">{r.label}</span>
                  <span className="meta">
                    {allowed.length} of {permissions.length}
                  </span>
                  <Icon name="chevron" size={18} />
                </summary>
                <p className="role-purpose">{r.purpose}</p>
                <p className="field-label">May</p>
                <ul className="perm-list">
                  {allowed.map(([key, text]) => (
                    <li key={key}>
                      <Icon name="check" size={15} />
                      {text}
                    </li>
                  ))}
                </ul>
                {denied.length > 0 && (
                  <>
                    <p className="field-label">May not</p>
                    <ul className="perm-list perm-denied">
                      {denied.map(([key, text]) => (
                        <li key={key}>{text}</li>
                      ))}
                    </ul>
                  </>
                )}
              </details>
            );
          })}
        </div>
      </Card>
      <Card title="What each role is for" className="only-wide">
        <dl className="facts">
          {d.roles.map((r) => (
            <div key={r.role}>
              <dt>{r.label}</dt>
              <dd>{r.purpose}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </>
  );
}
