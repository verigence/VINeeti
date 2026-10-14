import { useRef, useState } from "react";
import { api } from "../api";
import { Async, Button, Card, Check, Chip, Field, Notice, StatusChip } from "../components/ui";
import { useAction, useLoad } from "../hooks";
import { metaStatus, plainText, waAudience } from "../labels";
import { useSession } from "../session";
import type { WaTemplate } from "../types";

const PARAM = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;

/** The message as the customer would read it, with the example values filled in. */
function Preview({ body, examples }: { body: string; examples: Record<string, string> }) {
  const parts: (string | { name: string })[] = [];
  let last = 0;
  for (const m of body.matchAll(PARAM)) {
    if (m.index > last) parts.push(body.slice(last, m.index));
    parts.push({ name: m[1] });
    last = m.index + m[0].length;
  }
  if (last < body.length) parts.push(body.slice(last));
  return (
    <p className="bubble">
      {parts.map((p, i) =>
        typeof p === "string" ? (
          <span key={i}>{p}</span>
        ) : p.name in examples ? (
          <span key={i} className="param-value">
            {examples[p.name]}
          </span>
        ) : (
          <span key={i} className="param-unknown">{`{{${p.name}}}`}</span>
        ),
      )}
    </p>
  );
}

/** The same checks the server (and Meta) apply, so a problem shows while typing rather than after saving. */
function wordingProblem(body: string, available: string[]): string | null {
  const text = body.trim();
  if (!text) return "The message needs some wording.";
  if (text.length > 1024) return `The message is ${text.length} characters long. The limit is 1,024.`;
  if (/\{\{[^}]*\}\}/.test(text.replace(PARAM, ""))) return "Parameters must be written exactly as in the list below, for example {{customer_name}}.";
  const unknown = [...new Set([...text.matchAll(PARAM)].map((m) => m[1]))].filter((p) => !available.includes(p));
  if (unknown.length) return `This message cannot use ${unknown.map((p) => `{{${p}}}`).join(", ")}. Use only the parameters listed below.`;
  if (/^\{\{/.test(text) || /\}\}$/.test(text)) return "The message cannot start or end with a parameter. Add a word before or after it.";
  if (/\}\}\s*\{\{/.test(text)) return "Two parameters cannot sit next to each other. Put a word or a comma between them, for example {{dealership}}, {{eta}}.";
  return null;
}

/** Explains a server refusal that is about the wording already saved, not about what the user just changed. */
function templateError(message: string | null): string | null {
  if (!message) return null;
  if (/next to each other/.test(message)) return `${message}. Open "Edit wording" and put a word or a comma between the two parameters, for example {{dealership}}, {{eta}}; then save.`;
  return plainText(message);
}

export function TemplatesTab() {
  const { can } = useSession();
  const load = useLoad(() => api.waTemplates(), "wa:templates");
  const action = useAction();
  const editable = can("wa.manage");

  const refresh = async () => {
    const res = await action.run(() => api.refreshWaTemplates(), { success: "Approval status refreshed from Meta." });
    if (res) await load.reload();
  };

  return (
    <>
      <div className="toolbar">
        <p className="muted">
          These messages are sent automatically. In live mode WhatsApp only delivers wording that Meta has approved, so the text here must match the approved template exactly.
        </p>
        {editable && (
          <Button icon="refresh" busy={action.busy} onClick={() => void refresh()}>
            Refresh status
          </Button>
        )}
      </div>
      <Async load={load}>
        {(rows) => (
          <div className="template-list">
            {rows.map((t) => (
              <TemplateCard key={`${t.event_key}:${t.body}:${t.template_name}:${t.language}:${t.enabled}`} t={t} editable={editable} reload={load.reload} />
            ))}
          </div>
        )}
      </Async>
    </>
  );
}

function TemplateCard({ t, editable, reload }: { t: WaTemplate; editable: boolean; reload: () => Promise<void> }) {
  const action = useAction();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(t.template_name);
  const [language, setLanguage] = useState(t.language);
  const [body, setBody] = useState(t.body);
  const [note, setNote] = useState<string | null>(null);
  // The switch moves at once and goes back if the server refuses the change.
  const [enabled, setEnabled] = useState(t.enabled);
  const area = useRef<HTMLTextAreaElement>(null);
  const dirty = name !== t.template_name || language !== t.language || body !== t.body;
  const wordingChanged = dirty && t.meta_status;
  // WhatsApp fixes the wording of a one-time code message: only its template name and language can change.
  const fixed = t.fixed_wording;
  const problem = fixed ? null : wordingProblem(body, t.available_params);

  const insert = (param: string) => {
    const el = area.current;
    const token = `{{${param}}}`;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    setBody(body.slice(0, start) + token + body.slice(end));
    window.requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const save = async () => {
    const res = await action.run(() => api.saveWaTemplate(t.event_key, { template_name: name.trim(), language: language.trim(), ...(fixed ? {} : { body: body.trim() }) }), { quiet: true, success: `"${t.title}" saved.` });
    if (res) await reload();
  };
  const toggle = async (on: boolean) => {
    setEnabled(on);
    const res = await action.run(() => api.saveWaTemplate(t.event_key, { enabled: on }), { quiet: true, success: `"${t.title}" switched ${on ? "on" : "off"}.` });
    if (res) await reload();
    else setEnabled(t.enabled);
  };
  const submit = async () => {
    const res = await action.run(() => api.submitWaTemplate(t.event_key), { quiet: true, success: `"${t.title}" sent to Meta for approval.` });
    if (res) await reload();
  };

  return (
    <Card
      title={t.title}
      note={`Sent when: ${t.when.charAt(0).toLowerCase()}${t.when.slice(1)}.`}
      actions={
        <span className="chips">
          <Chip tone={t.audience === "CUSTOMER" ? "blue" : "purple"}>To: {waAudience(t.audience).toLowerCase()}</Chip>
          {t.enabled ? <Chip tone="green">On</Chip> : <Chip tone="red">Off</Chip>}
          <StatusChip label={metaStatus(t.meta_status)} />
        </span>
      }
    >
      {editing ? (
        <div className="form-stack">
          <div className="form-grid">
            <Field label="Template name in WhatsApp Manager" hint="Lowercase letters, digits and underscores.">
              <input value={name} onChange={(e) => setName(e.target.value)} className="mono" autoComplete="off" spellCheck={false} />
            </Field>
            <Field label="Language code" hint="For example en, en_US or hi.">
              <input value={language} onChange={(e) => setLanguage(e.target.value)} className="mono" autoComplete="off" spellCheck={false} maxLength={6} />
            </Field>
          </div>
          {fixed ? (
            <Notice>WhatsApp fixes the wording of this message. Only the template name and language can be changed.</Notice>
          ) : (
            <>
              <Field label="Wording" hint={`${body.length} of 1,024 characters. The message cannot start or end with a parameter.`}>
                <textarea ref={area} rows={7} value={body} onChange={(e) => setBody(e.target.value)} maxLength={1100} />
              </Field>
              <div>
                <p className="field-label">Parameters you can use (select one to insert it)</p>
                <div className="chips">
                  {t.available_params.map((p) => (
                    <button key={p} type="button" className="param-btn" onClick={() => insert(p)}>
                      {`{{${p}}}`}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
          <div>
            <p className="field-label">{fixed ? "Wording" : "Preview with example values"}</p>
            <Preview body={body} examples={t.examples} />
          </div>
          {problem && <Notice tone="warn">{problem}</Notice>}
          {wordingChanged && <Notice tone="warn">Saving a change to the name, language or wording clears Meta's approval status. Send the message for approval again afterwards.</Notice>}
          {note && <Notice>{note}</Notice>}
          {action.error && <Notice tone="error">{plainText(action.error)}</Notice>}
          <div className="form-actions">
            <Button variant="primary" busy={action.busy} disabled={!dirty || Boolean(problem)} onClick={() => void save()}>
              Save
            </Button>
            {!fixed && (
              <Button
                disabled={action.busy || body === t.default_body}
                onClick={() => {
                  setBody(t.default_body);
                  setNote("The default wording is back in the box. Save to keep it.");
                }}
              >
                Reset to default wording
              </Button>
            )}
            <Button
              variant="ghost"
              disabled={action.busy}
              onClick={() => {
                setName(t.template_name);
                setLanguage(t.language);
                setBody(t.body);
                setNote(null);
                action.clearError();
                setEditing(false);
              }}
            >
              Close
            </Button>
          </div>
        </div>
      ) : (
        <>
          <Preview body={t.body} examples={t.examples} />
          <p className="meta">
            Template <span className="mono">{t.template_name}</span> · language <span className="mono">{t.language}</span> · uses {t.params.length ? t.params.map((p) => `{{${p}}}`).join(" ") : "no parameters"}
          </p>
          {action.error && <Notice tone="error">{templateError(action.error)}</Notice>}
          {editable && (
            <div className="form-actions">
              <Button onClick={() => setEditing(true)}>{fixed ? "Edit template name" : "Edit wording"}</Button>
              <Button busy={action.busy} onClick={() => void submit()}>
                Send for approval
              </Button>
              <Check checked={enabled} onChange={(v) => void toggle(v)} disabled={action.busy}>
                Send this message
              </Check>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
