import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
} from "fs";
import { dirname, join } from "path";
import { TokenInfo } from "../types.js";
import { ITokenStorage, StoredTokenInfo } from "./types.js";

const DEFAULT_TOKEN_DIR = "/home/data";
const DEFAULT_TOKEN_FILE = "tokens.json";

/**
 * File-based token storage.
 *
 * Intended for a single, long-lived instance where a persistent volume (for
 * example App Service Linux `/home`) is mounted. Tokens for all users are kept
 * in one JSON object keyed by userId. Reads and writes are synchronous, so
 * operations cannot interleave within the Node process; writes are written to a
 * temporary file and renamed into place to avoid partial files.
 */
export class FileTokenStorage implements ITokenStorage {
  private readonly file: string;
  private readonly dir: string;

  constructor(file?: string) {
    this.file =
      file ||
      process.env.TOKEN_FILE ||
      join(process.env.TOKEN_FILE_DIR || DEFAULT_TOKEN_DIR, DEFAULT_TOKEN_FILE);
    this.dir = dirname(this.file);
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    }
  }

  private readAll(): Record<string, StoredTokenInfo> {
    try {
      if (!existsSync(this.file)) return {};
      const raw = readFileSync(this.file, "utf-8");
      if (!raw.trim()) return {};
      return JSON.parse(raw) as Record<string, StoredTokenInfo>;
    } catch (error) {
      console.error(
        `[Storage] Warning: Could not read token file ${this.file}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return {};
    }
  }

  private writeAll(all: Record<string, StoredTokenInfo>): void {
    this.ensureDir();
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  async get(userId: string): Promise<TokenInfo | null> {
    const stored = this.readAll()[userId];
    if (!stored) return null;
    return {
      accessToken: stored.accessToken,
      refreshToken: stored.refreshToken,
      expiresAt: stored.expiresAt,
      scope: stored.scope,
    };
  }

  async set(userId: string, tokens: TokenInfo): Promise<void> {
    const all = this.readAll();
    const existing = all[userId];
    const now = Date.now();
    all[userId] = {
      ...tokens,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    this.writeAll(all);
  }

  async delete(userId: string): Promise<void> {
    const all = this.readAll();
    if (all[userId]) {
      delete all[userId];
      this.writeAll(all);
    }
  }

  async exists(userId: string): Promise<boolean> {
    return Boolean(this.readAll()[userId]);
  }
}
