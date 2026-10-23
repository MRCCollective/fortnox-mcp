import { z } from "zod";
import { ResponseFormat } from "../constants.js";

/**
 * Treat null, empty and whitespace-only arguments as "not given" and trim
 * strings. Without this, z.coerce turns null into "null" or 0 and the filter
 * silently matches nothing (or the wrong thing).
 */
function blankToUndefined(value: unknown): unknown {
  if (value === null) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  return value;
}

/**
 * Accept "true"/"false" strings; z.coerce.boolean() would turn "false" into true
 */
function parseBooleanString(value: unknown): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

/**
 * A real calendar date in YYYY-MM-DD form (rejects e.g. 2026-02-30).
 * A factory, not a shared instance: reusing one schema object makes the
 * published JSON schema emit "$ref" for the second field, which some MCP
 * clients do not resolve (they then send untyped values).
 */
function isoDate() {
  return z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
    .refine((value) => {
      const d = new Date(`${value}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
    }, "Date must be a valid calendar date");
}

/**
 * Bypass flag for the SIE cache (factory for the same reason as isoDate)
 */
function refreshField() {
  return z.preprocess(parseBooleanString, z.boolean().default(false))
    .describe("Bypass the ~5 minute SIE cache and download fresh data from Fortnox (default: false). Use right after booking a correction.");
}

/**
 * Schema for the SIE-based account transactions tool
 *
 * Kept as a plain z.object() (no top-level .refine()) so the MCP SDK publishes
 * the full inputSchema. Cross-field rules are enforced in the tool handler.
 */
export const AccountTransactionsSchema = z.object({
  account: z.preprocess(blankToUndefined, z.coerce.number().int().min(1000).max(9999).optional())
    .describe("Single account number (1000-9999). Use either account or account_from/account_to."),
  account_from: z.preprocess(blankToUndefined, z.coerce.number().int().min(1000).max(9999).optional())
    .describe("First account in an account range (inclusive). Requires account_to."),
  account_to: z.preprocess(blankToUndefined, z.coerce.number().int().min(1000).max(9999).optional())
    .describe("Last account in an account range (inclusive). Requires account_from."),
  from_date: isoDate()
    .describe("Start date, inclusive (YYYY-MM-DD, required)"),
  to_date: isoDate()
    .describe("End date, inclusive (YYYY-MM-DD, required)"),
  cost_center: z.preprocess(blankToUndefined, z.coerce.string().min(1).max(20).optional())
    .describe("Only include rows booked on this cost center code (SIE dimension 1, e.g. '670')"),
  refresh: refreshField(),
  response_format: z.nativeEnum(ResponseFormat)
    .default(ResponseFormat.MARKDOWN)
    .describe("Output format: 'markdown' or 'json'")
}).strict();

export type AccountTransactionsInput = z.infer<typeof AccountTransactionsSchema>;

/**
 * Schema for cost center balances on one account at a given date
 */
export const CostCenterBalancesSchema = z.object({
  account: z.coerce.number()
    .int()
    .min(1000)
    .max(9999)
    .describe("Account number to reconcile (1000-9999, required), e.g. 1683"),
  as_of_date: isoDate()
    .describe("Balance date, inclusive (YYYY-MM-DD, required)"),
  cost_center: z.preprocess(blankToUndefined, z.coerce.string().min(1).max(20).optional())
    .describe("Only return this cost center code (SIE dimension 1, e.g. '670')"),
  include_zero: z.preprocess(parseBooleanString, z.boolean().default(false))
    .describe("Include cost centers whose balance is 0,00 (default: false)"),
  refresh: refreshField(),
  response_format: z.nativeEnum(ResponseFormat)
    .default(ResponseFormat.MARKDOWN)
    .describe("Output format: 'markdown' or 'json'")
}).strict();

export type CostCenterBalancesInput = z.infer<typeof CostCenterBalancesSchema>;
