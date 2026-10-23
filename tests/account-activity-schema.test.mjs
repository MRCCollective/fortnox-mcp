import test from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createFortnoxMcpServer } from "../dist/server/mcpServer.js";
import { initializeTokenProvider } from "../dist/auth/index.js";

initializeTokenProvider({
  getAccessToken: async () => "fake-fortnox-token",
  isAuthenticated: () => true,
  getTokenInfo: () => null,
});

async function connectClient() {
  const server = createFortnoxMcpServer("read-only");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

test("fortnox_account_activity publishes typed properties", async () => {
  const client = await connectClient();
  try {
    const { tools } = await client.listTools();
    const schema = tools.find((t) => t.name === "fortnox_account_activity").inputSchema;
    assert.equal(schema.properties.account_number.type, "integer");
    assert.equal(schema.properties.financial_year.type, "integer");
    assert.equal(schema.properties.account_range.type, "object");
    assert.equal(schema.properties.account_range.properties.from.type, "integer");
    assert.equal(schema.properties.account_numbers.type, "array");
  } finally {
    await client.close();
  }
});

test("fortnox_account_activity accepts string-encoded arguments and returns cost center per row", async () => {
  const originalAdapter = axios.defaults.adapter;
  const requests = [];
  axios.defaults.adapter = async (config) => {
    const path = new URL(config.url).pathname;
    requests.push({ path, params: config.params });
    const respond = (data) => ({ config, status: 200, statusText: "OK", headers: {}, data });
    if (path === "/3/vouchers") {
      return respond({
        Vouchers: [{ VoucherSeries: "B", VoucherNumber: 203, Description: "Kundfaktura", TransactionDate: "2026-08-18" }],
        MetaInformation: { "@TotalResources": 1 },
      });
    }
    if (path === "/3/vouchers/B/203") {
      return respond({
        Voucher: {
          VoucherSeries: "B",
          VoucherNumber: 203,
          Year: 11,
          Description: "Kundfaktura",
          TransactionDate: "2026-08-18",
          VoucherRows: [
            { Account: 1683, Credit: 6877.65, CostCenter: "670", Project: "P1" },
            { Account: 1930, Debit: 6877.65 },
          ],
        },
      });
    }
    throw new Error(`Unexpected request ${path}`);
  };

  const client = await connectClient();
  try {
    const result = await client.callTool({
      name: "fortnox_account_activity",
      arguments: {
        account_range: '{"from": "1600", "to": "1699"}',
        financial_year: "11",
        max_vouchers: "10",
        include_summary: "false",
        response_format: "json",
      },
    });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    assert.equal(requests[0].params.financialyear, 11);
    assert.deepEqual(result.structuredContent.transactions, [{
      voucher_series: "B",
      voucher_number: 203,
      transaction_date: "2026-08-18",
      voucher_description: "Kundfaktura",
      account: 1683,
      cost_center: "670",
      project: "P1",
      description: null,
      debit: 0,
      credit: 6877.65,
    }]);
    assert.equal(result.structuredContent.summary, undefined);

    const single = await client.callTool({
      name: "fortnox_account_activity",
      arguments: { account_number: "1683", financial_year: "11", response_format: "json" },
    });
    assert.notEqual(single.isError, true, single.content?.[0]?.text);
    assert.equal(single.structuredContent.matching_transactions, 1);

    const missing = await client.callTool({
      name: "fortnox_account_activity",
      arguments: { financial_year: 11 },
    });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /Must specify at least one of/);
  } finally {
    axios.defaults.adapter = originalAdapter;
    await client.close();
  }
});

test("voucher tools ignore rows Fortnox marks as Removed", async () => {
  const originalAdapter = axios.defaults.adapter;
  // Mirrors live voucher B1998: the 3045 row was corrected to 3048 after registration
  const voucher = {
    VoucherSeries: "B",
    VoucherNumber: 1998,
    Year: 11,
    Description: "Kundfaktura F. Initiatives SRL (6196)",
    TransactionDate: "2026-08-03",
    VoucherRows: [
      { Account: 3048, Credit: 1354.95, Description: "Försäljning tjänster EU momsfri" },
      { Account: 1683, Debit: 1354.95, CostCenter: "670", Description: "Avräkningskonto" },
      { Account: 1510, Debit: 0, Credit: 0, Description: "Kundfordringar" },
      { Account: 3045, Credit: 1354.95, Description: "Försälj tjänst utanför EU", Removed: true },
      { Account: 1683, Debit: 1354.95, CostCenter: "680", Description: "Fel kostnadsställe", Removed: true },
    ],
  };
  axios.defaults.adapter = async (config) => {
    const path = new URL(config.url).pathname;
    const respond = (data) => ({ config, status: 200, statusText: "OK", headers: {}, data });
    if (path === "/3/vouchers") {
      return respond({
        Vouchers: [{ VoucherSeries: "B", VoucherNumber: 1998, Description: voucher.Description, TransactionDate: voucher.TransactionDate }],
        MetaInformation: { "@TotalResources": 1 },
      });
    }
    if (path === "/3/vouchers/B/1998") return respond({ Voucher: voucher });
    throw new Error(`Unexpected request ${path}`);
  };

  const client = await connectClient();
  try {
    const activity = await client.callTool({
      name: "fortnox_account_activity",
      arguments: { account_numbers: [1683, 3045, 3048], financial_year: 11, max_vouchers: 10, response_format: "json" },
    });
    assert.notEqual(activity.isError, true, activity.content?.[0]?.text);
    assert.deepEqual(
      activity.structuredContent.transactions.map((t) => [t.account, t.cost_center, t.debit, t.credit]),
      [[3048, null, 0, 1354.95], [1683, "670", 1354.95, 0]],
    );
    assert.deepEqual(
      activity.structuredContent.summary.map((s) => [s.account, s.total_debit, s.total_credit]),
      [[1683, 1354.95, 0], [3048, 0, 1354.95]],
    );

    const detail = await client.callTool({
      name: "fortnox_get_voucher",
      arguments: { voucher_series: "B", voucher_number: 1998, financial_year: 11, response_format: "json" },
    });
    assert.deepEqual(detail.structuredContent.rows.map((r) => r.account_number), [3048, 1683, 1510]);
    assert.deepEqual(detail.structuredContent.removed_rows.map((r) => r.account_number), [3045, 1683]);

    const detailMarkdown = await client.callTool({
      name: "fortnox_get_voucher",
      arguments: { voucher_series: "B", voucher_number: 1998, financial_year: 11 },
    });
    const text = detailMarkdown.content[0].text;
    // Totals balance once removed rows are excluded
    assert.match(text, /\| \*\*Total\*\* \| \| \*\*1\s354,95 SEK\*\* \| \*\*1\s354,95 SEK\*\* \|/);
    assert.match(text, /## Removed Rows \(corrected, not included in totals\)/);

    const search = await client.callTool({
      name: "fortnox_search_vouchers",
      arguments: { search_text: "Fel kostnadsställe", financial_year: 11, include_rows: true, max_vouchers: 10, response_format: "json" },
    });
    assert.equal(search.structuredContent.matching_count, 0);

    const searchByVoucher = await client.callTool({
      name: "fortnox_search_vouchers",
      arguments: { search_text: "Initiatives", financial_year: 11, include_rows: true, max_vouchers: 10, response_format: "json" },
    });
    assert.deepEqual(searchByVoucher.structuredContent.vouchers[0].rows.map((r) => r.account), [3048, 1683, 1510]);
  } finally {
    axios.defaults.adapter = originalAdapter;
    await client.close();
  }
});

test("fortnox_account_activity reports vouchers it could not fetch instead of hiding them", async () => {
  const originalAdapter = axios.defaults.adapter;
  axios.defaults.adapter = async (config) => {
    const path = new URL(config.url).pathname;
    const respond = (data) => ({ config, status: 200, statusText: "OK", headers: {}, data });
    if (path === "/3/vouchers") {
      return respond({
        Vouchers: [
          { VoucherSeries: "B", VoucherNumber: 1, Description: "OK", TransactionDate: "2026-08-01" },
          { VoucherSeries: "B", VoucherNumber: 2, Description: "Broken", TransactionDate: "2026-08-02" },
        ],
        MetaInformation: { "@TotalResources": 2 },
      });
    }
    if (path === "/3/vouchers/B/1") {
      return respond({
        Voucher: {
          VoucherSeries: "B", VoucherNumber: 1, Year: 11, Description: "OK", TransactionDate: "2026-08-01",
          VoucherRows: [{ Account: 1683, Debit: 100 }, { Account: 1930, Credit: 100 }],
        },
      });
    }
    throw new axios.AxiosError("Server error", "ERR_BAD_RESPONSE", config, null, {
      config, status: 500, statusText: "Error", headers: {}, data: {},
    });
  };

  const client = await connectClient();
  try {
    const json = await client.callTool({
      name: "fortnox_account_activity",
      arguments: { account_number: 1683, financial_year: 11, max_vouchers: 10, response_format: "json" },
    });
    assert.deepEqual(json.structuredContent.failed_voucher_fetches, ["B2"]);
    assert.equal(json.structuredContent.matching_transactions, 1);

    const markdown = await client.callTool({
      name: "fortnox_account_activity",
      arguments: { account_number: 1683, financial_year: 11, max_vouchers: 10 },
    });
    assert.match(markdown.content[0].text, /Incomplete\*\*: 1 voucher\(s\) could not be fetched and are missing from the totals: B2/);
  } finally {
    axios.defaults.adapter = originalAdapter;
    await client.close();
  }
});

test("every tool publishes a typed input schema without $ref", async () => {
  const server = createFortnoxMcpServer("read-write");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    const problems = [];
    for (const tool of tools) {
      if (JSON.stringify(tool.inputSchema).includes("$ref")) problems.push(`${tool.name}: uses $ref`);
      for (const [name, prop] of Object.entries(tool.inputSchema.properties || {})) {
        if (prop.type === undefined && prop.enum === undefined && prop.anyOf === undefined) {
          problems.push(`${tool.name}.${name}: no type`);
        }
      }
    }
    assert.deepEqual(problems, []);
  } finally {
    await client.close();
  }
});
