import { fortnoxRequest } from "./api.js";
import { getCurrentUserId } from "../auth/context.js";
import { SIE_CACHE_TTL_MS, SIE_CACHE_MAX_ENTRIES } from "../constants.js";

/**
 * Upper half (0x80-0xFF) of IBM code page 437. SIE files are encoded as
 * "PC8", which in practice is CP437; Node's TextDecoder does not support it.
 */
const CP437_HIGH =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

/**
 * A single #TRANS row inside a #VER block
 */
export interface SieTransaction {
  account: number;
  /** Object list keyed by dimension number, e.g. { "1": "670" } for cost center 670 */
  objects: Record<string, string>;
  /** Amount in SEK; positive = debit, negative = credit */
  amount: number;
  /** Transaction date (YYYY-MM-DD) if given on the row */
  date: string | null;
  text: string | null;
}

/**
 * A #VER block
 */
export interface SieVoucher {
  series: string;
  number: string;
  /** Voucher date (YYYY-MM-DD) */
  date: string;
  text: string | null;
  transactions: SieTransaction[];
}

/**
 * Parsed SIE type 4 file (only the parts used by the tools)
 */
export interface SieFile {
  /** Current financial year (#RAR 0) */
  financialYear: { from: string; to: string } | null;
  /** #KONTO account names */
  accounts: Map<number, string>;
  /** #OBJEKT names keyed by "<dimension>:<object id>" */
  objects: Map<string, string>;
  /** #IB 0 opening balances for the current financial year */
  openingBalances: Map<number, number>;
  /** #OIB 0 opening balances per account and object list (e.g. per cost center) */
  objectOpeningBalances: Map<number, Array<{ objects: Record<string, string>; amount: number }>>;
  vouchers: SieVoucher[];
}

/**
 * Decode SIE file bytes. Files with a UTF-8 BOM are read as UTF-8, everything
 * else as PC8/CP437 per the SIE specification.
 */
export function decodeSie(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return Buffer.from(bytes.buffer, bytes.byteOffset + 3, bytes.byteLength - 3).toString("utf8");
  }
  let text = "";
  for (const byte of bytes) {
    text += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80];
  }
  return text;
}

/**
 * Split a SIE line into tokens. Quoted strings keep their content (with \" escapes),
 * and an object list "{1 "670" 6 "P1"}" is returned as a single token including braces.
 */
export function tokenizeSieLine(line: string): string[] {
  const tokens: string[] = [];
  let i = 0;

  while (i < line.length) {
    const ch = line[i];

    if (ch === " " || ch === "\t") {
      i++;
    } else if (ch === "\"") {
      let value = "";
      i++;
      while (i < line.length && line[i] !== "\"") {
        if (line[i] === "\\" && i + 1 < line.length) {
          i++;
        }
        value += line[i];
        i++;
      }
      i++; // closing quote
      tokens.push(value);
    } else if (ch === "{") {
      let value = "";
      let inQuotes = false;
      while (i < line.length) {
        const c = line[i];
        value += c;
        i++;
        if (c === "\\" && inQuotes && i < line.length) {
          value += line[i];
          i++;
        } else if (c === "\"") {
          inQuotes = !inQuotes;
        } else if (c === "}" && !inQuotes) {
          break;
        }
      }
      tokens.push(value);
    } else {
      let value = "";
      while (i < line.length && line[i] !== " " && line[i] !== "\t") {
        value += line[i];
        i++;
      }
      tokens.push(value);
    }
  }

  return tokens;
}

/**
 * Parse an object list token like {1 "670" 6 "P1"} into { "1": "670", "6": "P1" }
 */
export function parseSieObjectList(token: string | undefined): Record<string, string> {
  const objects: Record<string, string> = {};
  if (!token || !token.startsWith("{")) return objects;

  const inner = tokenizeSieLine(token.slice(1, token.endsWith("}") ? -1 : undefined));
  for (let i = 0; i + 1 < inner.length; i += 2) {
    objects[inner[i]] = inner[i + 1];
  }
  return objects;
}

/**
 * Convert a SIE date (YYYYMMDD) to YYYY-MM-DD
 */
function sieDate(value: string | undefined): string | null {
  if (!value || !/^\d{8}$/.test(value)) return null;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function sieAmount(value: string | undefined): number {
  const amount = Number.parseFloat(value ?? "");
  return Number.isFinite(amount) ? amount : 0;
}

/**
 * Parse SIE type 4 content. #RTRANS/#BTRANS rows (added/removed after
 * registration) are skipped: the SIE spec repeats added rows as #TRANS, and
 * removed rows no longer affect the balance.
 */
export function parseSie(content: string): SieFile {
  const file: SieFile = {
    financialYear: null,
    accounts: new Map(),
    objects: new Map(),
    openingBalances: new Map(),
    objectOpeningBalances: new Map(),
    vouchers: []
  };

  let currentVoucher: SieVoucher | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line === "{") continue;
    if (line === "}") {
      currentVoucher = null;
      continue;
    }
    if (!line.startsWith("#")) continue;

    const tokens = tokenizeSieLine(line);
    const label = tokens[0].toUpperCase();

    switch (label) {
      case "#RAR": {
        if (tokens[1] === "0") {
          const from = sieDate(tokens[2]);
          const to = sieDate(tokens[3]);
          if (from && to) file.financialYear = { from, to };
        }
        break;
      }
      case "#KONTO": {
        const account = Number.parseInt(tokens[1], 10);
        if (Number.isFinite(account)) file.accounts.set(account, tokens[2] ?? "");
        break;
      }
      case "#OBJEKT": {
        file.objects.set(`${tokens[1]}:${tokens[2]}`, tokens[3] ?? "");
        break;
      }
      case "#IB": {
        if (tokens[1] === "0") {
          const account = Number.parseInt(tokens[2], 10);
          if (Number.isFinite(account)) file.openingBalances.set(account, sieAmount(tokens[3]));
        }
        break;
      }
      case "#OIB": {
        if (tokens[1] === "0") {
          const account = Number.parseInt(tokens[2], 10);
          if (!Number.isFinite(account)) break;
          const entries = file.objectOpeningBalances.get(account) || [];
          entries.push({ objects: parseSieObjectList(tokens[3]), amount: sieAmount(tokens[4]) });
          file.objectOpeningBalances.set(account, entries);
        }
        break;
      }
      case "#VER": {
        currentVoucher = {
          series: tokens[1] ?? "",
          number: tokens[2] ?? "",
          date: sieDate(tokens[3]) ?? "",
          text: tokens[4] || null,
          transactions: []
        };
        file.vouchers.push(currentVoucher);
        break;
      }
      case "#TRANS": {
        if (!currentVoucher) break;
        const account = Number.parseInt(tokens[1], 10);
        if (!Number.isFinite(account)) break;
        currentVoucher.transactions.push({
          account,
          objects: parseSieObjectList(tokens[2]),
          amount: sieAmount(tokens[3]),
          date: sieDate(tokens[4]),
          text: tokens[5] || null
        });
        break;
      }
      default:
        break;
    }
  }

  return file;
}

interface SieCacheEntry {
  expiresAt: number;
  file: Promise<SieFile>;
}

// Keyed per user and financial year so remote tenants never share data
const sieCache = new Map<string, SieCacheEntry>();

/**
 * Clear the SIE cache (used by tests)
 */
export function clearSieCache(): void {
  sieCache.clear();
}

/**
 * Fetch and parse the SIE type 4 export for a Fortnox financial year.
 * Results are cached per user and financial year for SIE_CACHE_TTL_MS;
 * concurrent callers share the same in-flight request.
 */
export async function fetchSie4(financialYearId: number): Promise<SieFile> {
  const key = `${getCurrentUserId() ?? "local"}:${financialYearId}`;
  const now = Date.now();

  const cached = sieCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.file;
  }
  sieCache.delete(key);

  const file = fortnoxRequest<ArrayBuffer>(
    "/3/sie/4",
    "GET",
    undefined,
    { financialyear: financialYearId },
    undefined,
    { responseType: "arraybuffer", accept: "*/*" }
  ).then((data) => parseSie(decodeSie(new Uint8Array(data))));

  sieCache.set(key, { expiresAt: now + SIE_CACHE_TTL_MS, file });
  file.catch(() => {
    if (sieCache.get(key)?.file === file) sieCache.delete(key);
  });

  // Drop expired entries, then the oldest ones, to bound memory
  for (const [k, entry] of sieCache) {
    if (entry.expiresAt <= now) sieCache.delete(k);
  }
  while (sieCache.size > SIE_CACHE_MAX_ENTRIES) {
    const oldestKey = sieCache.keys().next().value;
    if (oldestKey === undefined) break;
    sieCache.delete(oldestKey);
  }

  return file;
}
