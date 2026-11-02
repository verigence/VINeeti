// The welcome screen: shown once to each person, the first time they reach the application itself
// (after the temporary password has been replaced), and never again on any device.
//
// It does two things and only two. It thanks the person, by name, for joining. And it shows them, in
// four lines, what VINeeti will do for them in particular -- a sales consultant and an owner open the
// same system for different reasons, so each role is given its own four, chosen by hand rather than
// worked out from permissions. A list assembled by rule reads like one; this should read like a note.

import { useState } from "react";
import { api } from "../api";
import { StatusBars } from "../components/AppBars";
import { BrandFoot } from "../components/Brand";
import { Icon, type IconName } from "../components/icons";
import { Button } from "../components/ui";
import { personName } from "../labels";
import { productName } from "../product";
import { useSession } from "../session";
import type { Role } from "../types";

interface Feature {
  icon: IconName;
  title: string;
  body: string;
}

/** Everything VINeeti does that is worth a line here, each described by what it means for the reader. */
const FEATURES = {
  overview: { icon: "owner", title: "The whole business at a glance", body: "Bookings, deliveries, the waiting queue and ageing stock, across every outlet, day by day." },
  decisions: { icon: "approvals", title: "Decisions that need you", body: "Bookings and requests awaiting your approval come straight to you, with what you need to decide." },
  fair: { icon: "car", title: "Fair allocation, automatically", body: "Cars go to bookings in the order your dealership's rules set — openly, and the same for every customer." },
  stock: { icon: "search", title: "Know before you promise", body: "Check any model, variant and colour, in the yard and on the way, before you commit a date to a customer." },
  bookings: { icon: "bookings", title: "Every booking, followed through", body: "Raise a booking and follow it from approval to delivery, with its place in the queue always in view." },
  requests: { icon: "approvals", title: "Ask for a car the right way", body: "Request an allocation or a take-back for a customer; it goes to the approver with your reason attached." },
  dms: { icon: "dayend", title: "Your DMS, kept in step", body: "Load the day's DMS files. VINeeti allocates, reconciles, and hands you the sheet to update the DMS." },
  payments: { icon: "payments", title: "Payments, verified", body: "Confirm payments against the bank, and record each invoice and delivery as it happens." },
  differences: { icon: "recon", title: "Differences caught early", body: "Each evening, anything stock, bookings and allocations disagree about is listed for settling." },
  settings: { icon: "admin", title: "Your rules, set once", body: "Set the allocation rules, the outlets and the people who use the system. Every change is recorded." },
  record: { icon: "audit", title: "A record you can rely on", body: "Every allocation, approval and change is kept — who did it, and when — for anyone who needs to check." },
} satisfies Record<string, Feature>;
type Key = keyof typeof FEATURES;

/** Four for each role, in the order that role would care about them. */
const BY_ROLE: Record<Role, Key[]> = {
  ADMIN: ["settings", "dms", "fair", "record"],
  DEALER_PRINCIPAL: ["overview", "decisions", "fair", "record"],
  CEO_VP: ["overview", "decisions", "fair", "differences"],
  GM_SALES: ["decisions", "stock", "fair", "bookings"],
  AGM_SALES: ["bookings", "requests", "stock", "fair"],
  SALES_LEAD: ["bookings", "stock", "fair", "record"],
  SALES_CONSULTANT: ["stock", "bookings", "fair", "record"],
  EDP_MANAGER: ["dms", "differences", "stock", "record"],
  FINANCE: ["payments", "bookings", "differences", "record"],
  AUDITOR: ["record", "differences", "fair", "stock"],
};
const FALLBACK: Key[] = ["fair", "stock", "bookings", "record"];

export function WelcomeScreen({ onDone }: { onDone: () => void }) {
  const { me, roleLabel } = useSession();
  const [busy, setBusy] = useState(false);
  const first = personName(me.user.name).split(" ")[0];
  const features = (BY_ROLE[me.user.role] ?? FALLBACK).map((k) => FEATURES[k]);

  const start = async () => {
    setBusy(true);
    // Recorded so it is not shown again. If the network is down, the person is let in regardless and
    // simply sees this once more next time: a welcome is never a reason to keep anybody out.
    await api.welcomed().catch(() => undefined);
    onDone();
  };

  return (
    <div className="auth">
      <StatusBars />
      <div className="auth-middle">
        <main className="welcome" aria-labelledby="welcome-title">
          <header className="welcome-head">
            <img src="/brand/wordmark.png" alt={productName(me.app_name)} className="welcome-wordmark" />
            <p className="welcome-eyebrow">Welcome</p>
            <h1 id="welcome-title" className="welcome-title">
              Thank you for joining us, {first}.
            </h1>
            <p className="welcome-lead">
              We are glad to have you with {me.tenant.name} on {productName(me.app_name)}. It brings bookings, stock and allocation into one place, so every customer is served in fair
              order and every decision is on record. Here is what it will do for you.
            </p>
            <p className="welcome-who">
              Signed in as {roleLabel(me.user.role)} · {me.tenant.name}
            </p>
          </header>

          <ul className="welcome-features">
            {features.map((f) => (
              <li key={f.title} className="welcome-feature">
                <span className="welcome-icon" aria-hidden="true">
                  <Icon name={f.icon} size={20} />
                </span>
                <span>
                  <span className="welcome-feature-title">{f.title}</span>
                  <span className="welcome-feature-body">{f.body}</span>
                </span>
              </li>
            ))}
          </ul>

          <footer className="welcome-foot">
            <p className="welcome-thanks">
              Thank you for the care you bring to every customer. If anything ever looks wrong, Support in the menu reaches the team directly.
            </p>
            <Button variant="primary" busy={busy} onClick={() => void start()} data-autofocus="">
              Get started
            </Button>
          </footer>
        </main>
      </div>
      <BrandFoot />
    </div>
  );
}
