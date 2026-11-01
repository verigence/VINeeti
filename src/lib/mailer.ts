// Outgoing email, through the dealership group's own mail account (Gmail with an app password).
//
// The HR service (verigence/hrmgmt, src/hrmgmt/mailer.py) sends its mail the same way, from the same
// account, and this is deliberately its shape: one attempt per message and no retries, a failure
// reported with a short reason rather than hidden, and the body never written to a log. What differs
// is the plumbing. That service is Python and uses smtplib; a Worker has no such library, so the SMTP
// conversation is spoken here over a raw socket — EHLO, STARTTLS, AUTH LOGIN, MAIL FROM, RCPT TO,
// DATA. It is a small protocol and the part that matters is being strict about what the server says.
//
// Without an account configured nothing is sent and nothing fails: `mailer()` returns null, and every
// caller falls back to showing the temporary password on screen, as the system did before email.

import { connect } from "cloudflare:sockets";
import type { Env } from "../env";

/** A failure the person who pressed the button can be told about. Mirrors hrmgmt's MailError codes. */
export class MailError extends Error {
  constructor(
    public code: "MAIL_AUTH_FAILED" | "MAIL_RECIPIENT_REFUSED" | "MAIL_UNAVAILABLE" | "MAIL_TIMED_OUT",
    message: string,
    /** Where it went wrong: connect, greeting, hello, starttls, login, sender, recipient, data. */
    public stage = "",
  ) {
    super(message);
  }
}

// A mail server that takes a connection and then says nothing would otherwise be waited for forever:
// the screen spins, a background send is killed by the runtime part way through, and nothing is written
// down either way — which is how a message can go missing leaving no trace at all. Every step is given
// a deadline, so a silence becomes an answer naming the step it died at.
const STEP_MS = 8_000;
const TOTAL_MS = 25_000;

/** The promise, or a failure naming the step it gave up on. */
function withDeadline<T>(p: Promise<T>, ms: number, stage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new MailError("MAIL_TIMED_OUT", `The mail server did not answer at ${stage} within ${Math.round(Math.max(1, ms) / 1000)} seconds`, stage)), Math.max(1, ms));
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

export interface Message {
  to: string;
  subject: string;
  /** The plain-text body. An HTML alternative is made from it when none is given. */
  body: string;
  html?: string;
  /** Pictures that ride inside the message, by the id the HTML refers to as `cid:`. */
  images?: Record<string, Uint8Array>;
}

export interface Mailer {
  send(m: Message): Promise<void>;
}

const CRLF = "\r\n";
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

/** The plain-text body as simple HTML: escaped, paragraphs kept, nothing turned into a link. */
export function bodyToHtml(body: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return body
    .replace(/\r\n/g, "\n")
    .split("\n\n")
    .filter((p) => p.trim())
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** A line of the message body that begins with a dot would end it, so it is doubled (RFC 5321). */
const dotStuff = (s: string) => s.replace(/\r\n/g, "\n").split("\n").map((l) => (l.startsWith(".") ? `.${l}` : l)).join(CRLF);

/** A picture as base64, wrapped at 76 characters the way a mail body wants it. */
function base64Lines(bytes: Uint8Array): string {
  let raw = "";
  for (let i = 0; i < bytes.length; i += 0x8000) raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return (btoa(raw).match(/.{1,76}/g) ?? []).join(CRLF);
}

function mime(from: string, m: Message, now: Date): string {
  const tag = `${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const outer = `alt${tag}`;
  const related = `rel${tag}`;
  // A subject may carry anything; encoded-word keeps a non-ASCII one readable rather than mangled.
  const subject = /^[\x20-\x7E]*$/.test(m.subject) ? m.subject : `=?UTF-8?B?${b64(m.subject)}?=`;
  const images = Object.entries(m.images ?? {});
  const html = dotStuff(m.html ?? bodyToHtml(m.body));
  // The HTML and the pictures it names travel together inside the alternative, so a reader that
  // shows the plain text never downloads them and one that shows the HTML never has to fetch them.
  const htmlPart = images.length
    ? [
        `Content-Type: multipart/related; boundary="${related}"`,
        "",
        `--${related}`,
        `Content-Type: text/html; charset=UTF-8`,
        "",
        html,
        ...images.flatMap(([cid, bytes]) => [
          `--${related}`,
          `Content-Type: image/png`,
          `Content-Transfer-Encoding: base64`,
          `Content-ID: <${cid}>`,
          `Content-Disposition: inline; filename="${cid}.png"`,
          "",
          base64Lines(bytes),
        ]),
        `--${related}--`,
      ]
    : [`Content-Type: text/html; charset=UTF-8`, "", html];
  return [
    `From: ${from}`,
    `To: ${m.to}`,
    `Subject: ${subject}`,
    `Date: ${now.toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${outer}"`,
    "",
    `--${outer}`,
    `Content-Type: text/plain; charset=UTF-8`,
    "",
    dotStuff(m.body),
    `--${outer}`,
    ...htmlPart,
    `--${outer}--`,
    "",
  ].join(CRLF);
}

/** Reads SMTP replies off a socket, a complete reply at a time ("250-first" lines continue, "250 last" ends). */
class Replies {
  private buffer = "";
  constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}
  async next(): Promise<{ code: number; text: string }> {
    for (;;) {
      const end = this.complete();
      if (end !== null) {
        const reply = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end);
        const code = Number(reply.slice(0, 3));
        return { code: Number.isFinite(code) ? code : 0, text: reply.trim() };
      }
      const { value, done } = await this.reader.read();
      if (done) throw new MailError("MAIL_UNAVAILABLE", "The mail server closed the connection");
      this.buffer += new TextDecoder().decode(value);
    }
  }
  /** Where the reply ends, or null while more is still to come. */
  private complete(): number | null {
    let at = 0;
    for (;;) {
      const nl = this.buffer.indexOf(CRLF, at);
      if (nl === -1) return null;
      if (this.buffer[at + 3] !== "-") return nl + 2;
      at = nl + 2;
    }
  }
}

export interface SmtpAccount {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
  fromName: string;
}

export class SmtpMailer implements Mailer {
  constructor(private account: SmtpAccount, private now: () => Date = () => new Date()) {}

  async send(m: Message): Promise<void> {
    const a = this.account;
    let stage = "connect";
    const until = Date.now() + TOTAL_MS;
    const left = () => Math.min(STEP_MS, until - Date.now());
    // A failure says where it happened, so a blocked network can be told from a refused account.
    // The message body is never part of what is logged.
    const fail = (e: unknown): never => {
      if (e instanceof MailError) throw e;
      console.warn("mail failed", { stage, host: a.host, port: a.port, detail: String((e as Error)?.message ?? e).slice(0, 160) });
      throw new MailError("MAIL_UNAVAILABLE", `The mail server could not be reached at ${stage}`, stage);
    };
    let socket: Awaited<ReturnType<typeof connect>> | null = null;
    try {
      // Port 465 is encrypted from the first byte; every other port is upgraded with STARTTLS.
      const implicit = a.port === 465;
      socket = connect({ hostname: a.host, port: a.port }, { secureTransport: implicit ? "on" : "starttls", allowHalfOpen: false });
      // Whether a connection was made at all is only known by asking: without this, a port that goes
      // nowhere looks exactly like a server taking its time, and both wait for ever.
      await withDeadline(socket.opened, left(), "connect");
      let writer = socket.writable.getWriter();
      let reader = socket.readable.getReader();
      let replies = new Replies(reader);
      const enc = new TextEncoder();
      const say = async (line: string) => withDeadline(writer.write(enc.encode(line + CRLF)), left(), stage);
      const expect = async (want: number[], where: string) => {
        const r = await withDeadline(replies.next(), left(), where);
        if (!want.includes(r.code)) {
          if (r.code === 535 || r.code === 534) throw new MailError("MAIL_AUTH_FAILED", "The mail account refused the sign-in", where);
          // Gmail refuses a MAIL FROM that the signed-in account does not own, which is a different
          // mistake from a bad recipient and has a different fix: correct SMTP_FROM, not the address.
          if (r.code === 550 || r.code === 553 || r.code === 551) throw new MailError("MAIL_RECIPIENT_REFUSED", where === "sender" ? "The mail account is not allowed to send as this address" : "The address was refused", where);
          throw new MailError("MAIL_UNAVAILABLE", `The mail server refused the message at ${where} (${r.text.slice(0, 120)})`, where);
        }
        return r;
      };

      await expect([220], "greeting");
      stage = "hello";
      await say(`EHLO ${a.host}`);
      await expect([250], "hello");
      if (!implicit) {
        stage = "starttls";
        await say("STARTTLS");
        await expect([220], "starttls");
        // From here the same connection is encrypted; its reader and writer are new. The old pair dies
        // with the original socket, so their locks are given up before the upgrade.
        writer.releaseLock();
        reader.releaseLock();
        socket = socket.startTls();
        writer = socket.writable.getWriter();
        reader = socket.readable.getReader();
        replies = new Replies(reader);
        await say(`EHLO ${a.host}`);
        await expect([250], "hello");
      }
      stage = "login";
      await say("AUTH LOGIN");
      await expect([334], "login");
      await say(b64(a.user));
      await expect([334], "login");
      await say(b64(a.password));
      await expect([235], "login");
      stage = "send";
      await say(`MAIL FROM:<${a.from}>`);
      await expect([250], "sender");
      await say(`RCPT TO:<${m.to}>`);
      await expect([250, 251], "recipient");
      await say("DATA");
      await expect([354], "data");
      await withDeadline(writer.write(enc.encode(mime(`${a.fromName} <${a.from}>`, m, this.now()) + CRLF + "." + CRLF)), left(), "data");
      await expect([250], "data");
      stage = "quit";
      await say("QUIT");
      await writer.close().catch(() => undefined);
    } catch (e) {
      fail(e);
    } finally {
      await socket?.close().catch(() => undefined);
    }
  }
}

/**
 * The deployment's mail account, or null when none is set. The same account the HR service uses: its
 * app password is a Worker secret and never reaches the database or a screen.
 */
export function mailer(env: Env, now: () => Date = () => new Date()): Mailer | null {
  const user = (env.SMTP_USER ?? "").trim();
  const password = env.SMTP_PASSWORD ?? "";
  if (!user || !password) return null;
  return new SmtpMailer(
    {
      host: (env.SMTP_HOST ?? "").trim() || "smtp.gmail.com",
      port: Number(env.SMTP_PORT ?? "") || 587,
      user,
      password,
      from: (env.SMTP_FROM ?? "").trim() || user,
      fromName: (env.APP_NAME ?? "Verigence VINeeti").trim(),
    },
    now,
  );
}
