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
