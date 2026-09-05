import type { IncomingMessage } from "node:http";

export type GuardFailureCode = "NOT_LOOPBACK" | "BAD_HOST" | "BAD_ORIGIN" | "CROSS_SITE_REQUEST";

export interface GuardFailure {
  code: GuardFailureCode;
  message: string;
}

export type GuardResult = { ok: true } | { ok: false; failure: GuardFailure };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** Literal loopback hostnames accepted on the local API boundary. */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

function remoteAddress(req: IncomingMessage): string {
  const raw = req.socket.remoteAddress ?? "";
  return raw.startsWith("::ffff:") ? raw.slice("::ffff:".length) : raw;
}

/** The server socket peer must be a literal loopback address. */
export function isLoopbackPeer(req: IncomingMessage): boolean {
  const peer = remoteAddress(req);
  if (peer === "::1" || peer === "::ffff:127.0.0.1") return true;
  if (peer.toLowerCase() === "localhost") return true;
  const v4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.exec(peer);
  return v4 !== null;
}

function hostHeader(req: IncomingMessage): string | null {
  const host = req.headers.host;
  if (typeof host !== "string" || host.length === 0 || host.length > 256) return null;
  // Strip an optional port suffix, tolerating bracketed IPv6.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(host);
  if (bracketed) return bracketed[1];
  const bare = host.split(",")[0].trim();
  const withoutPort = bare.includes(":") && !bare.includes("::") ? bare.slice(0, bare.lastIndexOf(":")) : bare;
  return withoutPort.length > 0 ? withoutPort : null;
}

function originHostname(origin: string): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const hostname = url.hostname;
  // Node keeps brackets on IPv6 literals (`[::1]`); accept both forms.
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return bare;
}

/**
 * Server-level loopback API guard. Runs on headers and socket state only,
 * before any body consumption or job allocation. Never logs request data.
 */
export function checkApiBoundary(req: IncomingMessage): GuardResult {
  if (!isLoopbackPeer(req)) {
    return { ok: false, failure: { code: "NOT_LOOPBACK", message: "Loopback API is unreachable from this peer." } };
  }
  const host = hostHeader(req);
  if (host === null || !isLoopbackHost(host)) {
    return { ok: false, failure: { code: "BAD_HOST", message: "Unexpected Host for the loopback API." } };
  }
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    const hostname = originHostname(origin);
    if (hostname === null || !isLoopbackHost(hostname)) {
      return { ok: false, failure: { code: "BAD_ORIGIN", message: "Foreign origin rejected by the loopback API." } };
    }
  }
  const fetchSite = req.headers["sec-fetch-site"];
  const site = Array.isArray(fetchSite) ? fetchSite[0] : fetchSite;
  if (typeof site === "string" && site.length > 0 && site !== "same-origin" && site !== "none") {
    return {
      ok: false,
      failure: { code: "CROSS_SITE_REQUEST", message: "Cross-site request rejected by the loopback API." }
    };
  }
  return { ok: true };
}
