import { useEffect, useState } from "react";
import { api } from "../api";
import { Async, Button, Card, DataTable, Empty, Filter, FilterBar, Select, StatusChip, type Column } from "../components/ui";
import { fmtDateTime, fmtMobile, fmtNumber, plural } from "../format";
import { useAction, useDebounced, useLoad } from "../hooks";
import { plainText, WA_EVENTS, WA_STATUS_OPTIONS, waAudience, waEvent, waStatus } from "../labels";
import { Link, useQuery } from "../router";
import { useSession } from "../session";
import type { WaMessage } from "../types";

/**
 * Only a message that failed can be sent again. One that was not sent on purpose (no customer consent,
 * messaging or this message switched off) stays that way; the server refuses to repeat it.
 */
const canSendAgain = (m: WaMessage) => m.status === "FAILED";

/** What is known about the message after it left: test mode, or the latest receipt from WhatsApp. */
function deliveryNote(m: WaMessage): string {
  if (m.provider === "TEST" && m.status !== "SKIPPED") return "Test mode, not actually sent";
  if (m.read_at) return `Read ${fmtDateTime(m.read_at)}`;
  if (m.delivered_at) return `Delivered ${fmtDateTime(m.delivered_at)}`;
  if (m.sent_at) return `Sent ${fmtDateTime(m.sent_at)}`;
  return "";
}

export function MessageLog() {
  const { can } = useSession();
  const [query, setQuery] = useQuery();
  const status = query.get("status") ?? "";
  const eventKey = query.get("event_key") ?? "";
  const q = query.get("q") ?? "";
  const [search, setSearch] = useState(q);
  const debounced = useDebounced(search);
  useEffect(() => {
    if (debounced !== q) setQuery({ q: debounced });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const params = { status: status || undefined, event_key: eventKey || undefined, q: q || undefined };
  const load = useLoad(() => api.waMessages(params), `wa:messages:${JSON.stringify(params)}`);
  const action = useAction();
  const [open, setOpen] = useState<string | null>(null);

  const retry = async (m: WaMessage) => {
    const res = await action.run(() => api.retryWaMessage(m.id), {
      success: (r) => (r.status === "FAILED" || r.status === "SKIPPED" ? `Tried again, but the message was not sent${r.error ? `: ${plainText(r.error)}` : "."}` : "Message sent again."),
    });
    if (res) await load.reload();
  };

  const columns: Column<WaMessage>[] = [
    {
      header: "Message",
      primary: true,
      cell: (m) => (
        <>
          <span className="strong">{waEvent(m.event_key)}</span>
          <span className="sub">{fmtDateTime(m.created_at)}</span>
        </>
      ),
    },
    {
      header: "To",
      cell: (m) => (
        <>
          <span>{m.to_name ?? waAudience(m.audience)}</span>
          <span className="sub">{fmtMobile(m.to_mobile)}</span>
        </>
      ),
    },
    { header: "Booking", cell: (m) => (m.booking_id && m.booking_no ? can("booking.view") ? <Link to={`/bookings/${m.booking_id}`}>{m.booking_no}</Link> : m.booking_no : <span className="muted">—</span>), hideIfEmpty: (m) => !m.booking_no },
    { header: "Status", status: true, cell: (m) => <StatusChip label={waStatus(m.status)} /> },
    {
      header: "Delivery",
      hideIfEmpty: (m) => !deliveryNote(m),
      cell: (m) => deliveryNote(m) || <span className="muted">—</span>,
    },
    { header: "Problem", cell: (m) => (m.error ? <span className="danger">{plainText(m.error)}</span> : <span className="muted">—</span>), hideIfEmpty: (m) => !m.error },
    {
      header: "Actions",
      actions: true,
      cell: (m) => (
        <span className="row-actions">
          <Button size="sm" variant="ghost" aria-expanded={open === m.id} onClick={() => setOpen(open === m.id ? null : m.id)}>
            {open === m.id ? "Hide text" : "Show text"}
          </Button>
          {(can("wa.resend") || can("wa.manage")) && canSendAgain(m) && (
            <Button size="sm" disabled={action.busy} onClick={() => void retry(m)}>
              Send again
            </Button>
          )}
        </span>
      ),
    },
  ];

  // The counts stay on screen while a filtered list is loading, so the search box never loses focus.
  const [counts, setCounts] = useState<{ status: string; n: number }[] | null>(null);
  useEffect(() => {
    if (load.data) setCounts(load.data.counts);
  }, [load.data]);
  const total = (counts ?? []).reduce((n, c) => n + c.n, 0);

  return (
    <>
      {counts && (
        <div className="count-chips" role="group" aria-label="Messages by status">
          <button type="button" className={`count-chip${status === "" ? " count-chip-active" : ""}`} aria-pressed={status === ""} onClick={() => setQuery({ status: null })}>
            <span className="count-n">{fmtNumber(total)}</span> All
          </button>
          {WA_STATUS_OPTIONS.map((o) => {
            const n = counts.find((c) => c.status === o.value)?.n ?? 0;
            return (
              <button key={o.value} type="button" className={`count-chip${status === o.value ? " count-chip-active" : ""}`} aria-pressed={status === o.value} onClick={() => setQuery({ status: status === o.value ? null : o.value })}>
                <span className="count-n">{fmtNumber(n)}</span> {o.label}
              </button>
            );
          })}
        </div>
      )}
      <FilterBar
        active={[eventKey, status].filter(Boolean).length}
        onClear={() => setQuery({ event_key: null, status: null })}
        search={
          <Filter label="Search" grow>
            <input type="search" inputMode="search" enterKeyHint="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Mobile number, name or booking number" />
          </Filter>
        }
      >
        <Filter label="Message">
          <Select value={eventKey} onChange={(v) => setQuery({ event_key: v })} options={Object.entries(WA_EVENTS).map(([value, label]) => ({ value, label }))} placeholder="Any message" />
        </Filter>
        <Filter label="Status">
          <Select value={status} onChange={(v) => setQuery({ status: v })} options={WA_STATUS_OPTIONS} placeholder="Any status" />
        </Filter>
      </FilterBar>
      <Card flush>
        <Async load={load} isEmpty={(d) => d.messages.length === 0} empty={<Empty title={status || eventKey || q ? "No messages match" : "No messages yet"} hint={status || eventKey || q ? "Clear the filters to see everything." : "Messages appear here as cars are allocated and received."} />}>
          {(d) => (
            <>
              <p className="list-count">
                {plural(d.messages.length, "message")}
                {d.messages.length >= 300 ? " (latest 300 shown)" : ""}
              </p>
              <DataTable
                columns={columns}
                rows={d.messages}
                rowKey={(m) => m.id}
                caption="WhatsApp messages"
                detail={(m) =>
                  m.id === open ? (
                    <div className="row-detail-body">
                      <p className="bubble">{m.rendered_text}</p>
                      <p className="meta">
                        Template <span className="mono">{m.template_name}</span>
                        {m.attempts ? ` · ${plural(m.attempts, "attempt")}` : ""}
                      </p>
                    </div>
                  ) : null
                }
              />
            </>
          )}
        </Async>
      </Card>
    </>
  );
}
