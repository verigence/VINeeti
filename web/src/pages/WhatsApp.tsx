import { useState, type FormEvent } from "react";
import { api } from "../api";
import { ActionBar, Async, Button, Card, Check, Chip, CopyField, Empty, Field, KeyValues, Notice, PageHeader, PasswordInput, RadioGroup, Select, StatusChip, Tabs } from "../components/ui";
import { fmtDateTime, fmtMobile } from "../format";
import { useAction, useLoad } from "../hooks";
import { humanize, plainText, waProvider, waStatus } from "../labels";
import { useSession } from "../session";
import type { WaConfig, WaConfigInput, WaTestResult } from "../types";
import { MessageLog } from "./WaLog";
import { TemplatesTab } from "./WaTemplates";

type Tab = "connection" | "messages" | "test" | "log" | "replies";

export function WhatsAppPage({ tab }: { tab: Tab }) {
  const { can } = useSession();
  const tabs = [
    { to: "/whatsapp", label: "Connection" },
    { to: "/whatsapp/messages", label: "Messages" },
    ...(can("wa.manage") ? [{ to: "/whatsapp/test", label: "Send a test" }] : []),
    { to: "/whatsapp/log", label: "Message log" },
    { to: "/whatsapp/replies", label: "Customer replies" },
  ];
  return (
    <>
      <PageHeader title="WhatsApp" subtitle="Your dealership's own WhatsApp number, the wording of each message, and what has been sent." />
      <Tabs current={tab === "connection" ? "/whatsapp" : `/whatsapp/${tab}`} tabs={tabs} />
      {!can("wa.manage") && (tab === "connection" || tab === "messages") && <Notice>You can view these settings. Only the system administrator can change them.</Notice>}
      {tab === "connection" && <ConnectionTab />}
      {tab === "messages" && <TemplatesTab />}
      {tab === "test" && (can("wa.manage") ? <TestTab /> : <Notice tone="warn">Only the system administrator can send a test message.</Notice>)}
      {tab === "log" && <MessageLog />}
      {tab === "replies" && <RepliesTab />}
    </>
  );
}

// ---------------------------------------------------------------- connection
function ConnectionTab() {
  const load = useLoad(() => api.waConfig(), "wa:config");
  return (
    <Async load={load} isEmpty={() => false}>
      {(cfg) => <ConnectionForm key={cfg.updated_at ?? "new"} cfg={cfg} reload={load.reload} />}
    </Async>
  );
}

function ConnectionForm({ cfg, reload }: { cfg: WaConfig; reload: () => Promise<void> }) {
  const { can } = useSession();
  const action = useAction();
  const editable = can("wa.manage");
  const [provider, setProvider] = useState(cfg.provider);
  const [enabled, setEnabled] = useState(cfg.enabled);
  const [displayNumber, setDisplayNumber] = useState(cfg.display_number ?? "");
  const [phoneNumberId, setPhoneNumberId] = useState(cfg.phone_number_id ?? "");
  const [wabaId, setWabaId] = useState(cfg.waba_id ?? "");
  const [accessToken, setAccessToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [verifyToken, setVerifyToken] = useState(cfg.verify_token ?? "");
  const [graphVersion, setGraphVersion] = useState(cfg.graph_version ?? "");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editable || action.busy) return;
    const body: WaConfigInput = {
      provider,
      enabled,
      display_number: displayNumber.trim(),
      phone_number_id: phoneNumberId.trim(),
      waba_id: wabaId.trim(),
      verify_token: verifyToken.trim(),
      graph_version: graphVersion.trim(),
    };
    // Secrets are only sent when a new value was typed; a blank field keeps what is saved.
    if (accessToken.trim()) body.access_token = accessToken.trim();
    if (appSecret.trim()) body.app_secret = appSecret.trim();
    const res = await action.run(() => api.saveWaConfig(body), { quiet: true, success: "WhatsApp connection saved." });
    if (res) await reload();
  };

  return (
    <form onSubmit={submit} noValidate className="form-page">
      <Card title="Status">
        <div className="chips chips-row">
          {cfg.provider === "META" ? cfg.connected ? <Chip tone="green">Connected to WhatsApp</Chip> : <Chip tone="red">Not connected</Chip> : <Chip tone="amber">Test mode</Chip>}
          {cfg.enabled ? <Chip tone="green">Messaging is on</Chip> : <Chip tone="red">Messaging is off</Chip>}
        </div>
        <p className="muted">
          {cfg.provider === "TEST"
            ? "Messages are written to the message log exactly as they would be sent, but nothing reaches a customer's phone."
            : cfg.connected
              ? `Messages are sent from ${cfg.display_number ? fmtMobile(cfg.display_number) : "your WhatsApp number"} through the WhatsApp Cloud API.`
              : "Live mode needs the phone number ID and an access token."}
          {cfg.updated_at ? ` Last changed ${fmtDateTime(cfg.updated_at)}.` : ""}
        </p>
      </Card>

      <fieldset disabled={!editable} className="bare-fieldset">
        <Card title="How messages are sent">
          <div className="form-stack">
            <RadioGroup
              legend="Mode"
              value={provider}
              onChange={setProvider}
              options={[
                { value: "TEST", label: "Test mode: messages are recorded but not sent", help: "Use this until your number and message templates are approved." },
                { value: "META", label: "Live: send through WhatsApp Cloud API", help: "Needs the phone number ID and access token below." },
              ]}
            />
            <Check checked={enabled} onChange={setEnabled} hint="When off, every message is recorded as not sent. Allocation and the payment window carry on as normal.">
              Messaging is switched on
            </Check>
          </div>
        </Card>

        <Card title="Your WhatsApp number" note="From WhatsApp Manager in your Meta Business account, under API Setup.">
          <div className="form-grid">
            <Field label="Display number" optional hint="The phone number customers see, for your own reference.">
              <input value={displayNumber} onChange={(e) => setDisplayNumber(e.target.value)} type="tel" inputMode="numeric" autoComplete="off" />
            </Field>
            <Field label="Phone number ID" hint="The numeric ID shown next to the number. It is not the phone number itself.">
              <input value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} inputMode="numeric" autoComplete="off" className="mono" />
            </Field>
            <Field label="WhatsApp Business Account ID" hint="Needed to send message templates for approval and to read their status.">
              <input value={wabaId} onChange={(e) => setWabaId(e.target.value)} inputMode="numeric" autoComplete="off" className="mono" />
            </Field>
            <Field label="Graph API version" optional hint={`Leave blank to use ${cfg.default_graph_version}.`}>
              <input value={graphVersion} onChange={(e) => setGraphVersion(e.target.value)} placeholder={cfg.default_graph_version} autoComplete="off" className="mono" />
            </Field>
            <Field label="Access token" hint={cfg.has_access_token ? "A token is saved. It is never shown again. Type a new one only to replace it." : "A permanent system-user token with whatsapp_business_messaging permission."}>
              <span className="secret-row">
                <PasswordInput label="Access token" value={accessToken} onChange={setAccessToken} placeholder={cfg.has_access_token ? "Saved" : "Not set"} autoComplete="new-password" />
                {cfg.has_access_token ? <Chip tone="green">Saved</Chip> : <Chip tone="grey">Not set</Chip>}
              </span>
            </Field>
            <Field label="App secret" hint={cfg.has_app_secret ? "A secret is saved. It is never shown again. Type a new one only to replace it." : "From your Meta app's basic settings. Used to check that delivery receipts really come from Meta."}>
              <span className="secret-row">
                <PasswordInput label="App secret" value={appSecret} onChange={setAppSecret} placeholder={cfg.has_app_secret ? "Saved" : "Not set"} autoComplete="new-password" />
                {cfg.has_app_secret ? <Chip tone="green">Saved</Chip> : <Chip tone="grey">Not set</Chip>}
              </span>
            </Field>
          </div>
        </Card>

        <Card title="Delivery receipts and customer replies" note="Set this up once in your Meta app, under WhatsApp, Configuration, Webhook. Subscribe to the messages field.">
          <div className="form-grid">
            <CopyField label="Webhook URL (callback URL)" value={cfg.webhook_url} hint="Paste this into Meta as the callback URL." />
            <Field label="Webhook verify token" hint="Make up a phrase, save it here, then enter the same phrase in Meta.">
              <input value={verifyToken} onChange={(e) => setVerifyToken(e.target.value)} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} className="mono" maxLength={120} />
            </Field>
          </div>
        </Card>
      </fieldset>

      {action.error && <Notice tone="error">{plainText(action.error)}</Notice>}
      {editable && (
        <ActionBar>
          <Button type="submit" variant="primary" busy={action.busy}>
            Save connection
          </Button>
        </ActionBar>
      )}
    </form>
  );
}

// ---------------------------------------------------------------- send a test
function TestTab() {
  const { me } = useSession();
  const action = useAction();
  const [to, setTo] = useState(me.user.mobile.replace(/^91(?=\d{10}$)/, ""));
  const [eventKey, setEventKey] = useState("ALLOC_FREE_STOCK");
  const [result, setResult] = useState<WaTestResult | null>(null);
  // Every message except those whose wording WhatsApp fixes (the one-time code), which cannot be test-sent.
  const templates = useLoad(() => api.waTemplates(), "wa:templates:test");
  const options = (templates.data ?? []).filter((t) => !t.fixed_wording).map((t) => ({ value: t.event_key, label: t.title }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (action.busy) return;
    setResult(null);
    const res = await action.run(() => api.waTest(to.trim(), eventKey), { quiet: true });
    if (res) setResult(res);
  };

  return (
    <div className="split">
      <Card title="Send a test message" note="Sends one message with example values, to prove the connection end to end.">
        <form onSubmit={submit} noValidate className="form-stack">
          <Field label="Message" hint={templates.error ?? "The one-time code message is tried from the sign-in page (Set or reset password)."}>
            <Select value={eventKey} onChange={setEventKey} options={options} disabled={!options.length} />
          </Field>
          <Field label="Send to (mobile number)" hint="Use your own number. In live mode the message really is sent.">
            <input value={to} onChange={(e) => setTo(e.target.value)} type="tel" inputMode="numeric" autoComplete="off" />
          </Field>
          {action.error && <Notice tone="error">{plainText(action.error)}</Notice>}
          <div className="form-actions">
            <Button type="submit" variant="primary" busy={action.busy}>
              Send test
            </Button>
          </div>
        </form>
      </Card>
      <div aria-live="polite">
        {result ? (
          <Card title="Result">
            <div className="chips chips-row">
              <StatusChip label={waStatus(result.status)} />
            </div>
            {result.status === "FAILED" || result.status === "SKIPPED" ? (
              <Notice tone="error">{plainText(result.error) || "The message was not sent."}</Notice>
            ) : result.provider === "TEST" ? (
              <Notice>Test mode is on, so this was recorded but not sent to the phone. Switch to live mode on the Connection tab to send for real.</Notice>
            ) : (
              <Notice tone="ok">WhatsApp accepted the message. Check the phone, and the message log for the delivery receipt.</Notice>
            )}
            <KeyValues
              columns={1}
              items={[
                ["Sent to", fmtMobile(result.to_mobile)],
                ["Sent through", waProvider(result.provider)],
              ]}
            />
            <p className="bubble">{result.rendered_text}</p>
          </Card>
        ) : (
          <Card>
            <Empty title="The result appears here" />
          </Card>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- customer replies
function RepliesTab() {
  const load = useLoad(() => api.waInbound(), "wa:inbound");
  return (
    <Card title="Customer replies" note="The latest 50 messages customers sent to your WhatsApp number. Reply to them from the WhatsApp Business app or your CRM.">
      <Async load={load} empty={<Empty title="No replies yet" hint="Replies arrive once the webhook is set up in Meta and the number is live." />}>
        {(rows) => (
          <ul className="msg-list">
            {rows.map((m) => (
              <li key={m.id} className="msg">
                <div className="msg-head">
                  <span className="strong">{m.from_name || fmtMobile(m.from_mobile)}</span>
                  <span className="meta">{fmtDateTime(m.received_at)}</span>
                </div>
                {m.text ? <p className="bubble bubble-in">{m.text}</p> : <p className="muted">{m.message_type === "text" ? "Empty message" : `${humanize(m.message_type)} (open WhatsApp to see it)`}</p>}
                {m.from_name && <p className="meta">{fmtMobile(m.from_mobile)}</p>}
              </li>
            ))}
          </ul>
        )}
      </Async>
    </Card>
  );
}
