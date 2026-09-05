import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const SESSION_COOKIE = "pc_session";
export const LAUNCH_TOKEN_HEADER = "x-launch-token";
/** Short-lived launch token budget (Initial Safety Limits session rule). */
export const TOKEN_TTL_MS = 5 * 60 * 1000;
/** Browser session budget backing the SameSite=Strict cookie. */
export const SESSION_TTL_MS = 60 * 60 * 1000;

export interface SessionRecord {
  id: string;
  createdAt: number;
  expiresAt: number;
}

export interface TokenRecord {
  token: string;
  sessionId: string;
  createdAt: number;
  expiresAt: number;
}

export type TokenCheck = "ok" | "missing" | "invalid" | "expired";

export interface SessionStoreOptions {
  sessionTtlMs?: number;
  tokenTtlMs?: number;
  now?: () => number;
}

function randomHandle(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

/**
 * Browser session plus short-lived launch-token store. Tokens are random,
 * bound to one session id, and expire quickly; the session itself rides a
 * `SameSite=Strict`, `HttpOnly`, `Path=/` cookie. Tokens, handles, paths,
 * and filenames are never logged by this module.
 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly tokens = new Map<string, TokenRecord>();
  private readonly sessionTtlMs: number;
  private readonly tokenTtlMs: number;
  private readonly now: () => number;

  constructor(options: SessionStoreOptions = {}) {
    this.sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
    this.tokenTtlMs = options.tokenTtlMs ?? TOKEN_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  issueSession(): SessionRecord {
    this.sweep();
    const at = this.now();
    const record: SessionRecord = {
      id: randomHandle(16),
      createdAt: at,
      expiresAt: at + this.sessionTtlMs
    };
    this.sessions.set(record.id, record);
    return record;
  }

  cookieFor(sessionId: string): string {
    return `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Strict`;
  }

  sessionFromRequest(req: IncomingMessage): string | null {
    const header = req.headers.cookie;
    if (typeof header !== "string") return null;
    for (const part of header.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === SESSION_COOKIE) {
        const value = rest.join("=").trim();
        if (/^[0-9a-f]{32}$/.test(value)) return value;
        return null;
      }
    }
    return null;
  }

  tokenFromRequest(req: IncomingMessage): string | null {
    const header = req.headers[LAUNCH_TOKEN_HEADER];
    const value = Array.isArray(header) ? header[0] : header;
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return /^[0-9a-f]{64}$/.test(trimmed) ? trimmed : null;
  }

  hasSession(sessionId: string): boolean {
    const record = this.sessions.get(sessionId);
    if (!record) return false;
    if (record.expiresAt <= this.now()) {
      this.sessions.delete(sessionId);
      return false;
    }
    return true;
  }

  issueToken(sessionId: string): TokenRecord | null {
    this.sweep();
    if (!this.hasSession(sessionId)) return null;
    const at = this.now();
    const record: TokenRecord = {
      token: randomHandle(32),
      sessionId,
      createdAt: at,
      expiresAt: at + this.tokenTtlMs
    };
    this.tokens.set(record.token, record);
    return record;
  }

  verify(sessionId: string | null, token: string | null): TokenCheck {
    if (!sessionId || !token) return "missing";
    const record = this.tokens.get(token);
    if (!record || record.sessionId !== sessionId) return "invalid";
    if (!this.hasSession(sessionId)) return "expired";
    if (record.expiresAt <= this.now()) {
      this.tokens.delete(token);
      return "expired";
    }
    return "ok";
  }

  revokeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    for (const [token, record] of this.tokens) {
      if (record.sessionId === sessionId) this.tokens.delete(token);
    }
  }

  sweep(): void {
    const at = this.now();
    for (const [id, record] of this.sessions) {
      if (record.expiresAt <= at) {
        this.sessions.delete(id);
        for (const [token, tokenRecord] of this.tokens) {
          if (tokenRecord.sessionId === id) this.tokens.delete(token);
        }
      }
    }
    for (const [token, record] of this.tokens) {
      if (record.expiresAt <= at) this.tokens.delete(token);
    }
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  tokenCount(): number {
    return this.tokens.size;
  }
}
