// Tickets raised by the people who use the system. A dealership cannot answer its own tickets — the
// point of one is that somebody outside it does — so a ticket is readable by whoever raised it and by
// the platform administrator, and by nobody else. Support is told by email as each one arrives.
//
// The attachment lives in object storage under a key that carries the dealership and the ticket, so a
// stray key cannot be guessed into another dealership's file, and the file is only ever served through
// a route that has already checked who is asking.

import type { Ctx, Env, Role } from "../env";
import { all, auditStmt, first, stmt } from "../lib/db";
import { MailError, mailer } from "../lib/mailer";
import { ROLE_LABELS } from "../lib/permissions";
import { bad, iso, newId } from "../lib/util";
import { ticketMail } from "./mail-templates";
import { emailMark } from "./onboarding";

/** What a person may attach. Deliberately short: a screenshot, a sheet, or the file that went wrong. */
const ALLOWED = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain", "text/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
export const ATTACHMENT_LIMIT = 10 * 1024 * 1024;

export interface TicketRow {
  id: string;
  subject: string;
  body: string;
  status: "OPEN" | "CLOSED";
  raiser_name: string;
  raiser_role: string;
  raiser_email: string | null;
  attachment_name: string | null;
  attachment_size: number | null;
  emailed: number;
  email_error: string | null;
  created_at: string;
  closed_at: string | null;
  closing_note: string | null;
}

export interface Attachment {
  name: string;
  type: string;
  bytes: Uint8Array;
}

/** Checks a file before anything is written: an unknown type or an oversized one is refused outright. */
export function checkAttachment(file: { name: string; type: string; size: number }): void {
  if (file.size > ATTACHMENT_LIMIT) throw bad(`The file is larger than ${Math.round(ATTACHMENT_LIMIT / (1024 * 1024))} MB`);
  if (!file.size) throw bad("The file is empty");
  const type = (file.type || "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED.includes(type)) throw bad("That kind of file cannot be attached. A screenshot, a PDF, a spreadsheet or a text file can.");
}

/**
 * Writes the ticket. The attachment goes to storage first: a ticket that names a file nobody can open
 * is worse than one that was refused, so if the write fails the ticket is not recorded at all.
 */
export async function raiseTicket(
  ctx: Ctx,
  user: { id: string; name: string; role: Role },
  input: { subject: string; body: string },
  attachment: Attachment | null,
): Promise<{ id: string; attachment_name: string | null }> {
  const subject = input.subject.trim();
  const body = input.body.trim();
  if (!subject) throw bad("Say in a line what the ticket is about");
  if (!body) throw bad("Describe what happened, so somebody can act on it without asking you first");
  if (subject.length > 150) throw bad("Keep the subject under 150 characters");
  if (body.length > 8000) throw bad("Keep the description under 8,000 characters");
  const id = newId("tkt");
  let key: string | null = null;
  if (attachment) {
    if (!ctx.env.FILES) throw bad("This deployment cannot take attachments yet. Raise the ticket without one and describe the file.");
    key = `tickets/${ctx.tenantId}/${id}/${attachment.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120)}`;
    await ctx.env.FILES.put(key, attachment.bytes, { httpMetadata: { contentType: attachment.type } });
  }
  const email = await first<{ email: string | null }>(ctx.db, `SELECT email FROM users WHERE id = ? AND tenant_id = ?`, user.id, ctx.tenantId);
  await ctx.db.batch([
    stmt(
      ctx.db,
      `INSERT INTO support_tickets (id, tenant_id, raised_by, raiser_name, raiser_role, raiser_email, subject, body, status, attachment_key, attachment_name, attachment_type, attachment_size, created_at)
       VALUES (?,?,?,?,?,?,?,?,'OPEN',?,?,?,?,?)`,
      id, ctx.tenantId, user.id, user.name, ROLE_LABELS[user.role], email?.email ?? null, subject, body,
      key, attachment?.name ?? null, attachment?.type ?? null, attachment?.bytes.length ?? null, iso(ctx.now),
    ),
    auditStmt(ctx, "TICKET_RAISED", "ticket", id, { subject, attachment: attachment?.name ?? null }),
  ]);
  return { id, attachment_name: attachment?.name ?? null };
}

/** Where a raised ticket is sent. Set per deployment; the product's own address otherwise. */
export function supportAddress(env: Env): string {
  return (env.SUPPORT_EMAIL ?? "").trim() || "akanshchopra@gmail.com";
}

/**
 * Tells support, after the answer has gone back: the person who raised it is not kept waiting on a mail
 * server, and whether it was sent is written on the ticket so a silence is visible rather than assumed.
 */
export async function notifySupport(ctx: Ctx, ticketId: string): Promise<void> {
  const t = await first<TicketRow & { tenant: string }>(
    ctx.db,
    `SELECT t.*, n.name AS tenant FROM support_tickets t JOIN tenants n ON n.id = t.tenant_id WHERE t.id = ? AND t.tenant_id = ?`,
    ticketId, ctx.tenantId,
  );
  if (!t) return;
  const post = mailer(ctx.env, () => ctx.now);
  const to = supportAddress(ctx.env);
  let error: string | null = post ? null : "MAIL_NOT_CONFIGURED";
  if (post) {
    const message = ticketMail({
      dealership: t.tenant,
      raiser: t.raiser_name,
      role: t.raiser_role,
      raiserEmail: t.raiser_email,
      subject: t.subject,
      body: t.body,
      attachment: t.attachment_name,
      at: t.created_at,
      consoleUrl: `${(ctx.env.APP_URL ?? "").replace(/\/+$/, "")}/platform#tickets`,
      logo: await emailMark(ctx.env, "email-logo.png"),
      jbr: await emailMark(ctx.env, "email-jbr.png"),
    });
    try {
      await post.send({ ...message, to });
    } catch (e) {
      error = e instanceof MailError ? e.code : "MAIL_UNAVAILABLE";
    }
  }
  await ctx.db
    .batch([
      stmt(ctx.db, `UPDATE support_tickets SET emailed = ?, email_error = ? WHERE id = ? AND tenant_id = ?`, error ? 0 : 1, error, ticketId, ctx.tenantId),
      auditStmt(ctx, error ? "TICKET_EMAIL_FAILED" : "TICKET_EMAIL_SENT", "ticket", ticketId, { to, ...(error ? { error } : {}) }),
    ])
    .catch(() => undefined);
}

/** The tickets this person raised, newest first. Nobody sees another person's ticket from here. */
export async function myTickets(ctx: Ctx, userId: string): Promise<TicketRow[]> {
  return all<TicketRow>(
    ctx.db,
    `SELECT id, subject, body, status, raiser_name, raiser_role, raiser_email, attachment_name, attachment_size, emailed, email_error, created_at, closed_at, closing_note
       FROM support_tickets WHERE tenant_id = ? AND raised_by = ? ORDER BY created_at DESC LIMIT 200`,
    ctx.tenantId, userId,
  );
}
