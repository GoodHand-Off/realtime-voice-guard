// Signed, short-lived, single-use call tickets.
// Format: rvg1.<base64url(JSON claims)>.<base64url(HMAC-SHA256(secret, payload))>

import { createHmac, timingSafeEqual } from "node:crypto";

/** Prefix of every ticket this version signs and accepts. */
export const TICKET_VERSION = "rvg1";
/** Longest ticket accepted, in characters, so it fits in an Authorization header. */
export const MAX_TICKET_LENGTH = 8192;
/** Shortest signing secret accepted. */
export const MIN_SECRET_LENGTH = 32;
/** Allowed call ids: 8 to 64 of A-Z, a-z, 0-9, underscore and hyphen. */
export const CALL_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const MODEL_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/** Printable ASCII without spaces: it goes into an HTTP header, where anything else would fail. */
export const SAFETY_ID_PATTERN = /^[\x21-\x7e]{1,64}$/;
/** Clocks on different instances may disagree by this much. */
export const CLOCK_SKEW_MS = 30_000;

/** What a ticket carries. All of it is covered by the signature. */
export interface TicketClaims {
  /** Your id for this call. Single use: a second connection with it is refused. */
  id: string;
  /** Expiry, in milliseconds since the epoch. */
  exp: number;
  /** Realtime model for the call. It must have an entry in the price table. */
  model: string;
  /** Duration cap in whole seconds. */
  maxSeconds: number;
  /** Estimated spend cap in US dollars. */
  maxCostUsd: number;
  /** Optional OpenAI safety identifier, such as a hash of your user id. Printable ASCII, no spaces, up to 64 characters. */
  sid?: string;
  /** Issue time, in milliseconds since the epoch. {@link signTicket} sets it when missing. */
  iat?: number;
  /** Optional session config, for tickets your backend signs itself. */
  session?: Record<string, unknown>;
  /** Set by POST /v1/tickets: the session is in the ledger, and the call is refused if it is gone. */
  stored?: boolean;
}

/** The server-side ceilings a ticket is checked against. */
export interface TicketLimits {
  /** Current time, in milliseconds since the epoch. */
  now: number;
  /** Longest lifetime a ticket may have from now. */
  maxTtlMs: number;
  /** Highest duration cap accepted. */
  maxSeconds: number;
  /** Highest spend cap accepted. */
  maxCostUsd: number;
}

/** A ticket that is malformed, forged, expired or outside the server's caps. The message says which. */
export class TicketError extends Error {
  constructor(message = "Invalid ticket") {
    super(message);
    this.name = "TicketError";
  }
}

function assertSecret(secret: string): void {
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`Signing secret must be at least ${MIN_SECRET_LENGTH} characters`);
  }
}

const sign = (payload: string, secret: string): Buffer => createHmac("sha256", secret).update(payload).digest();

/** Signs claims into an `rvg1.` ticket. Throws if the secret is short or the ticket would exceed {@link MAX_TICKET_LENGTH}. */
export function signTicket(claims: TicketClaims, secret: string): string {
  assertSecret(secret);
  const payload = Buffer.from(JSON.stringify({ iat: Date.now(), ...claims })).toString("base64url");
  const ticket = `${TICKET_VERSION}.${payload}.${sign(payload, secret).toString("base64url")}`;
  if (ticket.length > MAX_TICKET_LENGTH) throw new Error("Ticket too large; store the session with POST /v1/tickets instead");
  return ticket;
}

/** Verifies signature, expiry and caps. Throws TicketError on any problem. */
export function verifyTicket(ticket: string, secret: string, limits: TicketLimits): TicketClaims {
  assertSecret(secret);
  if (typeof ticket !== "string" || ticket.length > MAX_TICKET_LENGTH) throw new TicketError();
  const [version, payload, signature, ...extra] = ticket.split(".");
  if (version !== TICKET_VERSION || !payload || !signature || extra.length > 0) throw new TicketError();
  const expected = sign(payload, secret);
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new TicketError();

  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new TicketError();
  }
  if (typeof data !== "object" || data === null) throw new TicketError();
  const c = data as Partial<TicketClaims>;
  if (typeof c.exp !== "number" || c.exp <= limits.now) throw new TicketError("Ticket expired");
  if (c.exp > limits.now + limits.maxTtlMs + CLOCK_SKEW_MS) throw new TicketError("Ticket lifetime too long");
  if (typeof c.id !== "string" || !CALL_ID_PATTERN.test(c.id)) throw new TicketError();
  if (typeof c.model !== "string" || !MODEL_PATTERN.test(c.model)) throw new TicketError();
  if (!Number.isInteger(c.maxSeconds) || (c.maxSeconds as number) < 1 || (c.maxSeconds as number) > limits.maxSeconds) {
    throw new TicketError("Ticket duration cap out of range");
  }
  if (typeof c.maxCostUsd !== "number" || !Number.isFinite(c.maxCostUsd) || c.maxCostUsd <= 0 || c.maxCostUsd > limits.maxCostUsd) {
    throw new TicketError("Ticket spend cap out of range");
  }
  if (c.sid !== undefined && (typeof c.sid !== "string" || !SAFETY_ID_PATTERN.test(c.sid))) throw new TicketError("Invalid safety identifier");
  if (c.iat !== undefined && (typeof c.iat !== "number" || !Number.isFinite(c.iat))) throw new TicketError();
  if (c.session !== undefined && (typeof c.session !== "object" || c.session === null || Array.isArray(c.session))) {
    throw new TicketError();
  }
  if (c.stored !== undefined && typeof c.stored !== "boolean") throw new TicketError();
  return c as TicketClaims;
}
