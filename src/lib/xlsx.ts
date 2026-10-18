// Reads the DMS exports. An .xlsx file is a ZIP of XML parts; this reads exactly what the import needs
// (sheet names, shared strings, cell values) with the platform's own decompression and no dependency.
// A .csv export with the same column headings is accepted as well.

import { bad, parseCsv } from "./util";

export interface Sheet {
  name: string;
  /** Row by row, cell by cell, as text. Numbers and dates are the stored value ("46284", "45902.7566"); empty cells are "". */
  rows: string[][];
}

const MAX_FILE_BYTES = 12 * 1024 * 1024;
const MAX_PART_BYTES = 60 * 1024 * 1024;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

function zipEntries(buf: Uint8Array): ZipEntry[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // The end-of-central-directory record is at the end of the file, before an optional comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw bad("This is not a valid .xlsx file");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || dv.getUint32(p, true) !== 0x02014b50) throw bad("This .xlsx file is damaged");
    const method = dv.getUint16(p + 10, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    const name = decoder.decode(buf.subarray(p + 46, p + 46 + nameLen));
    if (compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) throw bad("This .xlsx file is too large to read");
    out.push({ name, method, compressedSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function readPart(buf: Uint8Array, e: ZipEntry): Promise<string> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (e.offset + 30 > buf.length || dv.getUint32(e.offset, true) !== 0x04034b50) throw bad("This .xlsx file is damaged");
  if (e.size > MAX_PART_BYTES) throw bad("This .xlsx file is too large to read");
  const start = e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true);
  const data = buf.subarray(start, start + e.compressedSize);
  if (e.method === 0) return new TextDecoder().decode(data);
  if (e.method !== 8) throw bad("This .xlsx file uses a compression method that is not supported");
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  if (bytes.length > MAX_PART_BYTES) throw bad("This .xlsx file is too large to read");
  return new TextDecoder().decode(bytes);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function unescapeXml(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[e] ?? whole;
  });
}

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return m ? unescapeXml(m[1] ?? m[2] ?? "") : null;
};

/** The text of every <t> inside a fragment, skipping phonetic runs. */
function textOf(fragment: string): string {
  const clean = fragment.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, "");
  let out = "";
  const re = /<(?:\w+:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?t>)/g;
  for (let m = re.exec(clean); m; m = re.exec(clean)) out += unescapeXml(m[1] ?? "");
  return out;
}

function sharedStrings(xml: string): string[] {
  const out: string[] = [];
  const re = /<(?:\w+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(textOf(m[1] ?? ""));
  return out;
}

function columnIndex(ref: string): number {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/** A number as the file stores it, without floating-point noise or exponent ("9.99E+9" -> "9990000000"). */
function numberText(v: string): string {
  if (/^-?\d+$/.test(v)) return v;
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return /e/i.test(v) ? String(n) : v;
}

function sheetRows(xml: string, strings: string[]): string[][] {
  const rows: string[][] = [];
  const rowRe = /<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g;
  const cellRe = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
  for (let r = rowRe.exec(xml); r; r = rowRe.exec(xml)) {
    const index = Number(attr(r[1], "r")) || rows.length + 1;
    while (rows.length < index - 1) rows.push([]);
    const cells: string[] = [];
    let next = 0;
    const body = r[2] ?? "";
    cellRe.lastIndex = 0;
    for (let c = cellRe.exec(body); c; c = cellRe.exec(body)) {
      const ref = attr(c[1], "r");
      const col = ref ? columnIndex(ref) : next;
      next = col + 1;
      const type = attr(c[1], "t");
      const inner = c[2] ?? "";
      let value = "";
      if (type === "inlineStr") value = textOf(inner);
      else {
        const v = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner);
        const raw = v ? unescapeXml(v[1]) : "";
        if (type === "s") value = strings[Number(raw)] ?? "";
        else if (type === "b") value = raw === "1" ? "TRUE" : "FALSE";
        else if (type === "e") value = "";
        else if (type === "str") value = raw;
        else value = numberText(raw);
      }
      while (cells.length < col) cells.push("");
      cells[col] = value;
    }
    rows.push(cells);
  }
  return rows;
}

/** Every sheet of an .xlsx workbook. */
export async function readWorkbook(bytes: Uint8Array): Promise<Sheet[]> {
  if (bytes.length > MAX_FILE_BYTES) throw bad("The file is larger than 12 MB");
  const entries = zipEntries(bytes);
  const part = async (name: string) => {
    const e = entries.find((x) => x.name === name);
    return e ? readPart(bytes, e) : null;
  };
  const workbook = await part("xl/workbook.xml");
  if (!workbook) throw bad("This file is not an Excel workbook (.xlsx)");
  const rels = (await part("xl/_rels/workbook.xml.rels")) ?? "";
  const targets = new Map<string, string>();
  for (const m of rels.matchAll(/<(?:\w+:)?Relationship\b([^>]*?)\/?>/g)) {
    const id = attr(m[1], "Id"), target = attr(m[1], "Target");
    if (id && target) targets.set(id, target.startsWith("/") ? target.slice(1) : target.startsWith("xl/") ? target : `xl/${target}`);
  }
  const stringsXml = await part("xl/sharedStrings.xml");
  const strings = stringsXml ? sharedStrings(stringsXml) : [];
  const sheets: Sheet[] = [];
  let n = 0;
  for (const m of workbook.matchAll(/<(?:\w+:)?sheet\b([^>]*?)\/?>/g)) {
    n++;
    const name = attr(m[1], "name") ?? `Sheet${n}`;
    const rid = attr(m[1], "r:id") ?? attr(m[1], "id");
    const target = (rid && targets.get(rid)) || `xl/worksheets/sheet${n}.xml`;
    const xml = await part(target);
    if (xml === null) continue;
    sheets.push({ name, rows: sheetRows(xml, strings) });
  }
  if (!sheets.length) throw bad("The workbook has no sheets");
  return sheets;
}

/** The sheets of an uploaded export: an .xlsx workbook, or a .csv file as a single sheet. */
export async function readExport(bytes: Uint8Array, filename = ""): Promise<Sheet[]> {
  if (bytes.length === 0) throw bad("The file is empty");
  if (bytes.length > MAX_FILE_BYTES) throw bad("The file is larger than 12 MB");
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return readWorkbook(bytes);
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf) throw bad("This is an old-format Excel file (.xls). Open it in Excel and save it as .xlsx, then upload it again.");
  return [{ name: filename || "csv", rows: parseCsv(new TextDecoder().decode(bytes)) }];
}

export interface Table {
  sheet: string;
  /** Column headings, trimmed and single-spaced. */
  header: string[];
  /** One record per data row, keyed by heading in lower case. `_row` is the row number in the file. */
  records: (Record<string, string> & { _row: string })[];
}

const headingKey = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Finds the sheet whose heading row has all the `required` headings and returns its rows as records. */
export function tableWith(sheets: Sheet[], required: string[]): Table | null {
  for (const sheet of sheets) {
    // The heading row is normally the first row; a title line or two above it is tolerated.
    for (let h = 0; h < Math.min(sheet.rows.length, 5); h++) {
      const header = (sheet.rows[h] ?? []).map((c) => c.replace(/\s+/g, " ").trim());
      const keys = header.map(headingKey);
      if (!required.every((r) => keys.includes(headingKey(r)))) continue;
      const records: Table["records"] = [];
      for (let i = h + 1; i < sheet.rows.length; i++) {
        const cells = sheet.rows[i] ?? [];
        if (!cells.some((c) => c.trim() !== "")) continue;
        const rec = { _row: String(i + 1) } as Table["records"][number];
        keys.forEach((k, idx) => {
          if (k && !(k in rec)) rec[k] = (cells[idx] ?? "").trim();
        });
        records.push(rec);
      }
      return { sheet: sheet.name, header, records };
    }
  }
  return null;
}

/** An Excel serial day number -> YYYY-MM-DD. */
export function serialToDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2958465) return null;
  const ms = Math.round((serial - 25569) * 86_400_000);
  return new Date(ms).toISOString().slice(0, 10);
}

/** An Excel serial with a time fraction -> "YYYY-MM-DDTHH:MM" in the workbook's (local) time. */
export function serialToLocalDateTime(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2958465) return null;
  const ms = Math.round((serial - 25569) * 86_400_000 / 60_000) * 60_000;
  return new Date(ms).toISOString().slice(0, 16);
}

// ---------------------------------------------------------------- writing a simple workbook

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const escapeXml = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
function columnName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/**
 * A one-sheet .xlsx workbook: the first row in bold, text as text (so a mobile number or a code keeps its
 * leading zeros), numbers as numbers. Used for the sheets people download, fill in and load back.
 */
export interface SheetOut {
  name: string;
  rows: (string | number | null | undefined)[][];
  widths?: number[];
}

/** One sheet. For a workbook of several, see `buildWorkbook`. */
export function buildXlsx(sheetName: string, rows: (string | number | null | undefined)[][], widths: number[] = []): Uint8Array {
  return buildWorkbook([{ name: sheetName, rows, widths }]);
}

/**
 * A workbook of one or more sheets.
 *
 * Several sheets matter for a file another system ingests: an upload template usually wants one
 * kind of row per sheet, and mixing two kinds into one tab with an "action" column is a file a
 * person reads, not a file a machine takes.
 */
export function buildWorkbook(sheets: SheetOut[]): Uint8Array {
  if (!sheets.length) throw new Error("A workbook needs at least one sheet");
  const sheetXml = (s: SheetOut) => {
    const body = s.rows
      .map((row, r) => {
        const cells = row
          .map((v, c) => {
            if (v === null || v === undefined || v === "") return "";
            const ref = `${columnName(c)}${r + 1}`;
            const style = r === 0 ? ' s="1"' : "";
            return typeof v === "number" && Number.isFinite(v) ? `<c r="${ref}"${style}><v>${v}</v></c>` : `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(v))}</t></is></c>`;
          })
          .join("");
        return `<row r="${r + 1}">${cells}</row>`;
      })
      .join("");
    const cols = s.widths?.length ? `<cols>${s.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
    return `${head}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${body}</sheetData></worksheet>`;
  };
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const n = sheets.length;
  const names = new Set<string>();
  const tabName = (s: SheetOut, i: number) => {
    // Excel refuses duplicates and anything over 31 characters, and refuses to open the file at all
    // rather than saying which sheet it objected to.
    let name = s.name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31).trim() || `Sheet${i + 1}`;
    while (names.has(name.toLowerCase())) name = `${name.slice(0, 28)} ${i + 1}`;
    names.add(name.toLowerCase());
    return name;
  };
  const tabs = sheets.map(tabName);
  const parts: [string, string][] = [
    ["[Content_Types].xml", `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ["_rels/.rels", `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `${head}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${tabs.map((name, i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ["xl/styles.xml", `${head}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`],
    ...sheets.map((s, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
  ];
  // A ZIP with the parts stored uncompressed: these sheets are small.
  const encoder = new TextEncoder();
  const files = parts.map(([name, text]) => ({ name: encoder.encode(name), data: encoder.encode(text) }));
  const size = files.reduce((n, f) => n + 30 + f.name.length + f.data.length + 46 + f.name.length, 22);
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let p = 0;
  const central: { offset: number; crc: number; f: (typeof files)[number] }[] = [];
  for (const f of files) {
    const crc = crc32(f.data);
    central.push({ offset: p, crc, f });
    dv.setUint32(p, 0x04034b50, true); dv.setUint16(p + 4, 20, true); dv.setUint16(p + 6, 0x0800, true); dv.setUint16(p + 8, 0, true);
    dv.setUint16(p + 10, 0, true); dv.setUint16(p + 12, 0x21, true); // a fixed date (1980-01-01): the content, not the clock, decides the bytes
    dv.setUint32(p + 14, crc, true); dv.setUint32(p + 18, f.data.length, true); dv.setUint32(p + 22, f.data.length, true);
    dv.setUint16(p + 26, f.name.length, true); dv.setUint16(p + 28, 0, true);
    out.set(f.name, p + 30); out.set(f.data, p + 30 + f.name.length);
    p += 30 + f.name.length + f.data.length;
  }
  const start = p;
  for (const c of central) {
    dv.setUint32(p, 0x02014b50, true); dv.setUint16(p + 4, 20, true); dv.setUint16(p + 6, 20, true); dv.setUint16(p + 8, 0x0800, true); dv.setUint16(p + 10, 0, true);
    dv.setUint16(p + 12, 0, true); dv.setUint16(p + 14, 0x21, true);
    dv.setUint32(p + 16, c.crc, true); dv.setUint32(p + 20, c.f.data.length, true); dv.setUint32(p + 24, c.f.data.length, true);
    dv.setUint16(p + 28, c.f.name.length, true); dv.setUint32(p + 42, c.offset, true);
    out.set(c.f.name, p + 46);
    p += 46 + c.f.name.length;
  }
  dv.setUint32(p, 0x06054b50, true); dv.setUint16(p + 8, files.length, true); dv.setUint16(p + 10, files.length, true); dv.setUint32(p + 12, p - start, true); dv.setUint32(p + 16, start, true);
  return out;
}

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
