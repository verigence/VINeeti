// Raising a ticket, and seeing what became of the ones you raised. Open to everybody signed in: the
// person who cannot get a screen to work is exactly the person who needs to be heard, and making them
// find a manager first is how a problem goes unreported.

import { useState } from "react";
import { api } from "../api";
import { Async, Button, Card, Chip, Empty, Field, Notice, PageHeader } from "../components/ui";
import { useAction, useLoad } from "../hooks";
import { plainText } from "../labels";
import type { SupportTicket } from "../types";

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const size = (n: number | null) => (n == null ? "" : n > 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function SupportPage() {
  const tickets = useLoad(() => api.myTickets(), "support");
  const action = useAction();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const submit = async () => {
    if (!subject.trim()) return setProblem("Say in a line what this is about.");
    if (!body.trim()) return setProblem("Describe what happened, so it can be acted on without coming back to ask you.");
    setProblem(null);
    const res = await action.run(() => api.raiseTicket(subject.trim(), body.trim(), file), { quiet: true, success: "Your ticket has been raised." });
    if (res) {
      setSubject("");
      setBody("");
      setFile(null);
      setSent(true);
      void tickets.reload();
    }
  };

  return (
    <>
      <PageHeader title="Support" subtitle="Raise a ticket with the team that looks after VINeeti. It does not go to anybody at your dealership." />
      <Card title="Raise a ticket">
        <form
          className="form-stack"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {sent && <Notice tone="ok" title="Raised. ">It has gone to the VINeeti team, and you will see it below until it is closed.</Notice>}
          <Field label="What is this about?" hint="One line, as you would say it to a colleague.">
            <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={150} autoComplete="off" />
          </Field>
          <Field label="What happened?" hint="What you were doing, what you expected, and what the screen did instead. A booking number or a VIN helps." wide>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} maxLength={8000} />
          </Field>
          <Field label="Attach a file" hint="A screenshot, a PDF, a spreadsheet or a text file, up to 10 MB. Optional." wide>
            <input type="file" accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.csv,.xlsx,.xls,.docx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
          {(problem || action.error) && <Notice tone="error">{problem ?? plainText(action.error)}</Notice>}
          <div className="form-actions">
            <Button type="submit" variant="primary" busy={action.busy}>
              Raise the ticket
            </Button>
          </div>
        </form>
      </Card>
      <Card title="Your tickets" note="Only yours. Nobody at the dealership sees them." flush>
        <Async load={tickets} empty={<Empty title="You have not raised a ticket" hint="When something does not work as you expect, raise one here." />}>
          {(res) => (
            <div className="list">
              {res.tickets.map((t: SupportTicket) => (
                <article key={t.id} className="list-row">
                  <div className="list-main">
                    <span className="strong">{t.subject}</span>
                    <span className="sub">
                      {when(t.created_at)}
                      {t.attachment_name ? ` · ${t.attachment_name} (${size(t.attachment_size)})` : ""}
                    </span>
                    <p className="muted" style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>{t.body}</p>
                    {t.closing_note && (
                      <Notice tone="ok" title="Answered. ">
                        {t.closing_note}
                      </Notice>
                    )}
                  </div>
                  <div className="list-side">
                    <Chip tone={t.status === "OPEN" ? "amber" : "green"}>{t.status === "OPEN" ? "Open" : "Closed"}</Chip>
                    {t.attachment_name && (
                      <a className="btn btn-secondary btn-sm" href={api.ticketAttachmentUrl(t.id)} download>
                        Download
                      </a>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </Async>
      </Card>
    </>
  );
}
