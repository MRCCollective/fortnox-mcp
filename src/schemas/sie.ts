import { z } from "zod";
import { ResponseFormat } from "../constants.js";

/**
 * Schema for the SIE-based account transactions tool
 *
 * Kept as a plain z.object() (no top-level .refine()) so the MCP SDK publishes
 * the full inputSchema. Cross-field rules are enforced in the tool handler.
 */
export const AccountTransactionsSchema = z.object({
  account: z.coerce.number()
    .int()
    .min(1000)
    .max(9999)
    .optional()
    .describe("Single account number (1000-9999). Use either account or account_from/account_to."),
  account_from: z.coerce.number()
    .int()
    .min(1000)
    .max(9999)
    .optional()
    .describe("First account in an account range (inclusive). Requires account_to."),
  account_to: z.coerce.number()
    .int()
    .min(1000)
    .max(9999)
    .optional()
    .describe("Last account in an account range (inclusive). Requires account_from."),
  from_date: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
    .describe("Start date, inclusive (YYYY-MM-DD, required)"),
  to_date: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
    .describe("End date, inclusive (YYYY-MM-DD, required)"),
  cost_center: z.coerce.string()
    .min(1)
    .max(20)
    .optional()
    .describe("Only include rows booked on this cost center code (SIE dimension 1, e.g. '670')"),
  response_format: z.nativeEnum(ResponseFormat)
    .default(ResponseFormat.MARKDOWN)
    .describe("Output format: 'markdown' or 'json'")
}).strict();

export type AccountTransactionsInput = z.infer<typeof AccountTransactionsSchema>;
