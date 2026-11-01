// Who has signed in, from where and when.
//
// Refused attempts are shown beside the successful ones, because the question this screen is opened
// to answer is usually not "did Sunita sign in" but "is somebody trying to". The address is the only
// thing that tells the dealership's own office apart from somewhere else; it is not an identity, and
// a phone on mobile data will show a different one each day, so the screen says so rather than
// leaving somebody to read more into it than it can carry.

import { api } from "../api";
import { Async, Card, Chip, DataTable, Empty, Filter, FilterBar, Notice, PageHeader, Select, Tabs, type Column } from "../components/ui";
import { fmtDateTime, fmtMobile, plural } from "../format";
import { useLoad } from "../hooks";
import { useQuery } from "../router";
import { useSession } from "../session";
import type { SignInRow } from "../types";

const OUTCOMES = [
  { value: "IN", label: "Signed in" },
  { value: "REFUSED", label: "Refused" },
  { value: "LOCKED", label: "Locked out" },
];

const outcome = (o: SignInRow["outcome"]): { text: string; tone: "green" | "red" | "amber" } =>
  o === "IN" ? { text: "Signed in", tone: "green" } : o === "LOCKED" ? { text: "Locked out", tone: "red" } : { text: "Refused", tone: "amber" };

export function SignInsPage() {
  const { roleLabel } = useSession();
  const [query, setQuery] = useQuery();
  const only = query.get("outcome") ?? "";
  const load = useLoad(() => api.signIns({ outcome: only || undefined, limit: 500 }), `sign-ins:${only}`);

  const columns: Column<SignInRow>[] = [
    { header: "When", cell: (r) => fmtDateTime(r.at), width: "170px" },
    {
      header: "Who",
      primary: true,
      cell: (r) => (
        <>
          <span>{r.name ?? "No account with this number"}</span>
          <span className="sub">
            {fmtMobile(r.mobile)}
            {r.role ? ` · ${roleLabel(r.role)}` : ""}
          </span>
        </>
      ),
    },
    { header: "What happened", cell: (r) => <Chip tone={outcome(r.outcome).tone}>{outcome(r.outcome).text}</Chip>, width: "140px" },
    {
      header: "From",
      cell: (r) => (
        <>
          <span>{r.ip ?? "Not recorded"}</span>
          <span className="sub">
            {r.client === "APP" ? "Installed app" : "Browser"}
            {r.country ? ` · ${r.country}` : ""}
          </span>
        </>
      ),
      width: "190px",
    },
  ];

  return (
    <>
      <PageHeader title="History" subtitle="Every change, who made it and when, and who has signed in." />
      <Tabs tabs={[{ to: "/audit", label: "Changes" }, { to: "/audit/sign-ins", label: "Sign-ins" }]} current="/audit/sign-ins" />
      <FilterBar active={only ? 1 : 0} onClear={() => setQuery({ outcome: null })}>
        <Filter label="What happened">
          <Select value={only} onChange={(v) => setQuery({ outcome: v })} options={OUTCOMES} placeholder="Everything" />
        </Filter>
      </FilterBar>
      <Async load={load} empty={<Empty title="Nobody has signed in yet" />}>
        {(d) => (
          <>
            <Notice tone="info">
              A phone on mobile data gets a new address often, so an unfamiliar one on its own means little; the same one against several refused
              attempts is worth a look. Rows older than {plural(d.keep_days, "day")} are deleted.
            </Notice>
            <Card flush>
              {d.sign_ins.length === 0 ? (
                <Empty title="Nothing matches" hint="Change or clear the filter." />
              ) : (
                <>
                  <p className="list-count">
                    {plural(d.sign_ins.length, "sign-in")}
                    {d.sign_ins.length >= 500 ? " (latest 500 shown)" : ""}
                  </p>
                  <DataTable columns={columns} rows={d.sign_ins} rowKey={(r) => r.id} caption="Sign-ins" />
                </>
              )}
            </Card>
          </>
        )}
      </Async>
    </>
  );
}
