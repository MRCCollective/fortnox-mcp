import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
} from "fs";
import { dirname, join } from "path";

/**
 * OAuth authorization-server state that must survive process restarts:
 * dynamically registered clients, in-progress authorizations, issued
 * authorization codes, and revoked tokens.
 */
export interface PersistedOAuthState {
  clients: Record<string, unknown>;
  pendingAuthorizations: Record<string, unknown>;
  issuedCodes: Record<string, unknown>;
  revokedTokens: string[];
}

const DEFAULT_FILE = "oauth-state.json";

function emptyState(): PersistedOAuthState {
  return {
    clients: {},
    pendingAuthorizations: {},
    issuedCodes: {},
    revokedTokens: [],
  };
}

/**
 * Resolve the directory from the same environment used by the file token
 * storage so both live on the same persistent volume.
 */
function resolveDir(): string | null {
  if (process.env.STATE_FILE_DIR) return process.env.STATE_FILE_DIR;
  if (process.env.TOKEN_FILE_DIR) return process.env.TOKEN_FILE_DIR;
  if (process.env.TOKEN_FILE) return dirname(process.env.TOKEN_FILE);
  return null;
}

/**
 * Returns the path used to persist OAuth state, or null to keep it in memory.
 * State is only persisted when a file-backed location is configured
 * (OAUTH_STATE_FILE, STATE_FILE_DIR, TOKEN_FILE_DIR, or TOKEN_FILE).
 */
export function getOAuthStateFileFromEnv(): string | null {
  if (process.env.OAUTH_STATE_FILE) return process.env.OAUTH_STATE_FILE;
  const dir = resolveDir();
  if (dir) return join(dir, DEFAULT_FILE);
  return null;
}

export function loadOAuthState(file: string): PersistedOAuthState {
  try {
    if (!existsSync(file)) return emptyState();
    const raw = readFileSync(file, "utf-8");
    if (!raw.trim()) return emptyState();
    const parsed = JSON.parse(raw) as Partial<PersistedOAuthState>;
    return {
      clients: parsed.clients ?? {},
      pendingAuthorizations: parsed.pendingAuthorizations ?? {},
      issuedCodes: parsed.issuedCodes ?? {},
      revokedTokens: Array.isArray(parsed.revokedTokens) ? parsed.revokedTokens : [],
    };
  } catch (error) {
    console.error(
      `[OAuthState] Warning: Could not read ${file}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return emptyState();
  }
}

export function saveOAuthState(file: string, state: PersistedOAuthState): void {
  try {
    const dir = dirname(file);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  } catch (error) {
    console.error(
      `[OAuthState] Warning: Could not persist OAuth state to ${file}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}