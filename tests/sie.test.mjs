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
function mockFortnox() {
  const requests = [];
  const originalAdapter = axios.defaults.adapter;
  axios.defaults.adapter = async (config) => {
    const url = new URL(config.url);
    requests.push({ path: url.pathname, params: config.params, responseType: config.responseType });
    const respond = (data, status = 200) => ({ config, status, statusText: "OK", headers: {}, data });

    if (url.pathname === "/3/financialyears") return respond(financialYears);
    if (url.pathname === "/3/sie/4") {
      assert.equal(config.responseType, "arraybuffer");
      if (config.params?.financialyear !== 11) {
        const error = new axios.AxiosError("Not found", "ERR_BAD_REQUEST", config, null, {
          config, status: 404, statusText: "Not Found", headers: {},
          data: Buffer.from(JSON.stringify({ ErrorInformation: { message: "Missing year" } })),
        });
        throw error;
      }
      return respond(Buffer.from(sieFixture));
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
