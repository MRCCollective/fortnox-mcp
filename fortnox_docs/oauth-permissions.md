# Fortnox OAuth Permissions

## Remote redirect URI

Remote deployments register exactly:

```text
<SERVER_URL>/oauth/fortnox/callback
```

For the Devosurf deployment:

```text
https://fortnox-mcp.devosurf.dev/oauth/fortnox/callback
```

The URI must match the Fortnox Developer Portal value exactly. `src/auth/oauthProvider.ts` builds this URI from `SERVER_URL`, and `src/server/remote.ts` serves the callback route. The separate local token helper uses `http://localhost:8888/callback`.

## Required portal permissions

Select these ten permissions for the current tool surface:

| Portal permission | OAuth scope | Used for |
|---|---|---|
| Bokföring | `bookkeeping` | Accounts, vouchers, voucher series, financial years |
| Företagsinformation | `companyinformation` | Company information |
| Kostnadsställe | `costcenter` | Cost-center analytics |
| Kund | `customer` | Customers |
| Faktura | `invoice` | Invoices and invoice analytics |
| Offert | `offer` | Offers and sales-funnel analytics |
| Order | `order` | Orders and order-pipeline analytics |
| Projekt | `project` | Project analytics |
| Leverantör | `supplier` | Suppliers |
| Leverantörsfaktura | `supplierinvoice` | Supplier invoices, payables, and payment approval |

These scopes are defined once in `src/auth/credentials.ts` and reused by the hosted OAuth flow and `scripts/get-token.ts`.

Do not select unrelated permissions such as Artikel, Betalningar, Ta bort verifikat, Pris, or Lager unless new tools start calling those resource families. The current supplier-invoice payment-approval operation uses the `/3/supplierinvoices/.../approvalpayment` resource and therefore the Supplier Invoice scope.

## Read-only limitation

Fortnox states that every resource scope grants both read and write access; Fortnox does not issue read-only resource scopes. Therefore the Fortnox scope selection is the same for this server's `read-only` and `read-write` modes: surviving read tools use all ten resource families.

`MCP_ACCESS_MODE=read-only` enforces read-only behavior inside this server by hiding non-read-only tools and rejecting Fortnox `POST`, `PUT`, and `DELETE` requests. It does not reduce the permissions encoded in the Fortnox access token. Treat stored Fortnox tokens as write-capable secrets.

The portal's service-account option is not required by the current hosted flow. The authorization request does not send `account_type=service`; it uses normal interactive user authorization.

Changing portal permissions or requested scopes requires a new authorization code. Reconnect/re-authorize the MCP client after changing the scope list.

## Primary sources

- [Fortnox scopes](https://www.fortnox.se/developer/guides-and-good-to-know/scopes): scope names, resource mapping, licence requirements, and absence of read-only scopes.
- [Fortnox authorization-code flow](https://www.fortnox.se/developer/authorization/get-authorization-code): exact redirect matching, scope encoding, offline access, and optional service accounts.
- `src/auth/credentials.ts`: requested Fortnox scopes.
- `src/auth/oauthProvider.ts`: hosted redirect construction and scope request.
- `src/tools/*.ts`: resource endpoints used by the MCP tools.
