import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import axios from "axios";
import { SignJWT } from "jose";
import { createRemoteServer } from "../dist/server/remote.js";
import { MemoryTokenStorage } from "../dist/auth/storage/memory.js";

test("overlapping remote MCP requests keep their own response transport", async () => {
  process.env.FORTNOX_CLIENT_ID = "test-client";
  process.env.FORTNOX_CLIENT_SECRET = "test-secret";

  const tokenStorage = new MemoryTokenStorage();
  await tokenStorage.set("test-user", {
    accessToken: "fake-fortnox-token",
    refreshToken: "fake-refresh-token",
    expiresAt: Date.now() + 3600000,
    scope: "invoice",
  });

  const jwtSecret = "test-secret-for-concurrent-mcp-requests";
  const app = createRemoteServer({
    serverUrl: "http://localhost",
    jwtSecret,
    tokenStorage,
    accessMode: "read-only",
  });
  const httpServer = createServer(app);
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));

  const originalAdapter = axios.defaults.adapter;
  let requestStarted;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  let releaseRequest;
  const held = new Promise((resolve) => { releaseRequest = resolve; });
  axios.defaults.adapter = async (config) => {
    requestStarted();
    await held;
    return {
      config,
      status: 200,
      statusText: "OK",
      headers: {},
      data: {
        Customers: [{ CustomerNumber: "1001", Name: "Test Customer" }],
        MetaInformation: { "@TotalResources": 1 },
      },
    };
  };

  try {
    const jwt = await new SignJWT({
      userId: "test-user",
      clientId: "test-client",
      scopes: ["fortnox:read"],
      type: "access",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .setIssuer("http://localhost")
      .sign(new TextEncoder().encode(jwtSecret));

    const { port } = httpServer.address();
    const getResponse = await fetch(`http://127.0.0.1:${port}/mcp`);
    assert.equal(getResponse.status, 405);
    const call = async (body) => {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${jwt}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200);
      return response.json();
    };

    const slowCall = call({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "fortnox_list_customers", arguments: {} },
    });
    await started;
    const quickCall = await call({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    assert.ok(quickCall.result.tools.some((tool) => tool.name === "fortnox_list_customers"));

    releaseRequest();
    const slowResult = await slowCall;
    assert.equal(slowResult.id, 1);
    assert.equal(slowResult.result.structuredContent.customers[0].name, "Test Customer");
  } finally {
    releaseRequest();
    axios.defaults.adapter = originalAdapter;
    await new Promise((resolve) => httpServer.close(resolve));
  }
});
