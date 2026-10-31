// Telling a person how to get in. Three things are being tested: that an account cannot be made
// without somewhere to send the password, that a deployment with no mail account still works exactly
// as it did before email existed, and that what is written to the person carries what they need.
import { describe, expect, it } from "vitest";
import { bodyToHtml } from "../src/lib/mailer";
import { resetMail, welcomeMail } from "../src/domain/mail-templates";
import { makeMahindraDealer, makeWorld, PASSWORD } from "./harness";

describe("an account has to have somewhere to send the password", () => {
  it("refuses a user with no address, or a malformed one, and says why", async () => {
    const w = makeWorld();
    const d = await makeMahindraDealer(w);
    const make = (email?: string) =>
      w.api("POST", "/api/users", { name: "No Address", mobile: "9100000088", ...(email === undefined ? {} : { email }), role: "SALES_CONSULTANT", password: PASSWORD, all_outlets: true }, d.users.admin.session);
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
    const made = await w.api("POST", "/api/users", { name: "Unsent Person", mobile: "9100000077", email: "unsent@aditya.example", role: "SALES_LEAD", password: PASSWORD, all_outlets: true }, d.users.admin.session);
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ emailed: false, email_error: "MAIL_NOT_CONFIGURED", email: "unsent@aditya.example" });
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

  it("carries the password, the dealership, the number they sign in with and where", () => {
    const m = welcomeMail(w);
    expect(m.subject).toContain("Aditya Motors");
    for (const part of [w.name, w.dealership, w.roleLabel, w.password, w.mobile, w.signInUrl]) expect(m.body).toContain(part);
    expect(m.body).toContain("replace this password the first time you sign in");
    // A reset says what happened and that sessions are gone, and never calls itself a welcome.
    const r = resetMail(w);
    expect(r.body).toContain("has been reset by an administrator");
    expect(r.body).toContain("signed out");
    expect(r.body).not.toContain("An account has been created");
  });

  it("escapes what it puts into the HTML, so a name can never carry markup into the message", () => {
    expect(bodyToHtml("Dear <b>x</b> & co\n\nSecond line")).toBe("<p>Dear &lt;b&gt;x&lt;/b&gt; &amp; co</p><p>Second line</p>");
    expect(bodyToHtml("one\ntwo")).toBe("<p>one<br>two</p>");
  });
});
