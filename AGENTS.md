# Repository Guidelines

## Project Overview

`fortnox-mcp-server` is a TypeScript Model Context Protocol server for the Fortnox Swedish accounting API. It exposes roughly 45 `fortnox_*` tools for customers, invoices, suppliers, supplier invoices, orders, accounts, vouchers, company data, analytics, and BI reporting.

The same tool surface runs in two modes:

- **Local** (default): stdio or stateless HTTP, using Fortnox credentials and a refresh token from the environment/local token file.
- **Remote** (`AUTH_MODE=remote`): OAuth-protected HTTP, per-user Fortnox tokens, JWT sessions, and optional Upstash Redis persistence. Vercel uses this mode through `api/index.ts`.

## Architecture & Data Flow

The code is layered rather than framework-heavy:

1. **Transport:** `src/index.ts` starts local stdio, local HTTP, or the remote server. `api/index.ts` is the Vercel wrapper. `src/server/remote.ts` owns remote Express/OAuth routes.
2. **Tool registration/access control:** `src/server/mcpServer.ts` creates the shared MCP server and registers every tool group once. In `MCP_ACCESS_MODE=read-only`, it disables tools unless their annotations explicitly set `readOnlyHint: true`.
3. **Services:** `src/services/api.ts` is the only Fortnox HTTP gateway. It resolves auth, enforces the 25-requests/5-seconds rate limit, normalizes API errors, implements bounded pagination, and blocks non-GET requests in read-only mode.
4. **Authentication/state:** `src/auth/index.ts` provides the module-level `ITokenProvider` dependency-injection seam. Local mode uses `EnvVarTokenProvider`; remote mode uses `DatabaseTokenProvider` with an injected `ITokenStorage`. `src/auth/context.ts` carries the remote `userId` through `AsyncLocalStorage`.

Typical remote flow:

`POST /mcp` → bearer/JWT verification → `runWithContext({ userId })` → tool handler → `fortnoxRequest()` → token provider/storage → Fortnox API → normalized structured output plus Markdown/JSON text.

Typical local flow omits bearer auth and tenant context; the same handlers obtain tokens from the local provider.

Preserve these architecture invariants:

- Register every new tool group once in `createFortnoxMcpServer()` in `src/server/mcpServer.ts`; both local and remote transports use this factory.
- Route every Fortnox request through `fortnoxRequest()` or `fetchAllPages()`; direct Axios calls bypass auth, rate limiting, access-mode enforcement, and error normalization.
- Keep remote MCP handling inside `runWithContext()`. Without it, the per-user token provider receives no `userId`.
- Keep tool errors inside the MCP contract: catch failures and return `buildErrorResponse(error)` rather than throwing across the tool boundary.
- Preserve `fetchAllPages()` caps and expose its truncation metadata in aggregation results.

## Key Directories

- `src/tools/`: domain tool registrations and raw Fortnox response interfaces. `biAnalytics.ts` contains the largest client-side aggregation surface.
- `src/schemas/`: strict Zod schemas paired by domain with `src/tools/`.
- `src/services/`: Fortnox HTTP, response formatting, dates, and in-process aggregation.
- `src/auth/`: OAuth providers, token-provider DI, request context, local persistence, and storage implementations.
- `src/server/`: remote Express/MCP server composition.
- `api/`: Vercel serverless adapter; it is outside `tsconfig.json`'s `src/**/*` include.
- `scripts/`: interactive token acquisition and destructive release automation.
- `evaluations/`: LLM-oriented QA fixtures; these are not executable automated tests.
- `fortnox_docs/`: checked-in Fortnox API reference JSON. It is a developer reference, not a generated type source or runtime input.
- `dist/`: generated build output; do not edit or commit it.

## Development Commands

Run commands from the repository root:

```bash
npm ci                              # install exactly from package-lock.json
npm run dev                         # tsx watch src/index.ts; defaults to local stdio
TRANSPORT=http PORT=3000 npm run dev # local HTTP mode; requires valid Fortnox auth
npm run build                       # strict TypeScript compile, src/ -> dist/
npm start                           # run compiled dist/index.js; build first
npm run clean                       # remove dist/
npx tsx scripts/get-token.ts        # interactive OAuth helper on localhost:8888
```

There is no `npm test`, lint, format, or standalone typecheck script. `npm run build` is the configured compile gate.

Do not run `npm run release*` during normal development. `scripts/release.sh` changes versions, commits, tags, publishes to npm and the MCP Registry, and pushes Git refs. It requires a clean tree plus external npm and `mcp-publisher` authentication.

## Code Conventions & Common Patterns

- Use strict TypeScript, two-space indentation, double quotes, semicolons, and the surrounding file's trailing-comma style. No formatter or linter enforces style.
- This is native ESM (`"type": "module"`, Node16 resolution). Relative TypeScript imports must include the emitted `.js` extension, for example `../services/api.js`.
- Use lower-camel-case domain filenames such as `supplierInvoices.ts` and `biAnalytics.ts`; exported registration functions follow `register<Domain>Tools`.
- Name MCP tools `fortnox_<verb>_<noun>`. Supply `title`, detailed `description`, `inputSchema`, and all four MCP annotations: `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`. `readOnlyHint` is security-relevant: only tools explicitly marked `true` are exposed in read-only mode.
- Define inputs with `z.object(...).strict()`. Give every field a useful `.describe()` because descriptions are part of the MCP client interface. Export the inferred `<Operation>Input` type.
- Keep Fortnox wire shapes local to the relevant tool file: raw API fields are PascalCase; public structured output is normalized to snake_case with explicit `null` values where appropriate.
- Tool handlers are `async`, validate through the registered schema, await service calls, build a stable `output` object, select Markdown or JSON via `response_format`, then return `buildToolResponse(text, output)`.
- Put cross-cutting limits and enums in `src/constants.ts`. Reuse `src/services/formatters.ts`, `dateHelpers.ts`, and `aggregationHelpers.ts` instead of adding parallel conventions.
- State is intentionally narrow: a module-level token-provider singleton is the DI point, `AsyncLocalStorage` carries tenant context, the rate limiter is in process, and token refresh promises deduplicate concurrent refreshes. Preserve per-user keys in remote state.
- `ITokenStorage` is the persistence seam. Remote mode without Redis falls back to memory and loses tokens on restart; pending OAuth authorization/code state is also process-local.
- Preserve explicit `[LIMITED]` caveats in BI tool descriptions unless the underlying Fortnox data limitation is actually resolved.

## Important Files

- `package.json` / `package-lock.json`: scripts, Node requirement, package metadata, and npm dependency lock.
- `tsconfig.json`: strict ES2022/Node16 compile contract; emits declarations and source maps from `src/` to `dist/`.
- `src/index.ts`: CLI entry point, local transports, and mode selection.
- `api/index.ts`: memoized Vercel handler around the remote Express app.
- `src/server/mcpServer.ts`: shared tool registration and tool-discovery access control.
- `src/server/remote.ts`: remote OAuth routes, bearer protection, and tenant context.
- `src/accessMode.ts`: strict `MCP_ACCESS_MODE` parsing and the Fortnox write-request guard.
- `src/config.ts`: `AUTH_MODE`, `TRANSPORT`, `MCP_ACCESS_MODE`, `PORT`, `SERVER_URL`, and `JWT_SECRET` parsing.
- `src/constants.ts`: API URLs, rate limits, pagination/aggregation safety caps, and response formats.
- `src/services/api.ts`: centralized Fortnox request, rate-limit, pagination, and API-error behavior.
- `src/services/formatters.ts`: canonical MCP success/error envelopes and response truncation.
- `src/auth/types.ts`, `src/auth/index.ts`, `src/auth/context.ts`: auth contracts, provider injection, and tenant propagation.
- `server.json`: MCP Registry manifest. Keep its version aligned with `package.json`.
- `vercel.json`: Vercel build, rewrite, and CORS configuration.
- `README.md`: supported tools, environment variables, deployment, OAuth, and release procedures.

When changing version metadata, inspect `package.json`, `server.json`, and the hard-coded `McpServer` version in `src/server/mcpServer.ts`; the release script does not update the server metadata.

## Runtime/Tooling Preferences

- Required runtime: Node.js 18 or newer. Use npm and preserve `package-lock.json`; do not introduce Bun, pnpm, or Yarn lockfiles.
- Development executes TypeScript through `tsx`; production executes compiled JavaScript through Node.
- Keep secrets in environment variables or ignored `.env*` files. `MCP_ACCESS_MODE` accepts only `read-only` or `read-write` and defaults to `read-write`; invalid values fail startup. No `.env.example` exists, so use the variable tables in `README.md`.
- Local tokens persist to `~/.fortnox-mcp/tokens.json` with restrictive permissions because Fortnox rotates refresh tokens. Do not treat the original environment refresh token as permanently reusable.
- Production remote deployments should configure Upstash Redis. The in-memory storage fallback is development-only in practice.
- `@upstash/redis` is optional and dynamically loaded; do not make local/stdio operation depend on Redis.
- Treat `fortnox_docs/fortnox_api.json` as potentially stale reference material and confirm behavior against the implemented API shapes or current Fortnox documentation before expanding the tool surface.

## Testing & QA

No automated unit/integration test framework, test files, CI workflow, coverage tool, or coverage threshold is configured. The ignored `coverage/` directory does not imply an active coverage policy.

For every change:

1. Run `npm run build`. This checks `src/**/*` only; it does **not** type-check `api/index.ts`.
2. For transport/auth/tool behavior, smoke-test the affected mode with valid credentials and exercise the changed MCP tool or endpoint. For local HTTP, verify `/health` and then the changed `/mcp` call.
3. When adding or changing tools, verify both `read-only` and `read-write` discovery plus the non-GET request guard.
4. If BI behavior changes, update relevant cases in `evaluations/bi_tools_evaluation.xml`. No repository command runs these QA pairs; they are agentic/manual evaluation fixtures.

If adding an automated test suite, select and configure a framework explicitly rather than assuming Jest/Vitest conventions. Prefer tests around observable tool responses, schema rejection, pagination/truncation, error envelopes, token isolation, and auth-context propagation.