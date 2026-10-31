// What the system writes to a person. Two messages, both about getting into the system: the welcome
// when an account is made, and a new password when one is reset. The wording follows the HR service's
// WELCOME template (verigence/hrmgmt, src/hrmgmt/message_templates.py).
//
// Each goes out as plain text with an HTML alternative. The HTML is laid out in tables with the styles
// written on the elements themselves, because that is the only thing every mail client agrees on:
// Outlook ignores a stylesheet, Gmail strips <style> in some views, and a phone needs the width to
// give way. Nothing is fetched from the web — the logo rides inside the message — so there is no
// "show pictures" bar and no tracking of any kind.
//
// A temporary password in an email is a weaker thing than a link that expires, and it is written here
// in one place so it can be replaced by one without touching the screens that send it. Until then the
// account it reaches must be replaced at first sign-in, which the system already enforces.

import type { Message } from "../lib/mailer";

export interface Welcome {
  name: string;
  dealership: string;
  roleLabel: string;
  mobile: string;
  password: string;
  signInUrl: string;
  /** The product logo, if the deployment could read it. Without it the message simply has no header picture. */
  logo?: Uint8Array;
  /** The maker's mark for the foot of the message. Optional in the same way. */
  jbr?: Uint8Array;
}

const NAVY = "#002858";
const TEAL = "#0098a8";
const INK = "#1b2733";
const MUTED = "#5b6672";
const LINE = "#e9eff3";
const LOGO_CID = "vineeti-logo";
const JBR_CID = "jbr-logo";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The number as a person reads it: 91 98765 00001. */
const prettyMobile = (m: string) => (/^91\d{10}$/.test(m) ? `${m.slice(0, 2)} ${m.slice(2, 7)} ${m.slice(7)}` : m);

interface Layout {
  heading: string;
  lead: string;
  w: Welcome;
  closing: string;
}

/** The message as a page: a header with the mark, the matter, the password, and what to do next. */
function page({ heading, lead, w, closing }: Layout): string {
  const logo = w.logo
    ? `<img src="cid:${LOGO_CID}" width="220" alt="Verigence VINeeti" style="display:block;border:0;outline:none;text-decoration:none;width:220px;max-width:100%;height:auto;">`
    : `<div style="font:700 22px/1.2 Helvetica,Arial,sans-serif;color:${NAVY};">Verigence VINeeti</div>`;
  const maker = w.jbr
    ? `<img src="cid:${JBR_CID}" width="180" alt="JBR Consulting" style="display:block;border:0;outline:none;text-decoration:none;width:180px;max-width:100%;height:auto;">`
    : `<div style="font:700 15px/1.3 Helvetica,Arial,sans-serif;color:${NAVY};letter-spacing:2px;">J B R &nbsp;C O N S U L T I N G</div>`;
  const row = (label: string, value: string, mono = false) =>
    `<tr>
       <td style="padding:6px 16px 6px 0;font:400 13px/1.5 Helvetica,Arial,sans-serif;color:${MUTED};white-space:nowrap;">${esc(label)}</td>
       <td style="padding:6px 0;font:${mono ? "700 16px/1.5 'SFMono-Regular',Consolas,'Liberation Mono',monospace" : "600 14px/1.5 Helvetica,Arial,sans-serif"};color:${INK};">${esc(value)}</td>
     </tr>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background:#f4f7f9;">
  <!-- Shown by a mail list before the message is opened, so the first line is not the greeting. -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(lead)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f7f9;">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:#ffffff;border:1px solid ${LINE};border-radius:10px;">
        <tr><td align="center" style="padding:28px 28px 8px;">${logo}</td></tr>
        <tr><td style="padding:0 28px;"><div style="height:3px;background:${TEAL};border-radius:2px;"></div></td></tr>
        <tr><td style="padding:24px 28px 0;">
          <h1 style="margin:0 0 12px;font:600 20px/1.3 Helvetica,Arial,sans-serif;color:${NAVY};">${esc(heading)}</h1>
          <p style="margin:0 0 16px;font:400 15px/1.6 Helvetica,Arial,sans-serif;color:${INK};">Dear ${esc(w.name)},</p>
          <p style="margin:0 0 20px;font:400 15px/1.6 Helvetica,Arial,sans-serif;color:${INK};">${esc(lead)}</p>
        </td></tr>
        <tr><td style="padding:0 28px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f7fafb;border:1px solid ${LINE};border-radius:8px;">
            <tr><td style="padding:16px 20px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                ${row("Dealership", w.dealership)}
                ${row("Your role", w.roleLabel)}
                ${row("Sign in with", prettyMobile(w.mobile))}
                ${row("Temporary password", w.password, true)}
              </table>
            </td></tr>
          </table>
        </td></tr>
        <tr><td align="center" style="padding:24px 28px 8px;">
          <a href="${esc(w.signInUrl)}" style="display:inline-block;padding:12px 28px;background:${NAVY};color:#ffffff;font:600 15px/1 Helvetica,Arial,sans-serif;text-decoration:none;border-radius:6px;">Sign in to VINeeti</a>
        </td></tr>
        <tr><td align="center" style="padding:0 28px 20px;">
          <p style="margin:0;font:400 12px/1.6 Helvetica,Arial,sans-serif;color:${MUTED};word-break:break-all;">${esc(w.signInUrl)}</p>
        </td></tr>
        <tr><td style="padding:0 28px 24px;">
          <p style="margin:0 0 12px;font:400 14px/1.6 Helvetica,Arial,sans-serif;color:${INK};">You will be asked to replace this password the first time you sign in. Nobody can read it back to you afterwards, so keep it until then and choose your own.</p>
          <p style="margin:0;font:400 14px/1.6 Helvetica,Arial,sans-serif;color:${INK};">${esc(closing)}</p>
        </td></tr>
        <tr><td style="padding:0 28px;"><div style="height:1px;background:${LINE};"></div></td></tr>
        <tr><td align="center" style="padding:16px 28px 4px;">
          <p style="margin:0;font:600 13px/1.5 Helvetica,Arial,sans-serif;color:${NAVY};">Verigence VINeeti &middot; Fair Allocation. Smarter Inventory.</p>
        </td></tr>
        <!-- Whose product this is, given its own band at the foot rather than a line of small print. -->
        <tr><td align="center" style="padding:4px 28px 0;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:420px;">
            <tr>
              <td style="width:33%;"><div style="height:1px;background:${LINE};"></div></td>
              <td style="padding:0 12px;white-space:nowrap;font:700 11px/1.4 Helvetica,Arial,sans-serif;color:${MUTED};letter-spacing:1.4px;text-transform:uppercase;">A product by</td>
              <td style="width:33%;"><div style="height:1px;background:${LINE};"></div></td>
            </tr>
          </table>
        </td></tr>
        <tr><td align="center" style="padding:12px 28px 4px;">${maker}</td></tr>
        <tr><td align="center" style="padding:0 28px 24px;">
          <p style="margin:0;font:400 12px/1.5 Helvetica,Arial,sans-serif;color:${MUTED};">This message was sent by the system; nobody can reply to it.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function text(heading: string, lead: string, w: Welcome, closing: string): string {
  return (
    `${heading}\n\n` +
    `Dear ${w.name},\n\n` +
    `${lead}\n\n` +
    `Dealership: ${w.dealership}\n` +
    `Your role: ${w.roleLabel}\n` +
    `Sign in with: ${prettyMobile(w.mobile)}\n` +
    `Temporary password: ${w.password}\n\n` +
    `Sign in at ${w.signInUrl}\n\n` +
    `You will be asked to replace this password the first time you sign in. Nobody can read it back to you afterwards, so keep it until then and choose your own.\n\n` +
    `${closing}\n\n` +
    `--\nVerigence VINeeti. Fair Allocation. Smarter Inventory.\nA PRODUCT BY JBR CONSULTING. Insight. Strategy. Impact.\nThis message was sent by the system; nobody can reply to it.`
  );
}

function withLogo(w: Welcome): Pick<Message, "images"> {
  const images: Record<string, Uint8Array> = {};
  if (w.logo) images[LOGO_CID] = w.logo;
  if (w.jbr) images[JBR_CID] = w.jbr;
  return Object.keys(images).length ? { images } : {};
}

export function welcomeMail(w: Welcome): Message {
  const heading = `Welcome to Verigence VINeeti`;
  const lead = `An account has been created for you at ${w.dealership}. Here is what you need to sign in for the first time.`;
  const closing = `If you were not expecting this, tell your System Admin and do not sign in.`;
  return {
    to: "",
    subject: `Your ${w.dealership} sign-in for Verigence VINeeti`,
    body: text(heading, lead, w, closing),
    html: page({ heading, lead, w, closing }),
    ...withLogo(w),
  };
}

export function resetMail(w: Welcome): Message {
  const heading = `Your password has been reset`;
  const lead = `An administrator has reset your password at ${w.dealership}. Any session you had open has been signed out.`;
  const closing = `If you did not ask for this, tell your System Admin at once.`;
  return {
    to: "",
    subject: `A new password for your ${w.dealership} sign-in`,
    body: text(heading, lead, w, closing),
    html: page({ heading, lead, w, closing }),
    ...withLogo(w),
  };
}
