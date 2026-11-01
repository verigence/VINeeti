// Telling a person how to get in. Three things are being tested: that an account cannot be made
// without somewhere to send the password, that a deployment with no mail account still works exactly
// as it did before email existed, and that what is written to the person carries what they need.
import { describe, expect, it } from "vitest";
import { bodyToHtml, SmtpMailer } from "../src/lib/mailer";
import { deadPort, silentServer } from "./stubs/cloudflare-sockets";
import { introMail, resetMail, testMail, welcomeMail } from "../src/domain/mail-templates";
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

describe("whether mail works at all is answerable without creating a user", () => {
  it("says there is no mail account, says when an address is missing, and reports the server's own reason", async () => {
    const w = makeWorld();
    const d = await makeMahindraDealer(w);

    // Nothing configured: the honest answer, not an attempt that fails.
    const none = await w.api("POST", "/api/mail/test", {}, d.users.admin.session);
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({ configured: false, sent: false, reason: "MAIL_NOT_CONFIGURED" });
    expect(none.body.host).toBe("smtp.gmail.com");
    expect(none.body.port).toBe(587);

    // Configured, and the only socket a test run has refuses: the reason comes back, not a shrug.
    // An address is given, because the dealership's first administrator is created without one.
    w.env.SMTP_USER = "jbrconsulting.it@example";
    w.env.SMTP_PASSWORD = "app-password";
    w.env.SMTP_FROM = "no-reply@jbr.example";
    const failed = await w.api("POST", "/api/mail/test", { to: "amit@aditya.example" }, d.users.admin.session);
    expect(failed.body).toMatchObject({ configured: true, sent: false, reason: "MAIL_UNAVAILABLE", account: "no-reply@jbr.example" });
    expect(JSON.stringify(failed.body)).not.toContain("app-password");
    expect(w.db.q<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'MAIL_TEST_FAILED'`)[0].n).toBe(1);

    // An address it cannot write to is a different answer again.
    const away = await w.api("POST", "/api/mail/test", { to: "not-an-address" }, d.users.admin.session);
    expect(away.status).toBe(400);
    expect(away.body).toMatchObject({ configured: true, sent: false, reason: "NO_EMAIL" });

    // And it is the administrator's to run, nobody else's.
    expect((await w.api("POST", "/api/mail/test", {}, d.users.gm.session)).status).toBe(403);
  });

  it("records what happened to every sign-in message, so a message that never arrived can be told from one never sent", async () => {
    const w = makeWorld();
    const d = await makeMahindraDealer(w);
    // With no mail account the attempt is impossible, and that is written down rather than left blank.
    const made = await w.api("POST", "/api/users", { name: "Paper Trail", mobile: "9100000055", email: "trail@aditya.example", role: "SALES_LEAD", all_outlets: true }, d.users.admin.session);
    expect(made.status).toBe(201);
    const row = w.db.q<{ detail_json: string }>(`SELECT detail_json FROM audit_log WHERE action = 'SIGNIN_EMAIL_FAILED' AND entity_id = ?`, made.body.id);
    expect(row.length).toBe(1);
    expect(row[0].detail_json).toContain("MAIL_NOT_CONFIGURED");
    // No alert for it: the password went to the screen, so there is nothing for anybody to act on.
    expect(w.db.q<{ n: number }>(`SELECT COUNT(*) AS n FROM alerts WHERE kind = 'MAIL_FAILED'`)[0].n).toBe(0);
  });

  it("writes a test message that carries no password and says it is a test", () => {
    const m = testMail({ name: "Asha Admin", dealership: "Aditya Motors", roleLabel: "System Admin", mobile: "919000000001", password: "", signInUrl: "https://vineeti.example", account: "no-reply@jbr.example", at: "2026-11-01T02:30:00.000Z" });
    expect(m.subject).toContain("Test message");
    for (const part of ["Asha Admin", "Aditya Motors", "no-reply@jbr.example"]) {
      expect(m.body, `text: ${part}`).toContain(part);
      expect(m.html, `html: ${part}`).toContain(part);
    }
    // Nothing about replacing a password, because it carries none.
    expect(m.body).not.toContain("Temporary password");
    expect(m.html).not.toContain("Temporary password");
    expect(m.body).not.toContain("replace this password");
    expect(m.body).toContain("A PRODUCT BY JBR CONSULTING");
  });
});

describe("a mail server that never answers", () => {
  const account = { host: "smtp.gmail.com", port: 587, user: "it@example", password: "secret", from: "it@example", fromName: "VINeeti" };
  const message = { to: "someone@example.com", subject: "Hello", body: "Hello" };

  it("gives up, instead of waiting for ever, and says which step it died at", async () => {
    // This is the failure that left no trace at all: the screen span, the background send was killed
    // by the runtime part way through, and neither an alert nor an audit line was ever written.
    const reset = silentServer();
    try {
      const err = await new SmtpMailer(account).send(message).then(() => null, (e) => e);
      expect(err).toBeTruthy();
      expect(err.code).toBe("MAIL_TIMED_OUT");
      expect(err.stage).toBe("greeting");
      expect(err.message).toContain("did not answer");
    } finally {
      reset();
    }
  }, 30_000);

  it("says so when the connection is never made at all, which is not a password problem", async () => {
    const reset = deadPort();
    try {
      const err = await new SmtpMailer(account).send(message).then(() => null, (e) => e);
      expect(err.code).toBe("MAIL_TIMED_OUT");
      expect(err.stage).toBe("connect");
    } finally {
      reset();
    }
  }, 30_000);
});

describe("the introduction to the system", () => {
  it("goes when the temporary password is replaced, and not with the password itself", async () => {
    const w = makeWorld();
    const d = await makeMahindraDealer(w);
    w.env.SMTP_USER = "jbrconsulting.it@example";
    w.env.SMTP_PASSWORD = "app-password";

    const made = await w.api("POST", "/api/users", { name: "New Joiner", mobile: "9100000044", email: "joiner@aditya.example", role: "SALES_CONSULTANT", all_outlets: true }, d.users.admin.session);
    expect(made.status).toBe(201);
    // Creating the account writes to them about signing in, and says nothing about what the tool is for.
    expect(w.db.q<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'INTRO_EMAIL%'`)[0].n).toBe(0);

    // The temporary password is theirs to replace, and replacing it is the moment they are properly in.
    const given = w.db.q<{ id: string }>(`SELECT id FROM users WHERE mobile = '919100000044'`)[0].id;
    const reset = await w.api("POST", `/api/users/${given}/reset-password`, undefined, d.users.admin.session);
    const session = await w.login(d.slug, "9100000044", reset.body.temporary_password);
    const changed = await w.api("POST", "/api/auth/change-password", { current: reset.body.temporary_password, next: "TheirOwn1234" }, session);
    expect(changed.status).toBe(200);
    const intro = w.db.q<{ action: string; detail_json: string }>(`SELECT action, detail_json FROM audit_log WHERE action LIKE 'INTRO_EMAIL%' AND entity_id = ?`, given);
    expect(intro.length).toBe(1);
    expect(intro[0].detail_json).toContain("joiner@aditya.example");

    // And not again on a later password change: it is an introduction, not a notification.
    const fresh = { cookie: changed.headers.get("Set-Cookie")!.split(";")[0] };
    expect((await w.api("POST", "/api/auth/change-password", { current: "TheirOwn1234", next: "Another12345" }, fresh)).status).toBe(200);
    expect(w.db.q<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'INTRO_EMAIL%' AND entity_id = ?`, given)[0].n).toBe(1);
  });

  it("says what the system is for, what this person's part in it is, and thanks them — and carries no password", () => {
    const m = introMail({ name: "Arun AGM", dealership: "Aditya Motors", roleLabel: "AGM Sales", rolePurpose: "You raise allocation and deallocation requests for your segment. A GM or the CEO approves them.", mobile: "919876500001", password: "", signInUrl: "https://vineeti.example" });
    expect(m.subject).toContain("Welcome to Verigence VINeeti");
    expect(m.subject).toContain("Aditya Motors");
    for (const part of ["Arun AGM", "Aditya Motors", "AGM Sales", "You raise allocation and deallocation requests", "Thank you for choosing Verigence VINeeti"]) {
      expect(m.body, `text: ${part}`).toContain(part);
      expect(m.html, `html: ${part}`).toContain(part);
    }
    // What it does, in the dealership's own terms.
    for (const point of ["in stock and in transit", "priority rules the dealership has set", "recorded against the person and the time", "loaded daily"]) {
      expect(m.body, `point: ${point}`).toContain(point);
      expect(m.html, `point: ${point}`).toContain(point);
    }
    // Nothing secret travels in it, so a copy left open on a screen gives nothing away.
    expect(m.body).not.toContain("Temporary password");
    expect(m.body).not.toContain("replace this password");
    expect(m.html).not.toContain("Temporary password");
    expect(m.body).toContain("A PRODUCT BY JBR CONSULTING");
  });
});
