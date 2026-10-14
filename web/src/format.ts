// Dates, money and phone numbers, always shown the same way and in the dealership's own timezone.

let timeZone = "Asia/Kolkata";
let partsFormat: Intl.DateTimeFormat | null = null;

export function setTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    timeZone = tz;
  } catch {
    timeZone = "Asia/Kolkata";
  }
  partsFormat = null;
}

/** Dates, times and phone numbers are kept on one line: the parts are joined with non-breaking spaces. */
const NBSP = "\u00a0";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function partsOf(d: Date): Parts {
  partsFormat ??= new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p: Record<string, string> = {};
  for (const part of partsFormat.formatToParts(d)) p[part.type] = part.value;
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour) % 24, minute: Number(p.minute) };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 13 Oct 2026 */
export function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  const m = DATE_ONLY.exec(value);
  if (m) return `${Number(m[3])}${NBSP}${MONTHS[Number(m[2]) - 1] ?? "?"}${NBSP}${m[1]}`;
  const d = new Date(value);
  if (isNaN(d.getTime())) return value;
  const p = partsOf(d);
  return `${p.day}${NBSP}${MONTHS[p.month - 1]}${NBSP}${p.year}`;
}

/** 13 Oct 2026, 4:05 pm */
export function fmtDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  if (DATE_ONLY.test(value)) return fmtDate(value);
  const d = new Date(value);
  if (isNaN(d.getTime())) return value;
  const p = partsOf(d);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${p.day}${NBSP}${MONTHS[p.month - 1]}${NBSP}${p.year}, ${h12}:${pad(p.minute)}${NBSP}${p.hour < 12 ? "am" : "pm"}`;
}

/** 4:05 pm */
export function fmtTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return value;
  const p = partsOf(d);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${h12}:${pad(p.minute)}${NBSP}${p.hour < 12 ? "am" : "pm"}`;
}

/** "today 4:05 pm" for something that happened today at the dealership, otherwise the date and time. */
export function fmtWhen(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return value;
  const p = partsOf(d);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}` === today() ? `today ${fmtTime(value)}` : fmtDateTime(value);
}

/** The dealership's calendar date of an instant, YYYY-MM-DD. */
export function localDate(value: string): string {
  if (DATE_ONLY.test(value)) return value;
  const p = partsOf(new Date(value));
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Whole days from one calendar date to another. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
}

/** Today's calendar date at the dealership, YYYY-MM-DD. */
export function today(): string {
  const p = partsOf(new Date());
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The instant of a wall-clock date and time at the dealership, as an ISO string in UTC. */
export function zonedToIso(date: string, time = "00:00"): string {
  const guess = new Date(`${date}T${time}:00Z`);
  const p = partsOf(guess);
  const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - guess.getTime();
  return new Date(guess.getTime() - offset).toISOString();
}

const money = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
/** ₹25,000 */
export function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
  return money.format(Number(n));
}

/**
 * Money the way it is said out loud in a dealership: ₹42.3 Cr, ₹7.5 L. For the big figures on a board,
 * where ₹42,30,00,000 is fourteen characters of digits nobody reads to the end. Below a lakh it is the
 * exact amount, because at that size the rupees matter.
 */
export function fmtMoneyShort(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  const say = (x: number, unit: string) => `${sign}₹${(Math.round(x * 10) / 10).toLocaleString("en-IN", { maximumFractionDigits: x >= 100 ? 0 : 1 })} ${unit}`;
  if (a >= 1e7) return say(a / 1e7, "Cr");
  if (a >= 1e5) return say(a / 1e5, "L");
  return fmtMoney(v);
}

const num = new Intl.NumberFormat("en-IN");
export const fmtNumber = (n: number | null | undefined) => num.format(Number(n ?? 0));

/** 919876543210 is shown as +91 98765 43210. */
export function fmtMobile(m: string | null | undefined): string {
  if (!m) return "—";
  const d = m.replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) return `+91${NBSP}${d.slice(2, 7)}${NBSP}${d.slice(7)}`;
  if (d.length === 10) return `${d.slice(0, 5)}${NBSP}${d.slice(5)}`;
  return d ? `+${d}` : m;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** A value the DMS did not state is shown as a dash, never guessed. */
export const orDash = (v: string | number | null | undefined): string => (v === null || v === undefined || String(v).trim() === "" ? "—" : String(v));

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${fmtNumber(n)} ${n === 1 ? one : many}`;
}

export const carName = (c: { model: string; variant: string; colour: string }) => `${c.model} ${c.variant}, ${c.colour}`;
