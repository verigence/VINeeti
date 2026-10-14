// Mahindra: reading the DMS "Model Description".
//
// A faithful TypeScript port of tools/mahindra_description_parser.py (the dealership's own deterministic
// parser, with the reviewed fixes listed in that file). Nothing is inferred: every rule is explicit, and
// an attribute the description does not state stays blank. test/mahindra-parser.test.ts checks this port
// field by field against the Python parser's output for every description in the real stock report and
// booking sheet.
//
// Stock report:   "XUV3XO AX5 PM MT WQ(A3EVRSTWHT)(M1024)"
//                  └ model ┘└ variant ┘└paint┘└ OEM colour ┘└ OEM model code ┘
// Booking sheet:  "XUV3XO AX5 PM MT WQ"   (the same text, without the two bracketed codes;
//                                          the OEM model code is inside the booking's Model Code)

const PATTERN = /^\s*(.*?)\s*\(([AC]\d[A-Z0-9]+)\)\s*\((M\d+)\)\s*$/;

/** OEM colour code -> [readable name, CODE | REVIEW]. Used only when the DMS gives no colour name of its own. */
export const COLOURS: Record<string, [string, "CODE" | "REVIEW"]> = {
  A0DMNDWHIT: ["Diamond White", "CODE"], A0JAVABRWN: ["Java Brown", "CODE"],
  A0RCKYBIEG: ["Rocky Beige", "REVIEW"], A0STELBLK: ["Stealth Black", "CODE"],
  A2WHITE: ["White", "CODE"], A3BNTSNMBK: ["Burnt Sienna [MBK option]", "REVIEW"],
  A3BTLGRMBK: ["Battleship Grey [MBK option]", "REVIEW"],
  A3BTLSGREY: ["Battleship Grey", "CODE"], A3CITRNYLW: ["Citrine Yellow", "CODE"],
  A3DARKGREY: ["Dark Grey", "CODE"], A3DEEPFRST: ["Deep Forest", "CODE"],
  A3DMNDWHIT: ["Diamond White", "CODE"],
  A3DUNBGOBK: ["Dune Beige [dual-tone code]", "REVIEW"],
  A3EVRSTMBK: ["Everest White [MBK option]", "REVIEW"],
  A3EVRSTOBK: ["Everest White / Black roof", "CODE"],
  A3EVRSTWHT: ["Everest White", "CODE"],
  A3GLXGROBK: ["Galaxy Grey / Black roof", "CODE"],
  A3NBULABLU: ["Nebula Blue", "CODE"],
  A3NEBLUMBK: ["Nebula Blue [MBK option]", "REVIEW"],
  A3OBNBLKGG: ["Black [GG option]", "REVIEW"],
  A3PTRLBLGG: ["Blue [GG option]", "REVIEW"],
  A3RSREDBLK: ["Red / Black roof", "REVIEW"],
  A3RSREDMBK: ["Red [MBK option]", "REVIEW"],
  A3STLTHBLK: ["Stealth Black", "CODE"],
  A3STLTHMBK: ["Stealth Black [MBK option]", "REVIEW"],
  A3TNTRISRD: ["Red [TNTRISRD code]", "REVIEW"],
  C1CNCRTGRY: ["Concrete Grey", "CODE"], C1CRMSNRD: ["Crimson Red", "CODE"],
  C1DEEPFRST: ["Deep Forest", "CODE"], C1DMNDWHIT: ["Diamond White", "CODE"],
  C1DRZLSLVR: ["Dazzling Silver", "CODE"],
  C1DSRTMST: ["Desert Myst", "CODE"],
  C1EVEWHDT: ["Everest White / Dual Tone", "CODE"],
  C1EVRTWHT: ["Everest White", "CODE"],
  C1EVRTWHTM: ["Everest White [M option]", "REVIEW"],
  C1FRORNG: ["Orange [FRORNG code]", "REVIEW"],
  C1GALGREY: ["Galaxy Grey", "CODE"],
  C1JEANSBLU: ["Jeans Blue", "CODE"],
  C1JNSBSBLK: ["Jeans Blue / Stealth Black", "CODE"],
  C1MDNGTBLK: ["Midnight Black", "CODE"],
  C1NBULABLU: ["Nebula Blue", "CODE"],
  C1NPERLWHT: ["Pearl White [NPERLWHT code]", "REVIEW"],
  C1NPOLBLCK: ["Napoli Black", "CODE"],
  C1OCNBLUE: ["Ocean Blue", "CODE"],
  C1POLRWHT: ["Polar White", "CODE"],
  C1PRLWSBLK: ["Pearl White / Stealth Black", "CODE"],
  C1REGLBLU: ["Regal Blue", "CODE"], C1RVELVET: ["Ruby Velvet", "CODE"],
  C1STELBLK: ["Stealth Black", "CODE"],
  C1STLBLKM: ["Stealth Black [M option]", "REVIEW"],
  C1WARMBLUE: ["Warm Blue", "CODE"],
};

/** Description prefix -> model family, longest prefix first. */
const PREFIXES: [string, string][] = (
  [
    ["MAHINDRA XUV3XO EV", "XUV 3XO EV"],
    ["MAHINDRA SUPRO PROFITTRUCK", "SUPRO PROFITTRUCK"],
    ["SUPRO PROFITTRUCK", "SUPRO PROFITTRUCK"],
    ["MAHINDRA BOLERO NEO+", "BOLERO NEO+"],
    ["MAHINDRA BOLERO NEO", "BOLERO NEO"],
    ["MAHINDRA BOLERO", "BOLERO"],
    ["BOLERO PIK-UP", "BOLERO PIK-UP"],
    ["BOLERO CAMPER", "BOLERO CAMPER"],
    ["BOL MAXX PUP CITY", "BOL MAXX PUP CITY"],
    ["BOL MAXX PUP HD", "BOL MAXX PUP HD"],
    ["SCORPIO CLASSIC", "SCORPIO CLASSIC"],
    ["SCORPIO-N", "SCORPIO-N"],
    ["THAR ROXX", "THAR ROXX"],
    ["THAR", "THAR"],
    ["XUV3XO", "XUV 3XO"],
    ["XUV7XO", "XUV 7XO"],
    ["XUV700", "XUV700"],
    ["XEV 9S", "XEV 9S"],
    ["XEV 9E", "XEV 9E"],
    ["BE 6", "BE 6"],
    ["VEERO", "VEERO"],
  ] as [string, string][]
).sort((a, b) => b[0].length - a[0].length);

/** Factory paint aliases, for the families whose description carries one after the vehicle configuration. */
const PAINT_ALIASES: Record<string, string[]> = {
  "XUV 3XO": ["WQ", "XJ", "CK", "JD", "QK", "RP", "RQ", "AE", "ZX", "ZW", "AD", "AC", "ZV"],
  "XUV 3XO EV": ["WQ", "XJ", "CK", "JD", "QK", "RP", "RQ", "AE", "ZX", "ZW", "AD", "AC", "ZV"],
  "SCORPIO-N": ["WQ", "XJ", "JD", "BF"],
  THAR: ["WQ", "XJ", "JD", "QL"],
  "XUV 7XO": ["EWHT DT", "EWHT", "SBLK", "MBLK", "RVET", "DMST", "NBLU", "GGRY"],
  "BE 6": ["WQ", "RV", "QJ", "OG", "XJ"],
  "XEV 9E": ["XM", "WS", "WQ", "QJ"],
  "XEV 9S": ["WQ", "QJ", "BN", "BZ", "RV", "XJ"],
  "BOLERO NEO": ["PW+SB", "JB+SB", "DW", "JB", "PW", "SB"],
  "BOLERO NEO+": ["WHITE", "BLACK", "SILVER", "WHT"],
  "SUPRO PROFITTRUCK": ["WD", "BU", "RY", "BZ"],
};
const ROXX_PAINT_RE = /\s+(?:EWT\/BR|STL BLK\/BR|STL BLK MOCHA|STL BLK|TGO RED\/BR|BRT SNA\/BR|BTL GRY\/BR|NBA BLE\/BR)$/;

/** Catalogue-backed default seat count; none for commercial vehicles. */
const MODEL_SEATS: Record<string, number> = { "XUV 3XO": 5, "XUV 3XO EV": 5, "THAR ROXX": 5, "BE 6": 5, "XEV 9E": 5 };
const EV_FAMILIES = new Set(["BE 6", "XEV 9E", "XEV 9S", "XUV 3XO EV"]);

// A trim that can end in ")" is closed with (?![A-Z0-9]) rather than \b: a word boundary never matches
// between ")" and a space, which made "B6 (O)" read as "B6" and "REVX M(O)" as "REVX M".
const TRIM_RE: Record<string, RegExp> = {
  "XUV 3XO": /^(REVX (?:M\(O\)|EDGE(?: \(O\))?|M|A)|(?:AX\dL?|MX\d)(?: PRO)?)(?![A-Z0-9])/,
  "XUV 3XO EV": /^(AX\dL?)\b/,
  THAR: /^(LXT|ZXT)\b/,
  "THAR ROXX": /^(STAR EDN|AX\dL?|MX\d)\b/,
  "XUV 7XO": /^(AX\d+[TL]?|AX)\b/,
  "SCORPIO CLASSIC": /^(S11|S)\b/,
  "BE 6": /^(TWO|THREE|FOUR)\b/,
  "XEV 9E": /^(THREE CL|TWO|THREE|FOUR)\b/,
  "XEV 9S": /^(ONE ABOVE|TWO ABOVE|THREE ABOVE|THREE|TWO|ONE)\b/,
  BOLERO: /^(B\d+(?: \(O\))?)(?![A-Z0-9])/,
  "BOLERO NEO": /^(N\d+(?: \(R\))?)/,
  "BOLERO NEO+": /^(P\d+(?: AMBU)?)\b/,
};

function trimOf(family: string, variant: string): string {
  const whole = (re: RegExp) => re.exec(variant)?.[0] ?? "";
  const group = (re: RegExp) => re.exec(variant)?.[1] ?? "";
  if (family === "SCORPIO-N") return whole(/\bZ\d+[A-Z]?(?: S)?\b/);
  if (family.startsWith("BOL MAXX PUP")) return group(/\b(SXID|VXID|LXD|VXI|SXI|LX|MX)\b/);
  if (family === "BOLERO PIK-UP") return whole(/\bFB (?:MSD|PSD|PS)\b/);
  if (family === "BOLERO CAMPER") return whole(/\b(?:GOLD ZXD|PSD)\b/);
  if (family === "SUPRO PROFITTRUCK") return whole(/\b(EXCEL|MINI VX)\b/);
  if (family === "VEERO") return whole(/\bV\d\b/);
  const re = TRIM_RE[family];
  return re ? group(re) : "";
}

export interface ParsedDescription {
  model: string;
  trim: string;
  transmission: string;
  fuel: string;
  drive: string;
  /** Seat count stated in the description or the catalogue default; "" when neither says. */
  seater: number | "";
  /** The OEM variant name: the description without the model prefix and the paint alias. */
  variant: string;
  colour: string;
  oem_colour_code: string;
  oem_model_code: string;
  colour_status: "" | "CODE" | "REVIEW" | "DMS";
  seat_source: string;
  parse_status: string;
  review_reason: string;
  raw_description: string;
  /** The factory paint alias removed from the end of the description ("WQ", "EWHT DT", "STL BLK/BR"), if the family carries one. */
  paint_alias: string;
  /** The description without the two bracketed codes, single-spaced. A booking's Model Description is this same text. */
  text: string;
}

const blank = (raw: string): ParsedDescription => ({
  model: "", trim: "", transmission: "", fuel: "", drive: "", seater: "", variant: "", colour: "", oem_colour_code: "", oem_model_code: "",
  colour_status: "", seat_source: "", parse_status: "", review_reason: "", raw_description: raw, paint_alias: "", text: "",
});

/** Reads the description text without the bracketed codes (also a booking's Model Description). */
export function parseText(coreRaw: unknown, into?: ParsedDescription): ParsedDescription {
  const d = into ?? blank(String(coreRaw ?? "").trim());
  const core = String(coreRaw ?? "").replace(/\s+/g, " ").trim();
  d.text = core;
  let variant: string | null = null;
  for (const [prefix, family] of PREFIXES) {
    if (core === prefix || core.startsWith(prefix + " ")) {
      d.model = family;
      variant = core.slice(prefix.length).trim();
      break;
    }
  }
  if (variant === null) {
    d.parse_status = "REVIEW";
    d.review_reason = "Unknown model prefix";
    return d;
  }
  if (d.model === "THAR ROXX") {
    const m = ROXX_PAINT_RE.exec(" " + variant);
    if (m) d.paint_alias = m[0].trim();
    variant = (" " + variant).replace(ROXX_PAINT_RE, "").trim();
  } else {
    const aliases = [...(PAINT_ALIASES[d.model] ?? [])].sort((a, b) => b.length - a.length);
    for (const alias of aliases) {
      if (variant.endsWith(" " + alias)) {
        d.paint_alias = alias;
        variant = variant.slice(0, -(alias.length + 1)).trim();
        break;
      }
    }
  }
  // The complete cleaned OEM variant name is kept; only confirmed token spacing is normalised.
  variant = variant.replace(/\bDMT\b/g, "D MT").replace(/\s+/g, " ").trim();
  d.variant = variant;
  d.trim = trimOf(d.model, variant);
  const words = new Set(variant.split(" ").filter(Boolean));
  const ev = EV_FAMILIES.has(d.model);
  if (words.has("MT")) d.transmission = "Manual";
  else if (words.has("AT")) d.transmission = "Automatic";
  else if (words.has("AS")) d.transmission = "AutoSHIFT+ (AMT)";
  else if (ev) d.transmission = "Single-speed EV (catalogue)";
  if (ev) d.fuel = "Electric";
  else if (words.has("CNG")) d.fuel = "CNG";
  else if (["D", "DS", "DSL", "D15"].some((x) => words.has(x))) d.fuel = "Diesel";
  else if (["P", "G", "PM", "PG", "PET"].some((x) => words.has(x))) d.fuel = "Petrol";
  for (const x of ["AWD", "4WD", "RWD", "2WD", "FWD"]) {
    if (words.has(x)) {
      d.drive = x;
      break;
    }
  }
  const seat = /\b([4-9])\s*(?:S|STR)\b/.exec(variant);
  if (seat) {
    d.seater = Number(seat[1]);
    d.seat_source = "Description";
  } else if (d.model in MODEL_SEATS) {
    d.seater = MODEL_SEATS[d.model];
    d.seat_source = "Model catalogue";
  }
  return d;
}

/**
 * Reads a stock report Model Description. `dms.colour` and `dms.seating` are the report's own Color and
 * Seating columns: when given they are used instead of the provisional colour dictionary and the
 * catalogue seat default.
 */
export function parseDescription(text: unknown, dms: { colour?: unknown; seating?: unknown } = {}): ParsedDescription {
  const d = blank(String(text ?? "").trim());
  const m = PATTERN.exec(d.raw_description);
  if (!m) {
    d.parse_status = "REVIEW";
    d.review_reason = "Invalid suffix pattern: expected (OEM colour code)(M model code)";
    return d;
  }
  d.oem_colour_code = m[2];
  d.oem_model_code = m[3];
  parseText(m[1].trim(), d);
  if (d.parse_status === "REVIEW") return d;
  if (!d.seater || d.seat_source === "Model catalogue") {
    const sm = /^\s*(\d+)/.exec(String(dms.seating ?? ""));
    if (sm) {
      d.seater = Number(sm[1]);
      d.seat_source = "DMS Seating column";
    }
  }
  const dmsColour = String(dms.colour ?? "").replace(/\s+/g, " ").trim();
  if (dmsColour) {
    d.colour = dmsColour.toUpperCase();
    d.colour_status = "DMS";
  } else if (d.oem_colour_code in COLOURS) {
    [d.colour, d.colour_status] = COLOURS[d.oem_colour_code];
  } else {
    d.colour = d.oem_colour_code;
    d.colour_status = "REVIEW";
  }
  const issues: string[] = [];
  if (!d.trim) issues.push("Trim not mapped");
  if (!d.fuel) issues.push("Fuel not encoded");
  if (!d.transmission) issues.push("Transmission not encoded");
  if (!d.drive) issues.push("Drive not encoded");
  if (!d.seater) issues.push("Seating not encoded");
  if (d.colour_status === "REVIEW") issues.push("Colour display name requires OEM confirmation");
  d.review_reason = issues.join("; ");
  d.parse_status = !issues.length ? "COMPLETE" : d.colour_status !== "REVIEW" ? "PARTIAL - CATALOGUE NEEDED" : "PARTIAL - COLOUR REVIEW";
  return d;
}

/** The OEM model code (Mxxxx) inside a booking's Model Code, e.g. "X3XOM104918095856" -> "M1049". */
export function oemModelCodeOf(bookingModelCode: unknown): string {
  const all = String(bookingModelCode ?? "").toUpperCase().match(/M\d{4}/g) ?? [];
  return all.length === 1 ? all[0] : "";
}

/**
 * The DMS "Model" (stock) / "Product Family" (booking) column -> model family, for a description whose
 * prefix the parser does not know. The dealership's own list (rules.py, MODEL_ALIASES).
 */
export const MODEL_ALIASES: Record<string, string> = {
  "MAXX HD": "BOL MAXX PUP HD", MAXX: "BOL MAXX PUP CITY",
  "SUPRO-MT": "SUPRO PROFITTRUCK", "NEW THAR": "THAR",
  CAMPER: "BOLERO CAMPER", "PICK UP": "BOLERO PIK-UP",
  XUV3XO: "XUV 3XO", "XUV3XO EV": "XUV 3XO EV",
  "BOLERO NEO PLUS": "BOLERO NEO+",
};

/** Fuel as the booking sheet writes it (DIESEL / PETROL / ELECTR) -> the parser's words. "" when not recognised. */
export function fuelFromDms(raw: unknown): string {
  const s = String(raw ?? "").trim().toUpperCase();
  if (s === "DIESEL") return "Diesel";
  if (s === "PETROL") return "Petrol";
  if (s === "ELECTR" || s === "ELECTRIC") return "Electric";
  if (s === "CNG") return "CNG";
  return "";
}
