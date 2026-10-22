import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fortnoxRequest } from "../services/api.js";
import { fetchSie4, type SieFile } from "../services/sie.js";
import { ResponseFormat, SIE_HISTORY_MAX_YEARS } from "../constants.js";
import {
  buildToolResponse,
  buildErrorResponse,
  formatMoney
} from "../services/formatters.js";
import {
  AccountTransactionsSchema,
  CostCenterBalancesSchema,
  type AccountTransactionsInput,
  type CostCenterBalancesInput
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

  server.registerTool(
    "fortnox_cost_center_balances",
    {
      title: "Cost Center Balances (SIE)",
      description: `Balance per cost center on one account at a given date, for reconciling settlement
accounts (e.g. 1683) per cost center. Data comes from the Fortnox SIE type 4 export.

Balances roll over between financial years, so the opening balance per cost center is taken from
#OIB in the SIE file when Fortnox provides it. Otherwise all movements per cost center are summed
from the earliest financial year (up to ${SIE_HISTORY_MAX_YEARS} years) forward; this is slower on the first call,
after which SIE files are cached for about 5 minutes.

The sum of all cost centers is always checked against the account's own balance (#IB plus movements).
Any gap is reported as unexplained_difference instead of being hidden.

Args:
  - account (number): Account number, e.g. 1683
  - as_of_date (string): Balance date, inclusive (YYYY-MM-DD)
  - cost_center (string): Only return this cost center
  - include_zero (boolean): Include cost centers with balance 0,00 (default: false)
  - response_format ('markdown' | 'json'): Output format

Returns:
  Per cost center: opening balance for the financial year, movements from the start of the year to
  as_of_date, balance, transaction count and last transaction date. Rows without cost center (and,
  when balances are rolled forward, the earliest year's #IB, which cannot be split) are grouped as
  cost_center=null. Plus account balance, method used and the reconciliation check.

Examples:
  - All cost centers on 1683 at 31 July 2026: account=1683, as_of_date="2026-07-31"
  - One cost center: account=1683, as_of_date="2026-09-30", cost_center="670"`,
      inputSchema: CostCenterBalancesSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async (params: CostCenterBalancesInput) => {
      try {
        const yearsResponse = await fortnoxRequest<FinancialYearsResponse>("/3/financialyears");
        const allYears = (yearsResponse.FinancialYears || [])
          .filter((fy) => fy.FromDate <= params.as_of_date)
          .sort((a, b) => a.FromDate.localeCompare(b.FromDate));
        const currentYear = allYears.find((fy) => fy.ToDate >= params.as_of_date);
        if (!currentYear) {
          throw new Error(
            `No Fortnox financial year covers ${params.as_of_date}. ` +
            "Use fortnox_list_financial_years to see available years."
          );
        }

        const currentFile = await fetchSie4(currentYear.Id);
        const costCenterNames = new Map<string, string>();
        const collectNames = (file: SieFile): void => {
          const prefix = `${COST_CENTER_DIMENSION}:`;
          for (const [key, name] of file.objects) {
            if (key.startsWith(prefix)) costCenterNames.set(key.slice(prefix.length), name);
          }
        };

        interface Balance {
          openingOre: number;
          movementOre: number;
          count: number;
          lastDate: string | null;
        }
        const balances = new Map<string | null, Balance>();
        const balanceFor = (costCenter: string | null): Balance => {
          let balance = balances.get(costCenter);
          if (!balance) {
            balance = { openingOre: 0, movementOre: 0, count: 0, lastDate: null };
            balances.set(costCenter, balance);
          }
          return balance;
        };

        // Opening balance per cost center for the current financial year
        const oibEntries = (currentFile.objectOpeningBalances.get(params.account) || [])
          .filter((entry) => Object.keys(entry.objects).length === 1 && entry.objects[COST_CENTER_DIMENSION] !== undefined);

        let method: "sie_oib" | "history";
        let yearsRead = [currentYear];
        let historyTruncated = false;

        if (oibEntries.length > 0) {
          method = "sie_oib";
          for (const entry of oibEntries) {
            balanceFor(entry.objects[COST_CENTER_DIMENSION]).openingOre += toOre(entry.amount);
          }
        } else {
          method = "history";
          let earlierYears = allYears.filter((fy) => fy.ToDate < currentYear.FromDate);
          if (earlierYears.length + 1 > SIE_HISTORY_MAX_YEARS) {
            historyTruncated = true;
            earlierYears = earlierYears.slice(earlierYears.length - (SIE_HISTORY_MAX_YEARS - 1));
          }
          yearsRead = [...earlierYears, currentYear];

          // The earliest year's #IB cannot be split per cost center
          let first = true;
          for (const fy of earlierYears) {
            const file = await fetchSie4(fy.Id);
            collectNames(file);
            if (first) {
              balanceFor(null).openingOre += toOre(file.openingBalances.get(params.account) ?? 0);
              first = false;
            }
            for (const voucher of file.vouchers) {
              for (const trans of voucher.transactions) {
                if (trans.account !== params.account) continue;
                const balance = balanceFor(trans.objects[COST_CENTER_DIMENSION] ?? null);
                balance.openingOre += toOre(trans.amount);
                if (!balance.lastDate || voucher.date > balance.lastDate) balance.lastDate = voucher.date;
              }
            }
          }
          if (first) {
            balanceFor(null).openingOre += toOre(currentFile.openingBalances.get(params.account) ?? 0);
          }
        }
        collectNames(currentFile);

        // Movements in the current financial year up to as_of_date
        for (const voucher of currentFile.vouchers) {
          if (voucher.date > params.as_of_date) continue;
          for (const trans of voucher.transactions) {
            if (trans.account !== params.account) continue;
            const balance = balanceFor(trans.objects[COST_CENTER_DIMENSION] ?? null);
            balance.movementOre += toOre(trans.amount);
            balance.count += 1;
            if (!balance.lastDate || voucher.date > balance.lastDate) balance.lastDate = voucher.date;
          }
        }

        // Reconcile the cost center split against the account balance
        const accountOpeningOre = toOre(currentFile.openingBalances.get(params.account) ?? 0);
        let movementTotalOre = 0;
        let openingTotalOre = 0;
        for (const balance of balances.values()) {
          movementTotalOre += balance.movementOre;
          openingTotalOre += balance.openingOre;
        }
        const accountBalanceOre = accountOpeningOre + movementTotalOre;
        const differenceOre = accountOpeningOre - openingTotalOre;

        const allCostCenters = Array.from(balances.entries())
          .map(([costCenter, b]) => ({
            cost_center: costCenter,
            cost_center_name: costCenter !== null ? costCenterNames.get(costCenter) ?? null : null,
            opening_balance: fromOre(b.openingOre),
            movements: fromOre(b.movementOre),
            balance: fromOre(b.openingOre + b.movementOre),
            transaction_count: b.count,
            last_transaction_date: b.lastDate
          }))
          .sort((a, b) => (a.cost_center ?? "").localeCompare(b.cost_center ?? "", undefined, { numeric: true }));

        const costCenters = allCostCenters.filter((c) =>
          (params.cost_center === undefined || c.cost_center === params.cost_center) &&
          (params.include_zero || params.cost_center !== undefined || c.balance !== 0)
        );

        const output = {
          account: params.account,
          account_name: currentFile.accounts.get(params.account) ?? null,
          as_of_date: params.as_of_date,
          financial_year: {
            id: currentYear.Id,
            from_date: currentYear.FromDate,
            to_date: currentYear.ToDate
          },
          method,
          financial_years_read: yearsRead.map((fy) => fy.Id),
          history_truncated: historyTruncated,
          account_opening_balance: fromOre(accountOpeningOre),
          account_balance: fromOre(accountBalanceOre),
          sum_of_cost_centers: fromOre(openingTotalOre + movementTotalOre),
          unexplained_difference: fromOre(differenceOre),
          cost_center_count: costCenters.length,
          cost_centers: costCenters
        };

        let textContent: string;
        if (params.response_format === ResponseFormat.JSON) {
          textContent = JSON.stringify(output, null, 2);
        } else {
          const lines: string[] = [
            `# Cost Center Balances: Account ${params.account}${output.account_name ? ` ${output.account_name}` : ""}`,
            "",
            `**As of**: ${params.as_of_date} | **Financial Year**: ${currentYear.Id} (${currentYear.FromDate} to ${currentYear.ToDate})`,
            `**Account Balance**: ${formatMoney(output.account_balance)} | **Sum of Cost Centers**: ${formatMoney(output.sum_of_cost_centers)}`,
            `**Method**: ${method === "sie_oib" ? "#OIB from SIE" : `movements summed over financial years ${output.financial_years_read.join(", ")}`}`
          ];

          if (differenceOre !== 0) {
            lines.push("");
            lines.push(
              `⚠️ **Unexplained difference**: ${formatMoney(output.unexplained_difference)}. The cost center opening balances do not add up to the account's #IB; ` +
              "check year-end transfers or balances from before the earliest financial year."
            );
          }
          if (historyTruncated) {
            lines.push("");
            lines.push(`⚠️ **Note**: Only the latest ${SIE_HISTORY_MAX_YEARS} financial years were read.`);
          }

          lines.push("");
          if (costCenters.length > 0) {
            lines.push("| Cost Center | Name | Opening Balance | Movements | Balance | Transactions | Last Transaction |");
            lines.push("|-------------|------|-----------------|-----------|---------|--------------|------------------|");
            for (const c of costCenters) {
              lines.push(
                `| ${c.cost_center ?? "(none)"} | ${c.cost_center_name || "-"} | ${formatMoney(c.opening_balance)} | ${formatMoney(c.movements)} | ${formatMoney(c.balance)} | ${c.transaction_count} | ${c.last_transaction_date || "-"} |`
              );
            }
          } else {
            lines.push("*No cost centers with a balance on this account.*");
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
