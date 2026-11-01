import { useState, type ReactNode } from "react";
import { api } from "../api";
import { Async, Button, Card, DataTable, Empty, Filter, FilterBar, PageHeader, Select, Tabs, type Column } from "../components/ui";
import { fmtDate, fmtDateTime, fmtMobile, fmtMoney, plural, zonedToIso } from "../format";
import { useLoad } from "../hooks";
import { actorName, AUDIT_ACTIONS, AUDIT_ENTITIES, auditEntity, auditSentence, codeLabel, fieldLabel, plainText, waEvent } from "../labels";
import { Link, useQuery } from "../router";
import { useSession } from "../session";
import type { AuditRow } from "../types";

const ENTITY_OPTIONS = Object.entries(AUDIT_ENTITIES).map(([value, label]) => ({ value, label }));
const ACTION_OPTIONS = Object.entries(AUDIT_ACTIONS)
  .map(([value, label]) => ({ value, label }))
  .sort((a, b) => a.label.localeCompare(b.label));

export function AuditPage() {
  const { can, outletName, roleLabel } = useSession();
  const [query, setQuery] = useQuery();
  const entityType = query.get("entity_type") ?? "";
  const actionKey = query.get("action") ?? "";
  const from = query.get("from") ?? "";
  const params = { entity_type: entityType || undefined, action: actionKey || undefined, from: from ? zonedToIso(from) : undefined, limit: 500 };
  const load = useLoad(() => api.audit(params), `audit:${JSON.stringify(params)}`);
  const [open, setOpen] = useState<string | null>(null);
  // Entries about a user or an outlet only carry its internal number; these lists turn it into a name.
  const directory = useLoad(() => api.directory(), "directory");
  const subject = (r: AuditRow): string => {
    if (typeof r.detail?.booking_no === "string") return ` ${r.detail.booking_no}`;
    if (r.entity_type === "user") {
      const name = directory.data?.find((u) => u.id === r.entity_id)?.name;
      return name ? `: ${name}` : "";
    }
    if (r.entity_type === "outlet") return `: ${outletName(r.entity_id)}`;
    if (r.entity_type === "wa_template") return `: ${waEvent(r.entity_id)}`;
    return "";
  };

  const entityLink = (r: AuditRow): ReactNode => {
    if (r.entity_type === "booking" && can("booking.view")) return <Link to={`/bookings/${r.entity_id}`}>Open booking</Link>;
    if (r.entity_type === "vehicle" && can("stock.view")) return <Link to={`/stock/cars/${r.entity_id}`}>Open car</Link>;
    return null;
  };

  const columns: Column<AuditRow>[] = [
    { header: "When", cell: (r) => fmtDateTime(r.at), width: "170px" },
    { header: "Who", cell: (r) => actorName(r.actor, r.actor_name), width: "160px" },
    {
      header: "What happened",
      primary: true,
      cell: (r) => (
        <>
          <span>{auditSentence(r.action, r.detail, outletName, roleLabel)}</span>
          <span className="sub">
            {auditEntity(r.entity_type)}
            {subject(r)}
          </span>
        </>
      ),
    },
    { header: "Record", cell: (r) => entityLink(r) ?? <span className="muted">—</span>, hideIfEmpty: (r) => !entityLink(r), width: "120px" },
    {
      header: "Details",
      actions: true,
      width: "120px",
      cell: (r) => (
        <Button size="sm" variant="ghost" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>
          {open === r.id ? "Hide details" : "Show details"}
        </Button>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="History" subtitle="Every change, who made it and when, and who has signed in." />
      <Tabs tabs={[{ to: "/audit", label: "Changes" }, { to: "/audit/sign-ins", label: "Sign-ins" }]} current="/audit" />
      <FilterBar active={[entityType, actionKey, from].filter(Boolean).length} onClear={() => setQuery({ entity_type: null, action: null, from: null })}>
        <Filter label="Record type">
          <Select value={entityType} onChange={(v) => setQuery({ entity_type: v })} options={ENTITY_OPTIONS} placeholder="Any record" />
        </Filter>
        <Filter label="Action">
          <Select value={actionKey} onChange={(v) => setQuery({ action: v })} options={ACTION_OPTIONS} placeholder="Any action" />
        </Filter>
        <Filter label="From date">
          <input type="date" value={from} onChange={(e) => setQuery({ from: e.target.value })} />
        </Filter>
      </FilterBar>
      <Card flush>
        <Async load={load} empty={<Empty title={entityType || actionKey || from ? "No entries match" : "Nothing recorded yet"} hint={entityType || actionKey || from ? "Change or clear the filters." : undefined} />}>
          {(rows) => (
            <>
              <p className="list-count">
                {plural(rows.length, "entry", "entries")}
                {rows.length >= 500 ? " (latest 500 shown; set a later From date or a filter to narrow down)" : ""}
              </p>
              <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} caption="Audit trail" detail={(r) => (r.id === open ? <AuditDetail row={r} /> : null)} />
            </>
          )}
        </Async>
      </Card>
    </>
  );
}

function AuditDetail({ row }: { row: AuditRow }) {
  const { outletName, roleLabel } = useSession();
  // Internal record numbers mean nothing to a reader; the sentence above already names the booking or car.
  const hidden = (k: string) => (/_id$/.test(k) && !/outlet_id$/.test(k)) || k === "id";
  const filled = (v: unknown) => v !== null && v !== undefined && v !== "" && !(typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);
  const entries = Object.entries(row.detail ?? {}).filter(([k, v]) => filled(v) && !hidden(k));

  const show = (key: string, value: unknown): string => {
    if (typeof value === "boolean") return value ? "Yes" : "No";
    if (Array.isArray(value)) {
      // Stock edits are recorded as [before, after].
      if (value.length === 2 && /date|_no$/.test(key)) return `${value[0] ? show(key, value[0]) : "not set"} changed to ${value[1] ? show(key, value[1]) : "not set"}`;
      return value.length ? value.map((v) => show(key, v)).join(", ") : "None";
    }
    if (typeof value === "object" && value !== null) {
      return Object.entries(value as Record<string, unknown>)
        .filter(([k, v]) => filled(v) && !hidden(k))
        .map(([k, v]) => `${fieldLabel(k)}: ${show(k, v)}`)
        .join("; ");
    }
    const s = String(value);
    if (/outlet_ids?$/.test(key)) return outletName(s);
    if (key === "role" || /_roles$/.test(key)) return roleLabel(s);
    if (/amount/.test(key) && typeof value === "number") return fmtMoney(value);
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return fmtDateTime(s);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return fmtDate(s);
    if (/mobile|^to$/.test(key) && /^\d{11,15}$/.test(s)) return fmtMobile(s);
    if (/^[A-Z][A-Z0-9_]+$/.test(s) && !/(vin|booking_no|model|variant|colour|code|filename|name|reference)$/.test(key)) return codeLabel(key, s);
    return plainText(s);
  };

  return (
    <div className="row-detail-body">
      {entries.length ? (
        <dl className="kv kv-2">
          {entries.map(([k, v]) => (
            <div key={k} className="kv-item">
              <dt>{fieldLabel(k)}</dt>
              <dd>{show(k, v)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="muted">No further details were recorded for this entry.</p>
      )}
    </div>
  );
}
