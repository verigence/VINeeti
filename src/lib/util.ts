export class HttpError extends Error {
  constructor(public status: number, message: string, public code = "ERROR") {
    super(message);
  }
}
export const bad = (message: string, code = "BAD_REQUEST") => new HttpError(400, message, code);
export const forbidden = (message = "You do not have permission to do this") => new HttpError(403, message, "FORBIDDEN");
export const notFound = (what = "Record") => new HttpError(404, `${what} not found`, "NOT_FOUND");
export const conflict = (message: string) => new HttpError(409, message, "CONFLICT");

export function newId(prefix: string): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return `${prefix}_${s}`;
}

export const iso = (d: Date) => d.toISOString();

/** Local calendar date (YYYY-MM-DD) and time (HH:MM) of an instant in an IANA timezone. */
export function localParts(d: Date, timeZone: string): { date: string; time: string } {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(d)) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** UTC instants bounding a local calendar day. India has no daylight saving, but this stays correct elsewhere too. */
export function localDayBounds(date: string, timeZone: string): { start: string; end: string } {
  const guess = new Date(`${date}T00:00:00Z`);
  // Find the offset by asking what local time the UTC-midnight guess is.
  const asLocal = localParts(guess, timeZone);
  const localAsUtc = new Date(`${asLocal.date}T${asLocal.time}:00Z`);
  const offsetMs = localAsUtc.getTime() - guess.getTime();
  const start = new Date(guess.getTime() - offsetMs);
  return { start: start.toISOString(), end: new Date(start.getTime() + 86_400_000).toISOString() };
}

export function daysBetween(fromIso: string, to: Date): number {
  return (to.getTime() - new Date(fromIso).getTime()) / 86_400_000;
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Model / variant / colour are matched case-insensitively with collapsed spaces. */
export function norm(s: unknown): string {
  return String(s ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

/** Indian mobile numbers to WhatsApp format: digits only with country code, e.g. 919876543210. */
export function normMobile(raw: unknown): string | null {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (d.length === 10) d = "91" + d;
  if (d.length < 11 || d.length > 15) return null;
  return d;
}

export function parseDate(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/.exec(s); // Indian day-first format
  if (m) return valid(+m[3], +m[2], +m[1]);
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  m = /^(\d{1,2})[\s\-]([A-Za-z]{3})[A-Za-z]*[\s\-](\d{4})/.exec(s);
  if (m) {
    const mi = months.indexOf(m[2].toLowerCase());
    if (mi >= 0) return valid(+m[3], mi + 1, +m[1]);
  }
  return null;
  function valid(y: number, mo: number, d: number): string | null {
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return dt.toISOString().slice(0, 10);
  }
}

/** Accepts a date or a date-time; returns an ISO instant. Date-only values are read as local midnight in IST. */
export function parseDateTime(raw: unknown, timeZone = "Asia/Kolkata"): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  // "2026-10-13T10:30" with no zone (what a browser's date-time field sends) is local time at the dealership.
  const date = parseDate(s);
  if (!date) return null;
  const tm = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(s.replace(/^\d{4}-\d{2}-\d{2}T/, "x ").replace(/^\S+/, ""));
  let h = 0,
    mi = 0;
  if (tm) {
    h = +tm[1];
    mi = +tm[2];
    if (tm[4]) {
      const pm = tm[4].toUpperCase() === "PM";
      if (pm && h < 12) h += 12;
      if (!pm && h === 12) h = 0;
    }
  }
  const { start } = localDayBounds(date, timeZone);
  return new Date(new Date(start).getTime() + (h * 60 + mi) * 60_000).toISOString();
}

/** Search text for a LIKE pattern: wildcards removed and kept short (D1 refuses patterns over 50 bytes). */
export function likeText(s: string): string {
  let out = s.replace(/[%_]/g, "").trim();
  while (new TextEncoder().encode(out).length > 40) out = out.slice(0, -1);
  return out;
}

export function safeJson<T>(s: string | null | undefined, fallback: T): T {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Minimal RFC 4180 CSV parser: quoted fields, embedded commas/newlines, BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows
    .map((r) =>
      r
        .map((v) => {
          let s = v === null || v === undefined ? "" : String(v);
          // Text that a spreadsheet would run as a formula is made inert.
          if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
          return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(","),
    )
    .join("\n");
}
