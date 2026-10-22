import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import axios from "axios";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createFortnoxMcpServer } from "../dist/server/mcpServer.js";
import { initializeTokenProvider } from "../dist/auth/index.js";
import { runWithContextAsync } from "../dist/auth/context.js";
import {
  clearSieCache,
  decodeSie,
  fetchSie4,
  parseSie,
  parseSieObjectList,
  tokenizeSieLine,
} from "../dist/services/sie.js";

const sieFixture = readFileSync(new URL("./fixtures/fy2026.se", import.meta.url));
const sieFixture2025 = readFileSync(new URL("./fixtures/fy2025.se", import.meta.url));

/**
 * FY 2026 fixture with #OIB rows per cost center inserted (latin1 keeps the PC8 bytes intact)
 */
function withObjectOpeningBalances(oibLines) {
  const text = sieFixture.toString("latin1").replace("#UB 0 1683", `${oibLines.join("\r\n")}\r\n#UB 0 1683`);
  return Buffer.from(text, "latin1");
}

const financialYears = {
  FinancialYears: [
    { Id: 10, FromDate: "2025-01-01", ToDate: "2025-12-31" },
    { Id: 11, FromDate: "2026-01-01", ToDate: "2026-12-31" },
  ],
};

initializeTokenProvider({
  getAccessToken: async () => "fake-fortnox-token",
  isAuthenticated: () => true,
  getTokenInfo: () => null,
});

/**
 * Replace the axios adapter with a fake Fortnox API and record requests
 */
function mockFortnox(sieByYear = { 11: sieFixture }) {
  const requests = [];
  const originalAdapter = axios.defaults.adapter;
  axios.defaults.adapter = async (config) => {
    const url = new URL(config.url);
    requests.push({ path: url.pathname, params: config.params, responseType: config.responseType });
    const respond = (data, status = 200) => ({ config, status, statusText: "OK", headers: {}, data });

    if (url.pathname === "/3/financialyears") return respond(financialYears);
    if (url.pathname === "/3/sie/4") {
      assert.equal(config.responseType, "arraybuffer");
      const sieFile = sieByYear[config.params?.financialyear];
      if (!sieFile) {
        const error = new axios.AxiosError("Not found", "ERR_BAD_REQUEST", config, null, {
          config, status: 404, statusText: "Not Found", headers: {},
          data: Buffer.from(JSON.stringify({ ErrorInformation: { message: "Missing year" } })),
        });
        throw error;
      }
      return respond(Buffer.from(sieFile));
    }
    if (url.pathname.startsWith("/3/vouchers")) {
      return respond({ Vouchers: [], MetaInformation: { "@TotalResources": 0 } });
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  };
  return {
    requests,
    restore: () => { axios.defaults.adapter = originalAdapter; },
  };
}

async function connectClient(accessMode = "read-only") {
  const server = createFortnoxMcpServer(accessMode);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

test("tokenizer handles quoted strings, escapes and object lists", () => {
  assert.deepEqual(
    tokenizeSieLine('#VER "A" "12" 20260315 "Omföring \\"mars\\"" 20260316'),
    ["#VER", "A", "12", "20260315", 'Omföring "mars"', "20260316"],
  );
  assert.deepEqual(
    tokenizeSieLine('#TRANS 1683 {1 "670" 6 "P 1"} -10.50 20260101 "Text"'),
    ["#TRANS", "1683", '{1 "670" 6 "P 1"}', "-10.50", "20260101", "Text"],
  );
  assert.deepEqual(parseSieObjectList('{1 "670" 6 "P 1"}'), { "1": "670", "6": "P 1" });
  assert.deepEqual(parseSieObjectList("{}"), {});
});

test("parser decodes PC8 and reads #IB, #VER and #TRANS but skips #BTRANS/#RTRANS", () => {
  const file = parseSie(decodeSie(sieFixture));

  assert.deepEqual(file.financialYear, { from: "2026-01-01", to: "2026-12-31" });
  assert.equal(file.accounts.get(1683), "Övriga kortfristiga fordringar");
  assert.equal(file.objects.get("1:670"), "Försäljning Norden");
  assert.equal(file.openingBalances.get(1683), -250000);
  assert.equal(file.vouchers.length, 9);

  const voucher = file.vouchers.find((v) => v.series === "B" && v.number === "219");
  assert.equal(voucher.date, "2026-09-05");
  // 2 regular rows + the #TRANS repeat of the #RTRANS row + its reversal
  assert.equal(voucher.transactions.length, 4);
  assert.ok(voucher.transactions.every((t) => t.text !== "Borttagen rad"));

  const projectRow = file.vouchers.find((v) => v.number === "88").transactions[0];
  assert.deepEqual(projectRow.objects, { "1": "680", "6": "P1" });
});

test("fortnox_account_transactions returns account 1683 / cost center 670 rows for Aug-Sep 2026", async () => {
  clearSieCache();
  const mock = mockFortnox();
  const client = await connectClient();

  try {
    const result = await client.callTool({
      name: "fortnox_account_transactions",
      arguments: {
        account: "1683",
        from_date: "2026-08-01",
        to_date: "2026-09-30",
        cost_center: 670,
        response_format: "json",
      },
    });

    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    const output = result.structuredContent;

    assert.deepEqual(
      output.transactions.map((t) => [t.voucher_text, t.amount]),
      [
        ["Kundbet Reform Furniture NUF (6296)", 7582.36],
        ["Levfakt 2802", -798.14],
        ["Kundfaktura Collectia AS (6586)", -6877.65],
        ["Kundfaktura Collectia AS (6627)", -6877.65],
        ["Kreditfaktura (6738)", 6877.65],
      ],
    );
    assert.deepEqual(output.transactions[0], {
      date: "2026-08-04",
      voucher_series: "C",
      voucher_number: "141",
      voucher_text: "Kundbet Reform Furniture NUF (6296)",
      account: 1683,
      cost_center: "670",
      amount: 7582.36,
      transaction_text: "Reform Furniture",
    });

    // Balance on 31 July for the whole account (all cost centers)
    assert.equal(output.opening_balance.as_of, "2026-07-31");
    assert.equal(output.opening_balance.total, -239101.6);
    assert.deepEqual(output.opening_balance.accounts, [{
      account: 1683,
      account_name: "Övriga kortfristiga fordringar",
      year_opening_balance: -250000,
      balance: -239101.6,
    }]);

    assert.deepEqual(output.totals_by_cost_center, [{
      cost_center: "670",
      cost_center_name: "Försäljning Norden",
      amount: -93.43,
      transaction_count: 5,
    }]);
    assert.equal(output.total_amount, -93.43);
    assert.deepEqual(output.financial_years, [{ id: 11, from_date: "2026-01-01", to_date: "2026-12-31" }]);

    const sieRequests = mock.requests.filter((r) => r.path === "/3/sie/4");
    assert.equal(sieRequests.length, 1);
    assert.equal(sieRequests[0].params.financialyear, 11);
  } finally {
    mock.restore();
    await client.close();
  }
});

test("fortnox_account_transactions groups all cost centers and renders markdown", async () => {
  clearSieCache();
  const mock = mockFortnox();
  const client = await connectClient();

  try {
    const json = await client.callTool({
      name: "fortnox_account_transactions",
      arguments: { account: 1683, from_date: "2026-08-01", to_date: "2026-09-30", response_format: "json" },
    });
    const output = json.structuredContent;
    assert.equal(output.transaction_count, 6);
    assert.deepEqual(
      output.totals_by_cost_center.map((c) => [c.cost_center, c.amount, c.transaction_count]),
      [["670", -93.43, 5], ["680", 500, 1]],
    );
    assert.equal(output.closing_balance_all_cost_centers, -238695.03);

    const markdown = await client.callTool({
      name: "fortnox_account_transactions",
      arguments: { account: 1683, from_date: "2026-08-01", to_date: "2026-09-30", cost_center: "670" },
    });
    const text = markdown.content[0].text;
    // formatMoney uses sv-SE formatting (U+2212 minus sign, space thousand separator)
    assert.match(text, /# Account Transactions: Account 1683 Övriga kortfristiga fordringar/);
    assert.match(text, /\| 2026-08-12 \| D57 \| Levfakt 2802 \| 1683 \| 670 \| [−-]798,14 SEK \|/);
    assert.match(text, /Opening Balance 2026-07-31\*\* \(all cost centers\): [−-]239\s101,60 SEK/);

    // Both calls reuse the cached SIE file
    assert.equal(mock.requests.filter((r) => r.path === "/3/sie/4").length, 1);
  } finally {
    mock.restore();
    await client.close();
  }
});

test("fortnox_account_transactions supports account ranges", async () => {
  clearSieCache();
  const mock = mockFortnox();
  const client = await connectClient();

  try {
    const result = await client.callTool({
      name: "fortnox_account_transactions",
      arguments: { account_from: 1900, account_to: 2999, from_date: "2026-08-12", to_date: "2026-08-12", response_format: "json" },
    });
    assert.deepEqual(
      result.structuredContent.transactions.map((t) => [t.account, t.amount, t.cost_center]),
      [[2440, 798.14, null]],
    );
    assert.deepEqual(
      result.structuredContent.opening_balance.accounts.map((a) => [a.account, a.balance]),
      [[1930, 125000 - 12000 + 1101.6 - 7582.36]],
    );
  } finally {
    mock.restore();
    await client.close();
  }
});

test("fortnox_account_transactions rejects invalid filters inside the MCP contract", async () => {
  clearSieCache();
  const mock = mockFortnox();
  const client = await connectClient();

  try {
    const cases = [
      [{ from_date: "2026-08-01", to_date: "2026-09-30" }, /Must specify account/],
      [{ account: 1683, account_from: 1000, account_to: 1999, from_date: "2026-08-01", to_date: "2026-09-30" }, /not both/],
      [{ account_from: 1000, from_date: "2026-08-01", to_date: "2026-09-30" }, /must both be set/],
      [{ account: 1683, from_date: "2026-09-30", to_date: "2026-08-01" }, /from_date must be on or before/],
      [{ account: 1683, from_date: "2027-01-01", to_date: "2027-02-01" }, /No Fortnox financial year/],
      [{ account: 1683, from_date: "2025-12-01", to_date: "2026-01-31" }, /\[\/3\/sie\/4\] Resource not found/],
    ];
    for (const [args, pattern] of cases) {
      const result = await client.callTool({ name: "fortnox_account_transactions", arguments: args });
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.match(result.content[0].text, pattern);
    }
  } finally {
    mock.restore();
    await client.close();
  }
});

test("SIE cache is keyed per user and expires", async (t) => {
  clearSieCache();
  const mock = mockFortnox();

  try {
    await runWithContextAsync({ userId: "user-a" }, () => fetchSie4(11));
    await runWithContextAsync({ userId: "user-a" }, () => fetchSie4(11));
    await runWithContextAsync({ userId: "user-b" }, () => fetchSie4(11));
    assert.equal(mock.requests.filter((r) => r.path === "/3/sie/4").length, 2);

    t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 5 * 60 * 1000 + 1 });
    await runWithContextAsync({ userId: "user-a" }, () => fetchSie4(11));
    assert.equal(mock.requests.filter((r) => r.path === "/3/sie/4").length, 3);
  } finally {
    t.mock.timers.reset();
    mock.restore();
  }
});

test("new tool is exposed in read-only mode with a typed input schema", async () => {
  const client = await connectClient("read-only");
  try {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "fortnox_account_transactions");
    assert.ok(tool);
    assert.equal(tool.inputSchema.properties.account.type, "integer");
    assert.deepEqual(tool.inputSchema.required.sort(), ["from_date", "to_date"]);
  } finally {
    await client.close();
  }
});

test("fortnox_cost_center_balances rolls balances forward from earlier years", async () => {
  clearSieCache();
  const mock = mockFortnox({ 10: sieFixture2025, 11: sieFixture });
  const client = await connectClient();

  try {
    const result = await client.callTool({
      name: "fortnox_cost_center_balances",
      arguments: { account: "1683", as_of_date: "2026-07-31", response_format: "json" },
    });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    const output = result.structuredContent;

    assert.equal(output.method, "history");
    assert.deepEqual(output.financial_years_read, [10, 11]);
    assert.equal(output.account_balance, -239101.6);
    assert.equal(output.sum_of_cost_centers, -239101.6);
    assert.equal(output.unexplained_difference, 0);
    // 690 nets to zero and is hidden by default
    assert.deepEqual(
      output.cost_centers.map((c) => [c.cost_center, c.opening_balance, c.movements, c.balance, c.transaction_count]),
      [
        [null, -200000, 0, -200000, 0],
        ["670", -30000, 12000, -18000, 1],
        ["680", -20000, -1101.6, -21101.6, 1],
      ],
    );
    assert.equal(output.cost_centers[1].last_transaction_date, "2026-03-15");

    const single = await client.callTool({
      name: "fortnox_cost_center_balances",
      arguments: { account: 1683, as_of_date: "2026-09-30", cost_center: 670, response_format: "json" },
    });
    // -18000 + Aug-Sep movements on 670 (-93.43)
    assert.deepEqual(
      single.structuredContent.cost_centers.map((c) => [c.cost_center, c.balance, c.transaction_count]),
      [["670", -18093.43, 6]],
    );

    const withZero = await client.callTool({
      name: "fortnox_cost_center_balances",
      arguments: { account: 1683, as_of_date: "2026-07-31", include_zero: "true" },
    });
    assert.match(withZero.content[0].text, /\| 690 \| Avslutat \| 0,00 SEK \|/);
    assert.match(withZero.content[0].text, /Method\*\*: movements summed over financial years 10, 11/);
    assert.doesNotMatch(withZero.content[0].text, /Unexplained difference/);

    // Three calls, two SIE downloads thanks to the cache
    assert.equal(mock.requests.filter((r) => r.path === "/3/sie/4").length, 2);
  } finally {
    mock.restore();
    await client.close();
  }
});

test("fortnox_cost_center_balances uses #OIB and puts the uncovered #IB on no cost center", async () => {
  clearSieCache();
  const mock = mockFortnox({
    11: withObjectOpeningBalances([
      '#OIB 0 1683 {1 "670"} -30000.00',
      '#OIB 0 1683 {1 "680"} -219000.00',
      '#OIB 0 1683 {1 "670" 6 "P1"} -999.00',
    ]),
  });
  const client = await connectClient();

  try {
    const result = await client.callTool({
      name: "fortnox_cost_center_balances",
      arguments: { account: 1683, as_of_date: "2026-07-31", response_format: "json" },
    });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    const output = result.structuredContent;

    assert.equal(output.method, "sie_oib");
    assert.deepEqual(output.financial_years_read, [11]);
    assert.equal(output.account_balance, -239101.6);
    // #IB -250000 minus #OIB -249000 leaves -1000 booked without cost center
    assert.equal(output.unexplained_difference, null);
    assert.equal(output.sum_of_cost_centers, output.account_balance);
    assert.deepEqual(
      output.cost_centers.map((c) => [c.cost_center, c.opening_balance, c.balance]),
      [[null, -1000, -1000], ["670", -30000, -18000], ["680", -219000, -220101.6]],
    );
    // Only FY 11 was downloaded
    assert.deepEqual(mock.requests.filter((r) => r.path === "/3/sie/4").map((r) => r.params.financialyear), [11]);

    const markdown = await client.callTool({
      name: "fortnox_cost_center_balances",
      arguments: { account: 1683, as_of_date: "2026-07-31" },
    });
    assert.match(markdown.content[0].text, /#OIB from SIE \(opening balance not covered by #OIB is shown without cost center\)/);
    assert.doesNotMatch(markdown.content[0].text, /Unexplained difference/);

    const missing = await client.callTool({
      name: "fortnox_cost_center_balances",
      arguments: { account: 1683, as_of_date: "2030-01-01" },
    });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /No Fortnox financial year covers 2030-01-01/);
  } finally {
    mock.restore();
    await client.close();
  }
});

/**
 * Edit the FY 2026 fixture as text (latin1 keeps the PC8 bytes intact)
 */
function editFixture(fixture, edit) {
  return Buffer.from(edit(fixture.toString("latin1")), "latin1");
}

test("SIE tools refuse files that are not the requested year or fail integrity checks", async () => {
  const cases = [
    // Fortnox ignores the year parameter and returns the current year
    [{ 10: sieFixture, 11: sieFixture }, { account: 1683, as_of_date: "2025-06-30" }, /wrong financial year: expected 2025-01-01 to 2025-12-31, got 2026-01-01 to 2026-12-31/],
    // A body that is not SIE at all
    [{ 11: Buffer.from(JSON.stringify({ ok: true })) }, { account: 1683, as_of_date: "2026-07-31" }, /did not return a SIE type 4 file/],
    // An unbalanced voucher
    [{ 11: editFixture(sieFixture, (t) => t.replace("#TRANS 2440 {} 798.14", "#TRANS 2440 {} 798.15")) }, { account: 1683, as_of_date: "2026-07-31" }, /SIE voucher D57 \(2026-08-12\) does not balance \(difference 0.01\)/],
    // A row lost in parsing (e.g. #RTRANS not repeated as #TRANS) shows up as #IB + transactions != #UB
    [{ 11: editFixture(sieFixture, (t) => t.replace('   #TRANS 1683 {1 "670"} -798.14\r\n', '   #RTRANS 1683 {1 "670"} -798.14\r\n').replace("#TRANS 2440 {} 798.14", "#TRANS 2440 {} 0.00")) }, { account: 1683, as_of_date: "2026-07-31" }, /integrity check failed for account 1683/],
    // A malformed amount must not be parsed leniently
    [{ 11: editFixture(sieFixture, (t) => t.replace("#TRANS 1930 {} -500.00", "#TRANS 1930 {} -500,00")) }, { account: 1683, as_of_date: "2026-07-31" }, /Invalid SIE amount "-500,00"/],
  ];

  for (const [sieByYear, args, pattern] of cases) {
    clearSieCache();
    const mock = mockFortnox(sieByYear);
    const client = await connectClient();
    try {
      const result = await client.callTool({ name: "fortnox_cost_center_balances", arguments: args });
      assert.equal(result.isError, true, `expected error for ${pattern}`);
      assert.match(result.content[0].text, pattern);
    } finally {
      mock.restore();
      await client.close();
    }
  }
});

test("account_transactions refuses ranges across a missing financial year", async () => {
  clearSieCache();
  const originalYears = financialYears.FinancialYears;
  financialYears.FinancialYears = [
    { Id: 9, FromDate: "2024-01-01", ToDate: "2024-12-31" },
    { Id: 11, FromDate: "2026-01-01", ToDate: "2026-12-31" },
  ];
  const mock = mockFortnox();
  const client = await connectClient();
  try {
    const result = await client.callTool({
      name: "fortnox_account_transactions",
      arguments: { account: 1683, from_date: "2024-06-01", to_date: "2026-06-30" },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Gap between Fortnox financial years 9 \(ends 2024-12-31\) and 11/);
  } finally {
    financialYears.FinancialYears = originalYears;
    mock.restore();
    await client.close();
  }
});

test("history roll-forward reports a broken #IB chain as unexplained difference", async () => {
  clearSieCache();
  // FY 2026 #IB no longer equals FY 2025 #IB + movements (-250000)
  const broken = editFixture(sieFixture, (t) => t
    .replace("#IB 0 1683 -250000.00", "#IB 0 1683 -251000.00")
    .replace("#UB 0 1683 -237695.04", "#UB 0 1683 -238695.04"));
  const mock = mockFortnox({ 10: sieFixture2025, 11: broken });
  const client = await connectClient();
  try {
    const result = await client.callTool({
      name: "fortnox_cost_center_balances",
      arguments: { account: 1683, as_of_date: "2026-07-31", response_format: "json" },
    });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    assert.equal(result.structuredContent.unexplained_difference, -1000);
    assert.equal(result.structuredContent.account_balance, -240101.6);

    const markdown = await client.callTool({
      name: "fortnox_cost_center_balances",
      arguments: { account: 1683, as_of_date: "2026-07-31" },
    });
    assert.match(markdown.content[0].text, /Unexplained difference\*\*: [−-]1\s000,00 SEK/);
  } finally {
    mock.restore();
    await client.close();
  }
});

test("blank and null arguments are treated as not given, invalid dates are rejected", async () => {
  clearSieCache();
  const mock = mockFortnox({ 10: sieFixture2025, 11: sieFixture });
  const client = await connectClient();
  try {
    const nullCostCenter = await client.callTool({
      name: "fortnox_account_transactions",
      arguments: { account: 1683, from_date: "2026-08-01", to_date: "2026-09-30", cost_center: null, response_format: "json" },
    });
    assert.notEqual(nullCostCenter.isError, true, nullCostCenter.content?.[0]?.text);
    assert.equal(nullCostCenter.structuredContent.filter.cost_center, null);
    assert.equal(nullCostCenter.structuredContent.transaction_count, 6);

    const padded = await client.callTool({
      name: "fortnox_cost_center_balances",
      arguments: { account: " 1683 ", as_of_date: "2026-07-31", cost_center: " 670 ", response_format: "json" },
    });
    assert.notEqual(padded.isError, true, padded.content?.[0]?.text);
    assert.deepEqual(padded.structuredContent.cost_centers.map((c) => c.cost_center), ["670"]);

    const badDate = await client.callTool({
      name: "fortnox_account_transactions",
      arguments: { account: 1683, from_date: "2026-02-30", to_date: "2026-03-31" },
    });
    assert.equal(badDate.isError, true);
    assert.match(badDate.content[0].text, /valid calendar date/);
  } finally {
    mock.restore();
    await client.close();
  }
});

test("refresh bypasses the SIE cache and output says when data was fetched", async () => {
  clearSieCache();
  const mock = mockFortnox({ 10: sieFixture2025, 11: sieFixture });
  const client = await connectClient();
  try {
    const args = { account: 1683, as_of_date: "2026-07-31", response_format: "json" };
    const first = await client.callTool({ name: "fortnox_cost_center_balances", arguments: args });
    await client.callTool({ name: "fortnox_cost_center_balances", arguments: args });
    assert.equal(mock.requests.filter((r) => r.path === "/3/sie/4").length, 2);
    assert.match(first.structuredContent.sie_fetched_at, /^\d{4}-\d{2}-\d{2}T/);

    await client.callTool({ name: "fortnox_cost_center_balances", arguments: { ...args, refresh: true } });
    assert.equal(mock.requests.filter((r) => r.path === "/3/sie/4").length, 4);
  } finally {
    mock.restore();
    await client.close();
  }
});
