import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fortnoxRequest } from "../services/api.js";
import { fetchSie4, type SieFile } from "../services/sie.js";
import { ResponseFormat } from "../constants.js";
import {
  buildToolResponse,
  buildErrorResponse,
  formatMoney
} from "../services/formatters.js";
import {
  AccountTransactionsSchema,
  type AccountTransactionsInput
} from "../schemas/sie.js";

// API response types
interface FortnoxFinancialYear {
  Id: number;
  FromDate: string;
  ToDate: string;
}

interface FinancialYearsResponse {
  FinancialYears: FortnoxFinancialYear[];
}

// SIE dimension 1 is cost center (kostnadsställe)
const COST_CENTER_DIMENSION = "1";

/**
 * Amounts are summed in öre to avoid floating point drift
 */
function toOre(amount: number): number {
  return Math.round(amount * 100);
}

function fromOre(ore: number): number {
  return ore / 100;
}

/**
 * Return the day before a YYYY-MM-DD date
 */
function previousDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Register SIE-based bookkeeping tools
 */
export function registerSieTools(server: McpServer): void {
  server.registerTool(
    "fortnox_account_transactions",
    {
      title: "Account Transactions (SIE)",
      description: `List every booked transaction on an account (or account range) between two dates, with
cost center, voucher series/number and texts. Data comes from the Fortnox SIE type 4 export, so it covers
all vouchers in the period without the voucher-scan limits of fortnox_account_activity.

Financial years are resolved internally from the dates (no financial_year ID needed). Date ranges may
span several financial years. SIE files are cached for about 5 minutes per financial year.

Args:
  - account (number): Single account number (1000-9999)
  - account_from / account_to (number): Inclusive account range (use instead of account)
  - from_date (string): Start date, inclusive (YYYY-MM-DD)
  - to_date (string): End date, inclusive (YYYY-MM-DD)
  - cost_center (string): Only rows on this cost center (SIE dimension 1)
  - response_format ('markdown' | 'json'): Output format

Returns:
  - transactions: date, voucher series/number, voucher text, account, cost center, amount (SEK,
    debit positive / credit negative) and transaction text
  - totals_by_cost_center: sum and row count per cost center for the matching rows
  - opening_balance: per account, the financial year's #IB plus all movements from the start of the
    year up to the day before from_date (all cost centers; SIE has no opening balance per cost center)

Examples:
  - Account 1683, cost center 670, Aug-Sep 2026: account=1683, from_date="2026-08-01", to_date="2026-09-30", cost_center="670"
  - All revenue accounts in Q1: account_from=3000, account_to=3999, from_date="2026-01-01", to_date="2026-03-31"`,
      inputSchema: AccountTransactionsSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async (params: AccountTransactionsInput) => {
      try {
        const hasRange = params.account_from !== undefined || params.account_to !== undefined;
        if (params.account !== undefined && hasRange) {
          throw new Error("Use either account or account_from/account_to, not both");
        }
        if (params.account === undefined && !hasRange) {
          throw new Error("Must specify account or account_from/account_to");
        }
        if (hasRange && (params.account_from === undefined || params.account_to === undefined)) {
          throw new Error("account_from and account_to must both be set");
        }
        if (params.from_date > params.to_date) {
          throw new Error("from_date must be on or before to_date");
        }

        const accountFrom = params.account ?? params.account_from!;
        const accountTo = params.account ?? params.account_to!;
        if (accountFrom > accountTo) {
          throw new Error("account_from must be less than or equal to account_to");
        }
        const accountMatches = (account: number): boolean =>
          account >= accountFrom && account <= accountTo;

        // Resolve the financial years overlapping the requested period
        const yearsResponse = await fortnoxRequest<FinancialYearsResponse>("/3/financialyears");
        const years = (yearsResponse.FinancialYears || [])
          .filter((fy) => fy.FromDate <= params.to_date && fy.ToDate >= params.from_date)
          .sort((a, b) => a.FromDate.localeCompare(b.FromDate));

        if (years.length === 0) {
          throw new Error(
            `No Fortnox financial year covers ${params.from_date} to ${params.to_date}. ` +
            "Use fortnox_list_financial_years to see available years."
          );
        }
        if (years[0].FromDate > params.from_date || years[years.length - 1].ToDate < params.to_date) {
          throw new Error(
            `The period ${params.from_date} to ${params.to_date} is not fully covered by Fortnox financial years ` +
            `(${years[0].FromDate} to ${years[years.length - 1].ToDate}).`
          );
        }

        const sieFiles: SieFile[] = [];
        for (const fy of years) {
          sieFiles.push(await fetchSie4(fy.Id));
        }

        const accountNames = new Map<number, string>();
        const costCenterNames = new Map<string, string>();
        for (const file of sieFiles) {
          for (const [account, name] of file.accounts) accountNames.set(account, name);
          for (const [key, name] of file.objects) {
            const prefix = `${COST_CENTER_DIMENSION}:`;
            if (key.startsWith(prefix)) costCenterNames.set(key.slice(prefix.length), name);
          }
        }

        // Opening balance: #IB of the first year plus movements before from_date
        const firstYear = sieFiles[0];
        const openingOre = new Map<number, number>();
        for (const [account, amount] of firstYear.openingBalances) {
          if (accountMatches(account)) openingOre.set(account, toOre(amount));
        }
        for (const voucher of firstYear.vouchers) {
          if (voucher.date >= params.from_date) continue;
          for (const trans of voucher.transactions) {
            if (!accountMatches(trans.account)) continue;
            openingOre.set(trans.account, (openingOre.get(trans.account) || 0) + toOre(trans.amount));
          }
        }
        if (params.account !== undefined && !openingOre.has(params.account)) {
          openingOre.set(params.account, 0);
        }

        // Matching transactions in the period
        const transactions: Array<{
          date: string;
          voucher_series: string;
          voucher_number: string;
          voucher_text: string | null;
          account: number;
          cost_center: string | null;
          amount: number;
          transaction_text: string | null;
        }> = [];
        const costCenterTotals = new Map<string | null, { ore: number; count: number }>();
        let totalOre = 0;

        for (const file of sieFiles) {
          for (const voucher of file.vouchers) {
            if (voucher.date < params.from_date || voucher.date > params.to_date) continue;

            for (const trans of voucher.transactions) {
              if (!accountMatches(trans.account)) continue;
              const costCenter = trans.objects[COST_CENTER_DIMENSION] ?? null;
              if (params.cost_center !== undefined && costCenter !== params.cost_center) continue;

              const ore = toOre(trans.amount);
              transactions.push({
                date: voucher.date,
                voucher_series: voucher.series,
                voucher_number: voucher.number,
                voucher_text: voucher.text,
                account: trans.account,
                cost_center: costCenter,
                amount: fromOre(ore),
                transaction_text: trans.text
              });

              const existing = costCenterTotals.get(costCenter) || { ore: 0, count: 0 };
              existing.ore += ore;
              existing.count += 1;
              costCenterTotals.set(costCenter, existing);
              totalOre += ore;
            }
          }
        }

        transactions.sort((a, b) =>
          a.date.localeCompare(b.date) ||
          a.voucher_series.localeCompare(b.voucher_series) ||
          a.voucher_number.localeCompare(b.voucher_number, undefined, { numeric: true }) ||
          a.account - b.account
        );

        const openingAccounts = Array.from(openingOre.entries())
          .sort(([a], [b]) => a - b)
          .map(([account, ore]) => ({
            account,
            account_name: accountNames.get(account) ?? null,
            year_opening_balance: fromOre(toOre(firstYear.openingBalances.get(account) ?? 0)),
            balance: fromOre(ore)
          }));
        const openingTotalOre = Array.from(openingOre.values()).reduce((sum, ore) => sum + ore, 0);

        const totalsByCostCenter = Array.from(costCenterTotals.entries())
          .map(([costCenter, data]) => ({
            cost_center: costCenter,
            cost_center_name: costCenter !== null ? costCenterNames.get(costCenter) ?? null : null,
            amount: fromOre(data.ore),
            transaction_count: data.count
          }))
          .sort((a, b) => (a.cost_center ?? "").localeCompare(b.cost_center ?? "", undefined, { numeric: true }));

        const output = {
          filter: {
            account: params.account ?? null,
            account_from: params.account !== undefined ? null : accountFrom,
            account_to: params.account !== undefined ? null : accountTo,
            from_date: params.from_date,
            to_date: params.to_date,
            cost_center: params.cost_center ?? null
          },
          financial_years: years.map((fy) => ({
            id: fy.Id,
            from_date: fy.FromDate,
            to_date: fy.ToDate
          })),
          opening_balance: {
            as_of: previousDay(params.from_date),
            total: fromOre(openingTotalOre),
            accounts: openingAccounts
          },
          transaction_count: transactions.length,
          total_amount: fromOre(totalOre),
          closing_balance_all_cost_centers: params.cost_center === undefined
            ? fromOre(openingTotalOre + totalOre)
            : null,
          totals_by_cost_center: totalsByCostCenter,
          transactions
        };

        let textContent: string;
        if (params.response_format === ResponseFormat.JSON) {
          textContent = JSON.stringify(output, null, 2);
        } else {
          const accountDesc = params.account !== undefined
            ? `Account ${params.account}${accountNames.has(params.account) ? ` ${accountNames.get(params.account)}` : ""}`
            : `Accounts ${accountFrom}-${accountTo}`;

          const lines: string[] = [
            `# Account Transactions: ${accountDesc}`,
            "",
            `**Period**: ${params.from_date} to ${params.to_date}`
          ];
          if (params.cost_center !== undefined) {
            const name = costCenterNames.get(params.cost_center);
            lines.push(`**Cost Center**: ${params.cost_center}${name ? ` (${name})` : ""}`);
          }
          lines.push(`**Financial Years**: ${years.map((fy) => `${fy.Id} (${fy.FromDate} to ${fy.ToDate})`).join(", ")}`);
          lines.push(`**Opening Balance ${output.opening_balance.as_of}** (all cost centers): ${formatMoney(output.opening_balance.total)}`);
          lines.push(`**Transactions**: ${transactions.length} | **Period Total**: ${formatMoney(output.total_amount)}`);

          if (openingAccounts.length > 1) {
            lines.push("");
            lines.push("## Opening Balances");
            lines.push("");
            lines.push("| Account | Name | #IB | Balance |");
            lines.push("|---------|------|-----|---------|");
            for (const a of openingAccounts) {
              lines.push(`| ${a.account} | ${a.account_name || "-"} | ${formatMoney(a.year_opening_balance)} | ${formatMoney(a.balance)} |`);
            }
          }

          if (totalsByCostCenter.length > 0) {
            lines.push("");
            lines.push("## Totals by Cost Center");
            lines.push("");
            lines.push("| Cost Center | Name | Amount | Transactions |");
            lines.push("|-------------|------|--------|--------------|");
            for (const c of totalsByCostCenter) {
              lines.push(`| ${c.cost_center ?? "(none)"} | ${c.cost_center_name || "-"} | ${formatMoney(c.amount)} | ${c.transaction_count} |`);
            }
          }

          if (transactions.length > 0) {
            lines.push("");
            lines.push("## Transactions");
            lines.push("");
            lines.push("| Date | Voucher | Voucher Text | Account | Cost Center | Amount | Transaction Text |");
            lines.push("|------|---------|--------------|---------|-------------|--------|------------------|");

            const displayLimit = 200;
            for (const t of transactions.slice(0, displayLimit)) {
              lines.push(
                `| ${t.date} | ${t.voucher_series}${t.voucher_number} | ${t.voucher_text || "-"} | ${t.account} | ${t.cost_center || "-"} | ${formatMoney(t.amount)} | ${t.transaction_text || "-"} |`
              );
            }

            if (transactions.length > displayLimit) {
              lines.push(`| ... | ... | *${transactions.length - displayLimit} more transactions (use response_format='json')* | ... | ... | ... | ... |`);
            }
          } else {
            lines.push("");
            lines.push("*No transactions found for the given filters.*");
          }

          textContent = lines.join("\n");
        }

        return buildToolResponse(textContent, output);
      } catch (error) {
        return buildErrorResponse(error);
      }
    }
  );
}
