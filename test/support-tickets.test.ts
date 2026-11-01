// Raising a ticket. The thing being protected here is that a person who cannot get a screen to work can
// always be heard — whatever their role — while one dealership's ticket, and the file attached to it,
// never reach another dealership.
import { describe, expect, it } from "vitest";
import { makeDealer, makeMahindraDealer, makeWorld, PLATFORM, type Session, type World } from "./harness";

/** The platform administrator, signed in to the console: the bearer token is the deployment's, not a person's. */
async function console_(w: World): Promise<Session> {
  const who = { mobile: "9800000001", name: "Platform Owner", password: "Platform@2026" };
  const made = await w.api("POST", "/api/platform/bootstrap", who, undefined, { Authorization: PLATFORM.Authorization });
  if (made.status >= 400) throw new Error(`no platform admin: ${JSON.stringify(made.body)}`);
  const res = await w.api("POST", "/api/platform/login", { mobile: who.mobile, password: who.password });
  if (res.status !== 200) throw new Error(`platform sign-in failed: ${JSON.stringify(res.body)}`);
  return { cookie: (res.headers.get("Set-Cookie") ?? "").split(";")[0] } as Session;
}

const form = (subject: string, body: string, file?: { name: string; type: string; bytes: Uint8Array }) => {
  const f = new FormData();
  f.set("subject", subject);
  f.set("body", body);
  if (file) f.set("file", new File([file.bytes], file.name, { type: file.type }));
  return f;
};
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const q = <T>(w: World, sql: string, ...p: unknown[]) => w.db.q<T>(sql, ...p);

describe("anybody who uses the system can raise a ticket", () => {
  it("takes a ticket with a file, keeps it for the person who raised it, and tells support", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    // A sales consultant: the least privileged person there is, and exactly who needs to be heard.
    const made = await w.upload("/api/support/tickets", form("Cannot see the Thar", "The Availability screen shows no Thar at Patia, but we have two in transit.", { name: "screen shot.png", type: "image/png", bytes: png }), d.users.se1.session);
    expect(made.status).toBe(201);
    expect(made.body.attachment_name).toBe("screen shot.png");

    const row = q<{ subject: string; status: string; raiser_name: string; raiser_role: string; attachment_key: string; attachment_size: number; emailed: number; email_error: string }>(
      w, `SELECT subject, status, raiser_name, raiser_role, attachment_key, attachment_size, emailed, email_error FROM support_tickets WHERE id = ?`, made.body.id)[0];
    expect(row.status).toBe("OPEN");
    expect(row.raiser_role).toBe("Sales Consultant");
    expect(row.attachment_size).toBe(png.length);
    // The file is in the bucket, under a key that names the dealership and the ticket.
    expect(w.files.objects.has(row.attachment_key)).toBe(true);
    expect(row.attachment_key).toContain(made.body.id);
    // Support could not be told on a deployment with no mail account, and that is on the ticket rather
    // than lost: it is the difference between "nobody answered" and "nobody was asked".
    expect(row.emailed).toBe(0);
    expect(row.email_error).toBe("MAIL_NOT_CONFIGURED");

    // Theirs to read back, with the file.
    const mine = await w.api("GET", "/api/support/tickets", undefined, d.users.se1.session);
    expect(mine.body.tickets.length).toBe(1);
    expect(mine.body.support_email).toBe("akanshchopra@gmail.com");
    const got = await w.api("GET", `/api/support/tickets/${made.body.id}/attachment`, undefined, d.users.se1.session);
    expect(got.status).toBe(200);
  });

  it("will not take a file that is too big or of a kind nobody asked for, and wants something to act on", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    const big = await w.upload("/api/support/tickets", form("Big", "A description.", { name: "huge.png", type: "image/png", bytes: new Uint8Array(11 * 1024 * 1024) }), d.users.se1.session);
    expect(big.status).toBe(400);
    expect(big.body.error.message).toContain("larger than 10 MB");
    const odd = await w.upload("/api/support/tickets", form("Odd", "A description.", { name: "run.exe", type: "application/x-msdownload", bytes: png }), d.users.se1.session);
    expect(odd.status).toBe(400);
    expect(odd.body.error.message).toContain("cannot be attached");
    // A subject with nothing behind it cannot be acted on without going back to ask.
    expect((await w.upload("/api/support/tickets", form("Help", "   "), d.users.se1.session)).status).toBe(400);
    expect((await w.upload("/api/support/tickets", form("", "Something is wrong."), d.users.se1.session)).status).toBe(400);
    expect(q<{ n: number }>(w, `SELECT COUNT(*) AS n FROM support_tickets`)[0].n).toBe(0);
    expect(w.files.objects.size).toBe(0);
  });

  it("shows a person their own tickets and nobody else's, including the attachment", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    const made = await w.upload("/api/support/tickets", form("Mine", "Only mine.", { name: "a.png", type: "image/png", bytes: png }), d.users.se1.session);
    const theirs = await w.api("GET", "/api/support/tickets", undefined, d.users.se2.session);
    expect(theirs.body.tickets.length).toBe(0);
    // Not even the file, and not even for a manager: it is support's to read, not the dealership's.
    expect((await w.api("GET", `/api/support/tickets/${made.body.id}/attachment`, undefined, d.users.se2.session)).status).toBe(404);
    expect((await w.api("GET", `/api/support/tickets/${made.body.id}/attachment`, undefined, d.users.sm.session)).status).toBe(404);
  });
});

describe("the platform administrator answers them", () => {
  it("sees every dealership's tickets, downloads what was attached, and closes one with a note", async () => {
    const w = makeWorld();
    const a = await makeDealer(w);
    const b = await makeMahindraDealer(w, "other-mahindra", "92000000");
    const one = await w.upload("/api/support/tickets", form("Allocation looks wrong", "The queue put a later booking first.", { name: "queue.csv", type: "text/csv", bytes: new TextEncoder().encode("booking,position\nB1,2\n") }), a.users.sm.session);
    const two = await w.upload("/api/support/tickets", form("Cannot upload stock", "The stock file is refused.", undefined), b.users.dp.session);
    expect(one.status).toBe(201);
    expect(two.status).toBe(201);

    const su = await console_(w);
    const list = await w.api("GET", "/api/platform/tickets", undefined, su);
    expect(list.status).toBe(200);
    expect(list.body.tickets.length).toBe(2);
    // Each one says which dealership it came from, which is the first thing support needs to know.
    expect(new Set(list.body.tickets.map((t: { dealership: string }) => t.dealership)).size).toBe(2);
    expect(list.body.counts.OPEN).toBe(2);
    expect(list.body.tickets[0].body).toBeTruthy();

    const file = await w.api("GET", `/api/platform/tickets/${one.body.id}/attachment`, undefined, su);
    expect(file.status).toBe(200);
    // A ticket raised without a file has nothing to fetch, and says so rather than failing oddly.
    expect((await w.api("GET", `/api/platform/tickets/${two.body.id}/attachment`, undefined, su)).status).toBe(404);

    const closed = await w.api("POST", `/api/platform/tickets/${one.body.id}/status`, { status: "CLOSED", note: "The rule was set to book date; corrected in settings." }, su);
    expect(closed.status).toBe(200);
    const after = q<{ status: string; closing_note: string; closed_at: string }>(w, `SELECT status, closing_note, closed_at FROM support_tickets WHERE id = ?`, one.body.id)[0];
    expect(after.status).toBe("CLOSED");
    expect(after.closing_note).toContain("corrected in settings");
    expect(after.closed_at).toBeTruthy();
    // And whoever raised it is told what came of it.
    const mine = await w.api("GET", "/api/support/tickets", undefined, a.users.sm.session);
    expect(mine.body.tickets[0].closing_note).toContain("corrected in settings");
    expect((await w.api("GET", "/api/platform/tickets?status=OPEN", undefined, su)).body.tickets.length).toBe(1);
  });

  it("is the only one who sees them all: a dealership's session cannot read the console's list", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    await w.upload("/api/support/tickets", form("Mine", "Only mine."), d.users.se1.session);
    expect((await w.api("GET", "/api/platform/tickets", undefined, d.users.admin.session)).status).toBe(401);
    expect((await w.api("GET", "/api/platform/tickets")).status).toBe(401);
  });
});
