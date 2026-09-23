import { Response } from "express";
import * as jose from "jose";
import crypto from "crypto";
import {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { ITokenStorage } from "./storage/types.js";
import { DatabaseTokenProvider } from "./databaseProvider.js";
import { FORTNOX_SCOPES } from "./credentials.js";
import {
  getOAuthStateFileFromEnv,
  loadOAuthState,
  saveOAuthState,
} from "./oauthStateStore.js";

// JWT configuration
const JWT_ALGORITHM = "HS256";
const ACCESS_TOKEN_EXPIRES_IN = 3600; // 1 hour
const REFRESH_TOKEN_EXPIRES_IN = 90 * 24 * 3600; // 90 days

// Links MCP <-> Fortnox OAuth
interface PendingAuthorization {
  mcpClient: OAuthClientInformationFull;
  mcpParams: AuthorizationParams;
  codeChallenge: string;
  createdAt: number;
}

interface IssuedCode {
  userId: string;
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  createdAt: number;
}

/**
 * MCP OAuth provider that proxies authentication to Fortnox
 *
 * Flow:
 * 1. Claude calls /authorize on this server
 * 2. We redirect to Fortnox OAuth
 * 3. User authorizes in Fortnox
 * 4. Fortnox redirects to our /oauth/fortnox/callback
 * 5. We store Fortnox tokens and redirect back to Claude with our auth code
 * 6. Claude exchanges our auth code for our JWT access token
 * 7. Claude uses our JWT for /mcp requests
 * 8. We verify JWT and use stored Fortnox tokens for API calls
 */
export class FortnoxProxyOAuthProvider implements OAuthServerProvider {
  private jwtSecret: Uint8Array;
  private serverUrl: string;
  private tokenProvider: DatabaseTokenProvider;
  private _clientsStore: InMemoryClientsStore;

  // Authorization-server state. Hydrated from disk (when a state file is
  // configured) and written through on every change so a restart does not
  // force MCP clients to re-register and re-authorize.
  private pendingAuthorizations: Map<string, PendingAuthorization>;
  private issuedCodes: Map<string, IssuedCode>;
  private revokedTokens: Set<string>;
  private stateFile: string | null;

  // Skip local PKCE validation since we handle it ourselves
  skipLocalPkceValidation = false;

  constructor(
    jwtSecret: string,
    serverUrl: string,
    tokenStorage: ITokenStorage,
    stateFile: string | null = getOAuthStateFileFromEnv()
  ) {
    this.jwtSecret = new TextEncoder().encode(jwtSecret);
    this.serverUrl = serverUrl;
    this.tokenProvider = new DatabaseTokenProvider(tokenStorage);
    this.stateFile = stateFile;

    const persisted = stateFile ? loadOAuthState(stateFile) : null;
    this.pendingAuthorizations = new Map(
      Object.entries(persisted?.pendingAuthorizations ?? {}) as [
        string,
        PendingAuthorization,
      ][]
    );
    this.issuedCodes = new Map(
      Object.entries(persisted?.issuedCodes ?? {}) as [string, IssuedCode][]
    );
    this.revokedTokens = new Set(persisted?.revokedTokens ?? []);
    this._clientsStore = new InMemoryClientsStore(
      (persisted?.clients ?? {}) as Record<string, OAuthClientInformationFull>,
      () => this.persist()
    );
  }

  /**
   * Persist all authorization-server state to disk (no-op when no state file
   * is configured, e.g. memory-only deployments).
   */
  private persist(): void {
    if (!this.stateFile) return;
    saveOAuthState(this.stateFile, {
      clients: this._clientsStore.toJSON(),
      pendingAuthorizations: Object.fromEntries(this.pendingAuthorizations),
      issuedCodes: Object.fromEntries(this.issuedCodes),
      revokedTokens: [...this.revokedTokens],
    });
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this._clientsStore;
  }

  getTokenProvider(): DatabaseTokenProvider {
    return this.tokenProvider;
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    // Generate state to link MCP request to Fortnox OAuth
    const oauthState = crypto.randomUUID();

    // Store pending authorization
    this.pendingAuthorizations.set(oauthState, {
      mcpClient: client,
      mcpParams: params,
      codeChallenge: params.codeChallenge,
      createdAt: Date.now(),
    });

    // Clean up old pending authorizations (older than 10 minutes)
    this.cleanupPendingAuthorizations();
    this.persist();

    // Redirect to Fortnox OAuth
    const fortnoxAuthUrl = this.tokenProvider.getAuthorizationUrl(
      `${this.serverUrl}/oauth/fortnox/callback`,
      FORTNOX_SCOPES,
      oauthState
    );

    res.redirect(fortnoxAuthUrl);
  }

  async handleFortnoxCallback(
    code: string,
    state: string
  ): Promise<{ redirectUri: string; code: string; state?: string }> {
    // Look up pending authorization
    const pending = this.pendingAuthorizations.get(state);
    if (!pending) {
      throw new Error("Invalid or expired OAuth state");
    }

    // Remove from pending
    this.pendingAuthorizations.delete(state);

    // Exchange Fortnox code for tokens
    // Generate a unique user ID based on client ID and a random component
    const userId = `${pending.mcpClient.client_id}:${crypto.randomUUID()}`;

    await this.tokenProvider.exchangeAuthorizationCode(
      code,
      `${this.serverUrl}/oauth/fortnox/callback`,
      userId
    );

    // Issue our own authorization code
    const mcpAuthCode = crypto.randomUUID();
    this.issuedCodes.set(mcpAuthCode, {
      userId,
      clientId: pending.mcpClient.client_id,
      codeChallenge: pending.codeChallenge,
      redirectUri: pending.mcpParams.redirectUri,
      scopes: pending.mcpParams.scopes || [],
      createdAt: Date.now(),
    });

    // Clean up old codes
    this.cleanupIssuedCodes();
    this.persist();

    return {
      redirectUri: pending.mcpParams.redirectUri,
      code: mcpAuthCode,
      state: pending.mcpParams.state,
    };
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const issued = this.issuedCodes.get(authorizationCode);
    if (!issued) {
      throw new Error("Invalid authorization code");
    }
    return issued.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    _redirectUri?: string,
    _resource?: URL
  ): Promise<OAuthTokens> {
    const issued = this.issuedCodes.get(authorizationCode);
    if (!issued) {
      throw new Error("Invalid authorization code");
    }

    // Verify client
    if (issued.clientId !== client.client_id) {
      throw new Error("Client mismatch");
    }

    // Remove used code
    this.issuedCodes.delete(authorizationCode);
    this.persist();

    // Check if code is expired (5 minutes)
    if (Date.now() - issued.createdAt > 5 * 60 * 1000) {
      throw new Error("Authorization code expired");
    }

    // Issue JWT tokens
    return this.issueTokens(issued.userId, issued.clientId, issued.scopes);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    _resource?: URL
  ): Promise<OAuthTokens> {
    // Verify refresh token
    const payload = await this.verifyToken(refreshToken, "refresh");

    if (payload.clientId !== client.client_id) {
      throw new Error("Client mismatch");
    }

    // Check if revoked
    if (this.revokedTokens.has(refreshToken)) {
      throw new Error("Token has been revoked");
    }

    // Issue new tokens
    return this.issueTokens(
      payload.userId,
      payload.clientId,
      scopes || payload.scopes
    );
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // Check if revoked
    if (this.revokedTokens.has(token)) {
      throw new Error("Token has been revoked");
    }

    const payload = await this.verifyToken(token, "access");

    return {
      token,
      clientId: payload.clientId,
      scopes: payload.scopes,
      expiresAt: payload.exp,
      extra: {
        userId: payload.userId,
      },
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    this.revokedTokens.add(request.token);
    this.persist();
  }

  private async issueTokens(
    userId: string,
    clientId: string,
    scopes: string[]
  ): Promise<OAuthTokens> {
    const now = Math.floor(Date.now() / 1000);

    // Create access token
    const accessToken = await new jose.SignJWT({
      userId,
      clientId,
      scopes,
      type: "access",
    })
      .setProtectedHeader({ alg: JWT_ALGORITHM })
      .setIssuedAt()
      .setExpirationTime(now + ACCESS_TOKEN_EXPIRES_IN)
      .setIssuer(this.serverUrl)
      .sign(this.jwtSecret);

    // Create refresh token
    const refreshToken = await new jose.SignJWT({
      userId,
      clientId,
      scopes,
      type: "refresh",
    })
      .setProtectedHeader({ alg: JWT_ALGORITHM })
      .setIssuedAt()
      .setExpirationTime(now + REFRESH_TOKEN_EXPIRES_IN)
      .setIssuer(this.serverUrl)
      .sign(this.jwtSecret);

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_EXPIRES_IN,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }

  private async verifyToken(
    token: string,
    expectedType: "access" | "refresh"
  ): Promise<{
    userId: string;
    clientId: string;
    scopes: string[];
    exp: number;
  }> {
    try {
      const { payload } = await jose.jwtVerify(token, this.jwtSecret, {
        issuer: this.serverUrl,
      });

      if (payload.type !== expectedType) {
        throw new Error(`Expected ${expectedType} token`);
      }

      return {
        userId: payload.userId as string,
        clientId: payload.clientId as string,
        scopes: payload.scopes as string[],
        exp: payload.exp as number,
      };
    } catch (error) {
      if (error instanceof jose.errors.JWTExpired) {
        throw new Error("Token expired");
      }
      throw new Error("Invalid token");
    }
  }

  private cleanupPendingAuthorizations(): void {
    const maxAge = 10 * 60 * 1000; // 10 minutes
    const now = Date.now();

    for (const [state, pending] of this.pendingAuthorizations) {
      if (now - pending.createdAt > maxAge) {
        this.pendingAuthorizations.delete(state);
      }
    }
  }

  private cleanupIssuedCodes(): void {
    const maxAge = 5 * 60 * 1000; // 5 minutes
    const now = Date.now();

    for (const [code, issued] of this.issuedCodes) {
      if (now - issued.createdAt > maxAge) {
        this.issuedCodes.delete(code);
      }
    }
  }
}

// Dynamic client registration store
class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private clients: Map<string, OAuthClientInformationFull>;

  constructor(
    initial?: Record<string, OAuthClientInformationFull>,
    private readonly onPersist?: () => void
  ) {
    this.clients = new Map(Object.entries(initial ?? {}));
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">
  ): OAuthClientInformationFull {
    const clientId = `client_${crypto.randomUUID()}`;
    const fullClient: OAuthClientInformationFull = {
      ...client,
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };

    this.clients.set(clientId, fullClient);
    this.onPersist?.();
    return fullClient;
  }

  toJSON(): Record<string, OAuthClientInformationFull> {
    return Object.fromEntries(this.clients);
  }
}

export function getUserIdFromAuth(auth: AuthInfo): string | undefined {
  return auth.extra?.userId as string | undefined;
}
