// Getting people in: the mobile number is the ID. The administrator loads the employee list from an
// Excel sheet, or resets one person's password; once the dealership's WhatsApp number is live, anyone
// can set their own password with a one-time code sent to their mobile.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/index";
import { buildXlsx, readWorkbook, tableWith } from "../src/lib/xlsx";
import { loadBookings, loadStock, makeMahindraDealer, makeWorld, PASSWORD, type Dealer, type Session, type World } from "./harness";

const q = <T = any>(w: World, sql: string, ...p: unknown[]) => w.db.q<T>(sql, ...p);
const HEAD = ["Name", "Mobile", "Role", "Outlets", "DMS ID", "Email"];
const sheet = (rows: (string | number)[][]) => buildXlsx("Employees", [HEAD, ...rows]);
const importSheet = (w: World, d: Dealer, rows: (string | number)[][], by: Session = d.users.admin.session) => w.send("/api/users/import?filename=employees.xlsx", sheet(rows), by);
const user = (w: World, mobile: string) => q(w, `SELECT u.*, (SELECT GROUP_CONCAT(o.code) FROM user_outlets uo JOIN outlets o ON o.id = uo.outlet_id WHERE uo.user_id = u.id ORDER BY o.code) AS outlets FROM users u WHERE u.mobile = ?`, mobile)[0];

async function start(at = "2026-10-06 09:00"): Promise<{ w: World; d: Dealer }> {
  const w = makeWorld(at);
  const d = await makeMahindraDealer(w);
  // Two outlets, as the first stock report would create them.
  await loadStock(w, d.users.stock.session, [{ vin: "MA1THAR0000000001", car: "THAR_WHITE", loc: "SM01" }, { vin: "MA1THAR0000000002", car: "THAR_WHITE", loc: "SM02" }]);
  return { w, d };
}

/** Meta's API, as far as these tests need it: the number check when going live, and sending a template. Returns the one-time codes sent. */
function mockMeta(opts: { failSend?: boolean } = {}) {
  const sent: { to: string; code: string; body: any }[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (u.endsWith("/messages")) {
      const body = JSON.parse(String(init.body));
      if (opts.failSend) return json(400, { error: { message: "Template name does not exist in the translation", code: 132001 } });
      sent.push({ to: body.to, code: body.template.components[0].parameters[0].text, body });
      return json(200, { messaging_product: "whatsapp", messages: [{ id: `wamid.TEST${sent.length}` }] });
    }
    return json(200, { id: "106540352242922", display_phone_number: "+91 674 555 0100", verified_name: "Sample Motors" });
  });
  return sent;
}
const LIVE = { provider: "META", enabled: true, phone_number_id: "106540352242922", waba_id: "102290129340398", access_token: "EAAG-secret-token", app_secret: "app-secret-123", verify_token: "verify-me-123" };
afterEach(() => vi.unstubAllGlobals());

describe("the employee sheet", () => {
  it("creates everyone on the list with their mobile number as ID, role and outlets; each gets a temporary password shown once", async () => {
    const { w, d } = await start();
    const res = await importSheet(w, d, [
      ["Ravi Kumar", 9876500001, "Sales Executive", "SM01", "99AB0001", ""],
      ["Meena Sahu", "+91 98765 00002", "sales lead", "SM01, SM02", "", "meena@example.com"],
      ["Arun Das", "098765 00003", "CEO", "", "", ""],
      ["Anita Rath", "9876500004", "Finance Team", "ALL", "", ""],
      ["Charu Nayak", "9876500005", "CRM", "SM02", "", ""],
      ["Dinesh Patnaik", "9876500006", "DP", "", "", ""],
    ]);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ row_count: 6, unchanged: 0, errors: [], updated: [], otp_available: false });
    expect(res.body.created.map((c: any) => [c.name, c.mobile, c.role_label, c.outlets])).toEqual([
      ["Ravi Kumar", "919876500001", "Sales Executive", "SM01"],
      ["Meena Sahu", "919876500002", "Sales Lead", "SM01, SM02"],
      ["Arun Das", "919876500003", "Business Head / CEO", "All outlets"],
      ["Anita Rath", "919876500004", "Finance", "All outlets"],
      ["Charu Nayak", "919876500005", "CRM", "SM02"],
      ["Dinesh Patnaik", "919876500006", "Dealer Principal", "All outlets"],
    ]);
    for (const c of res.body.created) expect(c.temporary_password).toMatch(/^[a-z2-9]{10}$/);
    expect(new Set(res.body.created.map((c: any) => c.temporary_password)).size).toBe(6);
    expect(user(w, "919876500001")).toMatchObject({ role: "SALES_EXEC", all_outlets: 0, outlets: "SM01", dms_code: "99AB0001", must_change_password: 1 });
    expect(user(w, "919876500002")).toMatchObject({ role: "SALES_MANAGER", email: "meena@example.com" });
    expect(user(w, "919876500002").outlets.split(",").sort()).toEqual(["SM01", "SM02"]);
    // The password itself is stored only as a hash.
    expect(JSON.stringify(q(w, `SELECT * FROM users`))).not.toContain(res.body.created[0].temporary_password);
    expect(JSON.stringify(q(w, `SELECT * FROM audit_log`))).not.toContain(res.body.created[0].temporary_password);

    // Ravi signs in with his mobile number alone (no dealer code) and must set his own password before anything else.
    const ravi = await w.login("", "9876500001", res.body.created[0].temporary_password);
    expect((await w.api("GET", "/api/bookings", undefined, ravi)).body.error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    const changed = await w.api("POST", "/api/auth/change-password", { current: res.body.created[0].temporary_password, next: "Ravi@2026" }, ravi);
    expect(changed.status).toBe(200);
    const again = await w.login("", "98765 00001", "Ravi@2026");
    const me = (await w.api("GET", "/api/auth/me", undefined, again)).body;
    expect(me.user).toMatchObject({ name: "Ravi Kumar", role: "SALES_EXEC" });
    expect(me.outlets.map((o: any) => o.code)).toEqual(["SM01"]);
  });

  it("loading the sheet again changes nothing; an edited row updates the person and never their password", async () => {
    const { w, d } = await start();
    const rows: (string | number)[][] = [["Ravi Kumar", "9876500001", "Sales Executive", "SM01", "", ""], ["Meena Sahu", "9876500002", "Sales Lead", "SM01", "", ""]];
    const first = await importSheet(w, d, rows);
    const hash = user(w, "919876500001").password_hash;
    expect((await importSheet(w, d, rows)).body).toMatchObject({ created: [], updated: [], unchanged: 2, errors: [] });
    // Ravi is promoted and moves to both outlets.
    const next = await importSheet(w, d, [["Ravi Kumar", "9876500001", "Sales Lead", "SM01,SM02", "99AB0001", ""], rows[1]]);
    expect(next.body).toMatchObject({ created: [], unchanged: 1, errors: [] });
    expect(next.body.updated).toEqual([{ name: "Ravi Kumar", mobile: "919876500001", role_label: "Sales Lead", changes: ["role: Sales Executive to Sales Lead", "outlets: SM01, SM02", "DMS ID: 99AB0001"] }]);
    expect(user(w, "919876500001")).toMatchObject({ role: "SALES_MANAGER", dms_code: "99AB0001", password_hash: hash });
    expect((await w.login("", "9876500001", first.body.created[0].temporary_password)).cookie).toBeTruthy();
    // Nobody is removed or switched off because they are missing from a sheet.
    expect((await importSheet(w, d, [rows[1]])).body).toMatchObject({ unchanged: 1 });
    expect(user(w, "919876500001").is_active).toBe(1);
  });

  it("rows that cannot be applied are listed with the reason; the rest of the sheet is still loaded", async () => {
    const { w, d } = await start();
    const res = await importSheet(w, d, [
      ["Good Person", "9876500010", "Sales Executive", "SM01", "", ""],
      ["", "9876500011", "Sales Executive", "SM01", "", ""],
      ["Short Number", "98765", "Sales Executive", "SM01", "", ""],
      ["Odd Role", "9876500012", "Chief Happiness Officer", "SM01", "", ""],
      ["Wrong Outlet", "9876500013", "Sales Executive", "SM77", "", ""],
      ["No Outlet", "9876500014", "Sales Executive", "", "", ""],
      ["Same Number", "9876500010", "Finance", "ALL", "", ""],
      ["New Admin", "9876500015", "System Admin", "ALL", "", ""],
      ["Asha Admin", d.users.admin.mobile, "Finance", "ALL", "", ""],
      ["(example) Ravi Kumar", "9876543210", "Sales Executive", "AD01", "", ""],
    ]);
    expect(res.status).toBe(200);
    expect(res.body.created.map((c: any) => c.name)).toEqual(["Good Person"]);
    expect(res.body.errors.map((e: any) => [e.row, e.key, e.message])).toEqual([
      [3, "9876500011", "Name is blank"],
      [4, "Short Number", 'Mobile number "98765" is not valid'],
      [5, "Odd Role", 'Role "Chief Happiness Officer" is not recognised. Use one of: System Admin, Dealer Principal, Business Head / CEO, Sales Lead, Sales Executive, Finance, CRM, Stock In-charge, Ordering Desk, Auditor'],
      [6, "Wrong Outlet", "Outlet SM77 is not set up. Outlets here: SM01, SM02"],
      [7, "No Outlet", "Give the outlet codes this person works at, or ALL"],
      [8, "Same Number", "This mobile number appears more than once in the sheet"],
      [9, "New Admin", "An administrator is added on the Users screen, not by a sheet"],
      [10, "Asha Admin", "An administrator's role (and your own) is changed on the Users screen, not by a sheet"],
    ]);
    expect(q(w, `SELECT role FROM users WHERE id = ?`, d.users.admin.id)).toEqual([{ role: "ADMIN" }]);
    // A file that is not the employee sheet is refused whole; so is a load by anyone but the administrator.
    const wrong = await w.send("/api/users/import?filename=x.xlsx", buildXlsx("Sheet1", [["VIN", "Model"], ["X", "Y"]]), d.users.admin.session);
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.message).toContain("needs the headings Name, Mobile and Role");
    expect((await importSheet(w, d, [["A", "9876500020", "CRM", "ALL", "", ""]], d.users.head.session)).status).toBe(403);
  });

  it("the sheet to fill in lists the sales consultants the DMS names; giving them their DMS ID makes the DMS bookings theirs", async () => {
    const { w, d } = await start();
    await loadBookings(w, d.users.crm.session, [
      { no: "OTF27A000001", car: "THAR_WHITE", created: "01-Sep-2026 10:00 AM", sc: "CONSULTANT 001", scId: "99ZZ0001" },
      { no: "OTF27A000002", car: "THAR_WHITE", created: "02-Sep-2026 10:00 AM", sc: "CONSULTANT 002", scId: "99ZZ0002", loc: "SM02" },
      { no: "OTF27A000003", car: "SCORPIO_N", created: "03-Sep-2026 10:00 AM", sc: "CONSULTANT 001", scId: "99ZZ0001" },
    ]);
    const template = async () => {
      const res = await createApp().fetch(new Request("https://app.test/api/users/template", { headers: { Cookie: d.users.admin.session.cookie } }), w.env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Disposition")).toContain("employees.xlsx");
      const bytes = new Uint8Array(await res.arrayBuffer());
      const t = tableWith(await readWorkbook(bytes), ["Name", "Mobile", "Role"])!;
      return { bytes, t };
    };
    const { t } = await template();
    expect(t.header).toEqual(HEAD);
    expect(t.records.map((r) => [r["name"], r["mobile"] ?? "", r["role"], r["outlets"], r["dms id"]])).toEqual([
      ["CONSULTANT 001", "", "Sales Executive", "SM01", "99ZZ0001"],
      ["CONSULTANT 002", "", "Sales Executive", "SM02", "99ZZ0002"],
    ]);
    // The dealership adds the mobile numbers and loads the sheet.
    const res = await importSheet(w, d, [["CONSULTANT 001", "9876500031", "Sales Executive", "SM01", "99ZZ0001", ""], ["CONSULTANT 002", "9876500032", "Sales Executive", "SM02", "99ZZ0002", ""]]);
    expect(res.body.created).toHaveLength(2);
    const one = user(w, "919876500031");
    expect(q(w, `SELECT booking_no FROM bookings WHERE sales_exec_id = ? ORDER BY booking_no`, one.id).map((b) => b.booking_no)).toEqual(["OTF27A000001", "OTF27A000003"]);
    // They are users now, so the next sheet to fill in no longer lists them.
    expect((await template()).t.records.map((r) => r["name"])).toEqual(["(example) Ravi Kumar", "(example) Anita Das"]);
    // A DMS ID belongs to one person.
    const clash = await importSheet(w, d, [["Someone Else", "9876500033", "Sales Executive", "SM01", "99ZZ0001", ""]]);
    expect(clash.body.errors.map((e: any) => e.message)).toEqual(["DMS ID 99ZZ0001 is already given to another person"]);
  });
});

describe("the administrator resets a password", () => {
  it("gives a temporary password shown once, signs the person out everywhere and makes them set their own", async () => {
    const { w, d } = await start();
    const lead = d.users.lead;
    expect((await w.api("GET", "/api/auth/me", undefined, lead.session)).status).toBe(200);
    const res = await w.api("POST", `/api/users/${lead.id}/reset-password`, undefined, d.users.admin.session);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const temp = res.body.temporary_password;
    expect(temp).toMatch(/^[a-z2-9]{10}$/);
    // The old session and the old password stop working at once.
    expect((await w.api("GET", "/api/auth/me", undefined, { cookie: lead.session.cookie })).status).toBe(401);
    expect((await w.api("POST", "/api/auth/login", { mobile: lead.mobile, password: PASSWORD })).status).toBe(401);
    const s = await w.login("", lead.mobile, temp);
    expect((await w.api("GET", "/api/stock/summary", undefined, s)).body.error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    expect((await w.api("POST", "/api/auth/change-password", { current: temp, next: "Lead@2026" }, s)).status).toBe(200);
    expect(q(w, `SELECT action, actor, entity_id FROM audit_log WHERE action = 'PASSWORD_RESET_BY_ADMIN'`)).toEqual([{ action: "PASSWORD_RESET_BY_ADMIN", actor: d.users.admin.id, entity_id: lead.id }]);
    // Only the administrator can do this, and not on their own account (they change their own password from their profile).
    expect((await w.api("POST", `/api/users/${lead.id}/reset-password`, undefined, d.users.head.session)).status).toBe(403);
    expect((await w.api("POST", `/api/users/${d.users.admin.id}/reset-password`, undefined, d.users.admin.session)).status).toBe(400);
    expect((await w.api("POST", `/api/users/usr_unknown/reset-password`, undefined, d.users.admin.session)).status).toBe(404);
  });

  it("an account locked by wrong passwords is opened again by the reset", async () => {
    const { w, d } = await start();
    for (let i = 0; i < 5; i++) expect((await w.api("POST", "/api/auth/login", { mobile: d.users.exec.mobile, password: "wrong-password-1" })).status).toBe(401);
    expect((await w.api("POST", "/api/auth/login", { mobile: d.users.exec.mobile, password: PASSWORD })).status).toBe(401); // locked for 15 minutes
    const temp = (await w.api("POST", `/api/users/${d.users.exec.id}/reset-password`, undefined, d.users.admin.session)).body.temporary_password;
    expect((await w.api("POST", "/api/auth/login", { mobile: d.users.exec.mobile, password: temp })).status).toBe(200);
  });
});

describe("setting a password with a one-time code on WhatsApp", () => {
  it("is offered only once the dealership's WhatsApp number is live", async () => {
    const { w, d } = await start();
    const sent = mockMeta();
    expect((await w.api("GET", `/api/auth/options?mobile=${d.users.exec.mobile}`)).body).toEqual({ otp: false });
    const early = await w.api("POST", "/api/auth/otp/request", { mobile: d.users.exec.mobile });
    expect(early.status).toBe(400);
    expect(early.body.error).toMatchObject({ code: "OTP_NOT_AVAILABLE", message: "Setting a password with a WhatsApp code is not switched on for this dealership yet. Ask your administrator to reset your password." });
    expect(sent).toHaveLength(0);
    expect((await w.api("PUT", "/api/wa/config", LIVE, d.users.admin.session)).status).toBe(200);
    expect((await w.api("GET", `/api/auth/options?mobile=${d.users.exec.mobile}`)).body).toEqual({ otp: true });
    expect((await w.api("GET", `/api/auth/options?dealer=${d.slug}`)).body).toEqual({ otp: true });
  });

  it("the code goes to the person's own mobile, sets the password once, and is never stored or logged", async () => {
    const { w, d } = await start();
    const sent = mockMeta();
    await w.api("PUT", "/api/wa/config", LIVE, d.users.admin.session);
    const exec = d.users.exec;
    const asked = await w.api("POST", "/api/auth/otp/request", { mobile: exec.mobile });
    expect(asked.body).toEqual({ ok: true, message: "If this mobile number is registered, a 6-digit code has been sent to it on WhatsApp. It is valid for 10 minutes." });
    expect(sent).toHaveLength(1);
    const { code, body, to } = sent[0];
    expect(to).toBe(`91${exec.mobile}`);
    expect(code).toMatch(/^\d{6}$/);
    // Meta's authentication-template message: the code in the body and in the copy-code button.
    expect(body).toEqual({
      messaging_product: "whatsapp", recipient_type: "individual", to: `91${exec.mobile}`, type: "template",
      template: { name: "password_code", language: { code: "en" }, components: [{ type: "body", parameters: [{ type: "text", text: code }] }, { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] }] },
    });
    // Neither the database nor the message log holds the code.
    const everything = JSON.stringify([q(w, `SELECT * FROM password_otps`), q(w, `SELECT * FROM wa_messages`), q(w, `SELECT * FROM audit_log`)]);
    expect(everything).not.toContain(code);
    expect(q(w, `SELECT event_key, to_name, status, rendered_text FROM wa_messages WHERE event_key = 'PASSWORD_OTP'`)).toEqual([{ event_key: "PASSWORD_OTP", to_name: "Ravi Exec", status: "SENT", rendered_text: "One-time code to set a password (the code itself is not kept)" }]);

    // A wrong code does nothing. A weak password is refused before the code is looked at.
    const wrong = code === "000000" ? "000001" : "000000";
    const bad = await w.api("POST", "/api/auth/otp/reset", { mobile: exec.mobile, code: wrong, password: "Fresh@2026" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatchObject({ code: "INVALID_CODE", message: "The code is not correct or has expired. Ask for a new code." });
    expect((await w.api("POST", "/api/auth/otp/reset", { mobile: exec.mobile, code, password: "short" })).status).toBe(400);
    // The right code sets the password and signs the person in; every earlier session ends.
    const ok = await w.api("POST", "/api/auth/otp/reset", { mobile: exec.mobile, code, password: "Fresh@2026" });
    expect(ok.status).toBe(200);
    const cookie = (ok.headers.get("Set-Cookie") ?? "").split(";")[0];
    expect((await w.api("GET", "/api/auth/me", undefined, { cookie })).body.user).toMatchObject({ name: "Ravi Exec", mustChangePassword: false });
    expect((await w.api("GET", "/api/auth/me", undefined, { cookie: exec.session.cookie })).status).toBe(401);
    expect((await w.api("POST", "/api/auth/login", { mobile: exec.mobile, password: PASSWORD })).status).toBe(401);
    expect((await w.api("POST", "/api/auth/login", { mobile: exec.mobile, password: "Fresh@2026" })).status).toBe(200);
    // The same code cannot be used a second time.
    expect((await w.api("POST", "/api/auth/otp/reset", { mobile: exec.mobile, code, password: "Again@2026" })).status).toBe(400);
    expect(q(w, `SELECT action, actor FROM audit_log WHERE action IN ('PASSWORD_CODE_REQUESTED','PASSWORD_SET_WITH_CODE') ORDER BY at, action`)).toEqual([{ action: "PASSWORD_CODE_REQUESTED", actor: exec.id }, { action: "PASSWORD_SET_WITH_CODE", actor: exec.id }]);
  });

  it("a new employee from the sheet can set their first password with a code instead of the temporary one", async () => {
    const { w, d } = await start();
    const sent = mockMeta();
    await w.api("PUT", "/api/wa/config", LIVE, d.users.admin.session);
    const res = await importSheet(w, d, [["Ravi Kumar", "9876500001", "Sales Executive", "SM01", "", ""]]);
    expect(res.body.otp_available).toBe(true);
    await w.api("POST", "/api/auth/otp/request", { mobile: "9876500001" });
    const ok = await w.api("POST", "/api/auth/otp/reset", { mobile: "9876500001", code: sent[0].code, password: "Ravi@2026" });
    expect(ok.status).toBe(200);
    // The password is their own, so there is nothing left to change at sign-in.
    const s = await w.login("", "9876500001", "Ravi@2026");
    expect((await w.api("GET", "/api/stock/summary", undefined, s)).status).toBe(200);
    expect((await w.api("POST", "/api/auth/login", { mobile: "9876500001", password: res.body.created[0].temporary_password })).status).toBe(401);
  });

  it("a code expires after 10 minutes, dies after 5 wrong tries, and a newer code replaces an older one", async () => {
    const { w, d } = await start("2026-10-06 09:00");
    const sent = mockMeta();
    await w.api("PUT", "/api/wa/config", LIVE, d.users.admin.session);
    const m = d.users.lead.mobile;
    await w.api("POST", "/api/auth/otp/request", { mobile: m });
    w.at("2026-10-06 09:11");
    expect((await w.api("POST", "/api/auth/otp/reset", { mobile: m, code: sent[0].code, password: "Fresh@2026" })).status).toBe(400);
    // A second code; then a third, which replaces it.
    await w.api("POST", "/api/auth/otp/request", { mobile: m });
    w.at("2026-10-06 09:13");
    await w.api("POST", "/api/auth/otp/request", { mobile: m });
    expect(sent).toHaveLength(3);
    if (sent[1].code !== sent[2].code) expect((await w.api("POST", "/api/auth/otp/reset", { mobile: m, code: sent[1].code, password: "Fresh@2026" })).status).toBe(400);
    // Five wrong tries on the current code: after that even the right code is refused.
    w.db.raw.exec(`UPDATE password_otps SET attempts = 0`); // start the count from zero, whatever the line above tried
    const wrong = sent[2].code === "111111" ? "222222" : "111111";
    for (let i = 0; i < 5; i++) expect((await w.api("POST", "/api/auth/otp/reset", { mobile: m, code: wrong, password: "Fresh@2026" })).status).toBe(400);
    expect((await w.api("POST", "/api/auth/otp/reset", { mobile: m, code: sent[2].code, password: "Fresh@2026" })).status).toBe(400);
    expect((await w.api("POST", "/api/auth/login", { mobile: m, password: PASSWORD })).status).toBe(200); // the password was never changed
  });

  it("codes cannot be requested in a flood, and the answer never says whether a number is registered", async () => {
    const { w, d } = await start("2026-10-06 09:00");
    const sent = mockMeta();
    await w.api("PUT", "/api/wa/config", LIVE, d.users.admin.session);
    const m = d.users.finance.mobile;
    const ask = (mobile: string) => w.api("POST", "/api/auth/otp/request", { mobile });
    const first = await ask(m);
    // Asked again within a minute: same answer, nothing new sent, and the first code still works.
    expect((await ask(m)).body).toEqual(first.body);
    expect(sent).toHaveLength(1);
    // At most three codes in 15 minutes.
    w.at("2026-10-06 09:02");
    await ask(m);
    w.at("2026-10-06 09:04");
    await ask(m);
    w.at("2026-10-06 09:06");
    await ask(m);
    expect(sent).toHaveLength(3);
    w.at("2026-10-06 09:20");
    await ask(m);
    expect(sent).toHaveLength(4);
    // A number nobody has, and a switched-off user: the same answer, and no message.
    expect((await ask("9812345678")).body).toEqual(first.body);
    await w.api("PATCH", `/api/users/${d.users.crm.id}`, { is_active: false }, d.users.admin.session);
    expect((await ask(d.users.crm.mobile)).body).toEqual(first.body);
    expect(sent).toHaveLength(4);
    expect((await w.api("POST", "/api/auth/otp/reset", { mobile: "9812345678", code: "123456", password: "Fresh@2026" })).body.error.code).toBe("INVALID_CODE");
  });

  it("if WhatsApp does not accept the message, no code exists and the failure is in the message log", async () => {
    const { w, d } = await start();
    mockMeta();
    await w.api("PUT", "/api/wa/config", LIVE, d.users.admin.session);
    mockMeta({ failSend: true });
    expect((await w.api("POST", "/api/auth/otp/request", { mobile: d.users.exec.mobile })).status).toBe(200);
    expect(q(w, `SELECT COUNT(*) AS n FROM password_otps`)[0].n).toBe(0);
    const log = q(w, `SELECT status, error FROM wa_messages WHERE event_key = 'PASSWORD_OTP'`);
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe("FAILED");
    expect(log[0].error).toContain("Template name does not exist");
  });

  it("an administrator's reset cancels a code that is still out", async () => {
    const { w, d } = await start();
    const sent = mockMeta();
    await w.api("PUT", "/api/wa/config", LIVE, d.users.admin.session);
    await w.api("POST", "/api/auth/otp/request", { mobile: d.users.exec.mobile });
    await w.api("POST", `/api/users/${d.users.exec.id}/reset-password`, undefined, d.users.admin.session);
    expect((await w.api("POST", "/api/auth/otp/reset", { mobile: d.users.exec.mobile, code: sent[0].code, password: "Fresh@2026" })).status).toBe(400);
  });
});

describe("signing in with the mobile number", () => {
  it("needs the dealer code only when the same number is registered at two dealerships", async () => {
    const w = makeWorld("2026-10-06 09:00");
    const a = await makeMahindraDealer(w, "sample-mahindra", "91000000");
    const b = await makeMahindraDealer(w, "other-mahindra", "92000000");
    // A number at one dealership: no dealer code needed.
    expect((await w.api("POST", "/api/auth/login", { mobile: a.users.exec.mobile, password: PASSWORD })).status).toBe(200);
    // The same person is also a user at the second dealership.
    expect((await w.api("POST", "/api/users", { name: "Ravi Exec", mobile: a.users.exec.mobile, role: "SALES_EXEC", password: "Other@2026", all_outlets: true }, b.users.admin.session)).status).toBe(201);
    expect((await w.api("POST", "/api/auth/login", { mobile: a.users.exec.mobile, password: PASSWORD })).status).toBe(401);
    expect((await w.api("POST", "/api/auth/login", { dealer: "sample-mahindra", mobile: a.users.exec.mobile, password: PASSWORD })).status).toBe(200);
    expect((await w.api("POST", "/api/auth/login", { dealer: "other-mahindra", mobile: a.users.exec.mobile, password: "Other@2026" })).status).toBe(200);
    // One dealership's password never opens the other.
    expect((await w.api("POST", "/api/auth/login", { dealer: "other-mahindra", mobile: a.users.exec.mobile, password: PASSWORD })).status).toBe(401);
  });
});

describe("an outlet's address", () => {
  it("is kept with the outlet, and comes back with it", async () => {
    const w = makeWorld("2026-10-10 10:00");
    const d = await makeMahindraDealer(w);
    const made = await w.api("POST", "/api/outlets", { code: "AD99", name: "PURI", city: "Puri", address: "Nabakalebar Road, Kumbharapada, Puri, Odisha 752002" }, d.users.admin.session);
    expect(made.status).toBe(201);
    const list = await w.api("GET", "/api/outlets", undefined, d.users.admin.session);
    const puri = list.body.find((o: any) => o.code === "AD99");
    expect(puri).toMatchObject({ name: "PURI", city: "Puri", address: "Nabakalebar Road, Kumbharapada, Puri, Odisha 752002" });

    const changed = await w.api("PATCH", `/api/outlets/${puri.id}`, { address: "Near Atharanala, Puri" }, d.users.admin.session);
    expect(changed.status).toBe(200);
    const after = (await w.api("GET", "/api/outlets", undefined, d.users.admin.session)).body.find((o: any) => o.code === "AD99");
    expect(after).toMatchObject({ address: "Near Atharanala, Puri", name: "PURI", city: "Puri" });
  });

  it("is only an administrator's to set", async () => {
    const w = makeWorld("2026-10-10 10:00");
    const d = await makeMahindraDealer(w);
    const res = await w.api("POST", "/api/outlets", { code: "AD98", name: "NUAPATANA" }, d.users.exec.session);
    expect(res.status).toBe(403);
  });
});
