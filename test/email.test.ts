// Telling a person how to get in. Three things are being tested: that an account cannot be made
// without somewhere to send the password, that a deployment with no mail account still works exactly
// as it did before email existed, and that what is written to the person carries what they need.
import { describe, expect, it } from "vitest";
import { bodyToHtml } from "../src/lib/mailer";
import { resetMail, welcomeMail } from "../src/domain/mail-templates";
import { makeMahindraDealer, makeWorld } from "./harness";

describe("an account has to have somewhere to send the password", () => {
  it("refuses a user with no address, or a malformed one, and says why", async () => {
    const w = makeWorld();
    const d = await makeMahindraDealer(w);
    const make = (email?: string) =>
      w.api("POST", "/api/users", { name: "No Address", mobile: "9100000088", ...(email === undefined ? {} : { email }), role: "SALES_CONSULTANT", all_outlets: true }, d.users.admin.session);
    for (const bad of [undefined, "", "   ", "not-an-address", "who@nowhere"]) {
      const res = await make(bad);
      expect(res.status, String(bad)).toBe(400);
      expect(res.body.error.message).toContain("email address is required");
    }
    expect((await make("new.joiner@aditya.example")).status).toBe(201);
  });
});

describe("a deployment with no mail account", () => {
  it("still makes the account and still shows the password once, saying it was not sent", async () => {
    const w = makeWorld();
    const d = await makeMahindraDealer(w);
    const made = await w.api("POST", "/api/users", { name: "Unsent Person", mobile: "9100000077", email: "unsent@aditya.example", role: "SALES_LEAD", all_outlets: true }, d.users.admin.session);
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ emailed: false, email_error: "MAIL_NOT_CONFIGURED", email: "unsent@aditya.example" });
    // Nobody typed it: the server made it, and with nowhere to send it, it comes back this once.
    expect(made.body.temporary_password).toMatch(/^[a-z2-9]{10}$/);
    // And the same on a reset: the password comes back to be passed on by hand.
    const reset = await w.api("POST", `/api/users/${made.body.id}/reset-password`, undefined, d.users.admin.session);
    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({ emailed: false, email_error: "MAIL_NOT_CONFIGURED" });
    expect(reset.body.temporary_password).toMatch(/^[a-z2-9]{10}$/);
    // Nothing about the mail account is ever handed to a screen.
    expect(JSON.stringify(reset.body)).not.toContain("smtp");
  });
});

describe("what the person is told", () => {
  const w = { name: "Arun AGM", dealership: "Aditya Motors", roleLabel: "AGM Sales", mobile: "919876500001", password: "kiv7mq2pra", signInUrl: "https://vineeti.example" };

  it("carries the password, the dealership, the number they sign in with and where, in both parts", () => {
    const m = welcomeMail(w);
    expect(m.subject).toContain("Aditya Motors");
    // The number is written the way a person reads it, not the way it is stored.
    for (const part of [w.name, w.dealership, w.roleLabel, w.password, "91 98765 00001", w.signInUrl]) {
      expect(m.body, `text: ${part}`).toContain(part);
      expect(m.html, `html: ${part}`).toContain(part);
    }
    expect(m.body).toContain("replace this password the first time you sign in");
    expect(m.html).toContain("<!doctype html>");
    // A reset says what happened and that sessions are gone, and never calls itself a welcome.
    const r = resetMail(w);
    expect(r.body).toContain("has reset your password");
    expect(r.body).toContain("signed out");
    expect(r.body).not.toContain("An account has been created");
  });

  it("puts the logo inside the message when there is one, and manages without when there is not", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const withMark = welcomeMail({ ...w, logo: bytes });
    expect(withMark.images).toEqual({ "vineeti-logo": bytes });
    expect(withMark.html).toContain('src="cid:vineeti-logo"');
    const without = welcomeMail(w);
    expect(without.images).toBeUndefined();
    expect(without.html).not.toContain("cid:");
    expect(without.html).toContain("Verigence VINeeti");
  });

  it("escapes what it puts into the HTML, so a name can never carry markup into the message", () => {
    expect(bodyToHtml("Dear <b>x</b> & co\n\nSecond line")).toBe("<p>Dear &lt;b&gt;x&lt;/b&gt; &amp; co</p><p>Second line</p>");
    expect(bodyToHtml("one\ntwo")).toBe("<p>one<br>two</p>");
  });
});

describe("a deployment that can send", () => {
  it("answers before the message is sent, never hands the password to the screen, and says so when a send fails", async () => {
    const w = makeWorld();
    const d = await makeMahindraDealer(w);
    // Configured, but the only socket available in the tests refuses: the failure path is what is
    // under test here, and the success path cannot reach a mail server from a test run at all.
    w.env.SMTP_USER = "jbrconsulting.it@example";
    w.env.SMTP_PASSWORD = "app-password";

    const made = await w.api("POST", "/api/users", { name: "Told By Email", mobile: "9100000066", email: "told@aditya.example", role: "SALES_LEAD", all_outlets: true }, d.users.admin.session);
    expect(made.status).toBe(201);
    // The answer carries no password: this one is for the person who was written to, nobody else.
    expect(made.body).toMatchObject({ emailing: true, email: "told@aditya.example" });
    expect(made.body.temporary_password).toBeUndefined();
    expect(JSON.stringify(made.body)).not.toContain("app-password");

    // A send that failed is not silence: whoever made the account is told, and can try again.
    const alert = w.db.q<{ kind: string; title: string; body: string; target_user: string | null }>(`SELECT kind, title, body, target_user FROM alerts WHERE kind = 'MAIL_FAILED'`);
    expect(alert.length).toBe(1);
    expect(alert[0].title).toContain("Told By Email");
    expect(alert[0].body).toContain("Reset password");
    expect(alert[0].target_user).toBe(d.users.admin.id);
    expect(w.db.q<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'SIGNIN_EMAIL_FAILED' AND entity_id = ?`, made.body.id)[0].n).toBe(1);
    // The account is there regardless, and a reset hands over a password that can be passed on by hand.
    const reset = await w.api("POST", `/api/users/${made.body.id}/reset-password`, undefined, d.users.admin.session);
    expect(reset.status).toBe(200);
    expect(reset.body.temporary_password).toMatch(/^[a-z2-9]{10}$/);
    expect(reset.body.emailing).toBe(true);
  });
});
