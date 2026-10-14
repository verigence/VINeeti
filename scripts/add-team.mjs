#!/usr/bin/env node
// Creates one user per role on a dealership, so every perspective in the product can actually be seen.
// A dealership that has only its System Admin has no way to look at the Dealer Principal's screen, the
// CEO's, or a sales consultant's — and those are different screens, decided by what each role may do.
//
//   ADDRESS=https://... DEALER_CODE=aditya ADMIN_MOBILE=... ADMIN_PASSWORD=... TEAM_PASSWORD=...
//   node scripts/add-team.mjs
//
// The passwords are read from the environment and never printed. Each person must replace theirs at
// their first sign-in; the product forces that.

import { Stop, main, note } from "./lib/cloudflare.mjs";

/** One of each, in the order a dealership would introduce them. */
const TEAM = [
  ["DEALER_PRINCIPAL", "Dealer Principal", "sees the month, the outlets, fairness and what is at risk"],
  ["BUSINESS_HEAD", "Business Head / CEO", "sees the trend, the money in the yard and the governance"],
  ["SALES_MANAGER", "Sales Lead", "approves bookings and watches the team's queue"],
  ["SALES_EXEC", "Sales Executive", "answers the customer: stock check, browse, their own bookings"],
  ["ACCOUNTS", "Finance", "checks payments against the bank"],
  ["CRM", "CRM", "contacts customers, loads the DMS files"],
  ["STOCK_INCHARGE", "Stock In-charge", "receives cars, transfers, loads the stock report"],
  ["ORDERING", "Ordering Desk", "orders on the manufacturer, keeps the vehicle master"],
];

main(async () => {
  const base = process.env.ADDRESS?.trim();
  const dealer = process.env.DEALER_CODE?.trim();
  const mobile = process.env.ADMIN_MOBILE?.trim();
  const password = process.env.ADMIN_PASSWORD;
  const teamPassword = process.env.TEAM_PASSWORD;
  if (!base || !mobile || !password || !teamPassword) throw new Stop("Set ADDRESS, ADMIN_MOBILE, ADMIN_PASSWORD and TEAM_PASSWORD.");
  if (String(teamPassword).length < 8 || !/[A-Za-z]/.test(teamPassword) || !/\d/.test(teamPassword)) throw new Stop("TEAM_PASSWORD needs at least 8 characters, with a letter and a number.");

  const login = await fetch(new URL("/api/auth/login", base), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dealer: dealer || undefined, mobile, password }),
  });
  if (!login.ok) throw new Stop(`Could not sign in as the System Admin (HTTP ${login.status}). Check the mobile number, the password and the dealer code.`);
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  if (!cookie) throw new Stop("Signed in, but the session cookie did not come back.");

  // Mobile numbers run on from the administrator's, so they are easy to remember and easy to remove.
  const stem = mobile.replace(/\D/g, "").slice(-10, -2) || "90000000";
  const made = [];
  const skipped = [];
  for (const [i, [role, label, what]] of TEAM.entries()) {
    const theirs = `${stem}${String(i + 11).padStart(2, "0")}`;
    const res = await fetch(new URL("/api/users", base), {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: label, mobile: theirs, role, password: teamPassword, all_outlets: true, outlet_ids: [] }),
    });
    if (res.status === 201) made.push([theirs, label, what]);
    else {
      const body = await res.json().catch(() => ({}));
      skipped.push(`${label} (${theirs}): ${body?.error?.message ?? `HTTP ${res.status}`}`);
    }
  }

  const lines = made.map(([m, label, what]) => `- **${label}** — sign in with \`${m}\` — ${what}`);
  note(
    made.length
      ? `Created ${made.length} of the ${TEAM.length} roles at ${base}. They all share the first password you gave this run, and each must replace it at first sign-in.\n\n${lines.join("\n")}${skipped.length ? `\n\nNot created:\n- ${skipped.join("\n- ")}` : ""}`
      : `No user was created. ${skipped.join(" ")}`,
    "The team",
  );
});
