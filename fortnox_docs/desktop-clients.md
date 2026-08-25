# Connect Desktop AI Clients

Use the hosted Streamable HTTP MCP endpoint:

```text
https://fortnox-mcp.devosurf.dev/mcp
```

Confirm `https://fortnox-mcp.devosurf.dev/health` returns HTTP 200 before connecting. The server must remain public because both Claude and ChatGPT connect from their cloud infrastructure, not directly from the local desktop process.

## Claude Desktop

Remote custom connectors are available for Claude Free, Pro, Max, Team, and Enterprise accounts; Free accounts are limited to one custom connector. The configuration syncs through the Claude account and works across supported Claude surfaces.

### Individual Free, Pro, or Max account

1. Open Claude Desktop and go to **Customize → Connectors**.
2. Click **+ → Add custom connector**.
3. Name it `Fortnox MCP`.
4. Enter `https://fortnox-mcp.devosurf.dev/mcp`.
5. Leave the advanced OAuth Client ID and Client Secret blank. This server exposes dynamic client registration.
6. Click **Add**, then **Connect** and complete the Fortnox authorization flow.
7. In a conversation, click **+ → Connectors** and enable `Fortnox MCP`.

### Team or Enterprise account

An Owner or Primary Owner first adds the connector under **Organization settings → Connectors → Add → Custom → Web** using the same MCP URL. Each member then opens **Customize → Connectors**, selects the connector, and completes their own OAuth connection.

## ChatGPT

OpenAI's official custom MCP workflow is currently documented for **ChatGPT on the web**, not the native desktop application. Configure and use it at `https://chatgpt.com`; native desktop availability should not be assumed even if some account settings sync.

The UI and plan eligibility are in active rollout. If Developer mode is available:

1. Open ChatGPT web.
2. Enable **Settings → Security and login → Developer mode**. Business/Enterprise/Edu workspaces may instead require an admin to enable it under workspace permissions.
3. Open `https://chatgpt.com/plugins`, click **+**, and create a developer-mode app. Workspace admins can also use **Workspace settings → Apps → Create**.
4. Name it `Fortnox MCP`.
5. Enter `https://fortnox-mcp.devosurf.dev/mcp` as the remote MCP endpoint.
6. Choose **OAuth** authentication and dynamic client registration when offered; do not enter the Fortnox Client ID or Client Secret into ChatGPT.
7. Click **Scan Tools**, complete the browser OAuth flow through Fortnox, then create the draft app.
8. Start a new chat and select **+ → Developer mode → Fortnox MCP** for the message that should use it.

Business/Enterprise/Edu admins may need to review and publish the draft app before other workspace members can use it. ChatGPT freezes the approved tool definitions; after changing this server's tools, refresh/rescan and republish the app.

If Developer mode or app creation is absent, the account or workspace has not received access, the plan is ineligible for that capability, or an administrator has not enabled it. OpenAI's current help and developer pages describe different plan boundaries during the rollout; the visible account controls are authoritative.

## OAuth and read-only behavior

The connector OAuth flow is:

1. Claude or ChatGPT registers with this MCP server.
2. This server redirects the user to Fortnox.
3. Fortnox returns to `https://fortnox-mcp.devosurf.dev/oauth/fortnox/callback`.
4. This server stores the Fortnox tokens and issues its own MCP access and refresh tokens to the client.

The MCP OAuth metadata advertises `offline_access`, and the server issues refresh tokens. Fortnox resource scopes themselves grant both read and write access. `MCP_ACCESS_MODE=read-only` enforces read-only behavior inside this server by hiding write tools and blocking non-GET Fortnox requests.

Remote Fortnox tokens require Upstash REST storage to survive application restarts. Dynamic MCP client registrations and in-progress OAuth state are currently process-local; after a restart, a client may need to disconnect and reconnect.

## Primary sources

- [Claude: Get started with custom connectors using remote MCP](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
- [OpenAI: ChatGPT Developer mode](https://developers.openai.com/api/docs/guides/developer-mode)
- [OpenAI: Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt)
