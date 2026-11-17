// Who gets in: rate limits, origins, the API key, ticket checks, capacity,
// prices, the single-use claim and the shutdown gate. Shared by the HTTP
// routes and the WebSocket upgrade.

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { capShortfall, responseLimits } from "./budget.js";
import { buildSession, transcriptionModel, type GuardContext } from "./call.js";
import { HttpError, bearer, describeError, digest, isObject } from "./http.js";
import type { SessionConfig } from "./ledger.js";
import { RateLimiter, clientAddress, limitKey } from "./rate-limit.js";
import { TicketError, verifyTicket, type TicketClaims } from "./ticket.js";

export interface Admission {
  /** Counts an attempt from this client; throws 429 once it is over the limit. */
  limit(req: IncomingMessage): void;
  /** Throws 401 (or 429 after repeated failures) unless the request carries GUARD_API_KEY. */
  requireApiKey(req: IncomingMessage): void;
  /** CORS headers for an allowed origin, `{}` without an Origin header, undefined for a refused origin. */
  cors(req: IncomingMessage): Record<string, string> | undefined;
  /**
   * Throws 400 unless every model the session would bill for has a price, the
   * session loads no stored prompt, and `maxCostUsd` covers two worst-case
   * responses. Without `maxCostUsd`, only the prices are checked.
   */
  assertSession(model: string, session: SessionConfig | undefined, maxCostUsd?: number): void;
  /** Cheap checks before any I/O: shutdown, signature, expiry, caps, restart replay, capacity and the session. */
  precheck(req: IncomingMessage): TicketClaims;
  /** Claims the ticket once and returns its session: the stored one (checked against the ticket's cap), or the ticket's own. */
  claim(claims: TicketClaims): Promise<SessionConfig | undefined>;
  /** Records a claimed ticket that never became a call. */
  settleUnconnected(id: string): Promise<void>;
  /** Counts a request in progress toward capacity. Call the returned function once (later calls are no-ops). */
  enter(): () => void;
  /** Requests between enter() and their release. */
  readonly admitting: number;
  /** Refuses new calls from now on. */
  close(): void;
  readonly closing: boolean;
}

export function createAdmission(ctx: GuardContext, startedAt: number): Admission {
  const { config, log, now } = ctx;
  const apiKeyDigest = digest(config.apiKey.reveal());
  const limiter = new RateLimiter(config.rateLimitPerMinute, now);
  let admitting = 0;
  let closing = false;

  const limit = (req: IncomingMessage) => {
    const wait = limiter.take(limitKey(clientAddress(req, config.trustedProxies)));
    if (wait > 0) throw new HttpError(429, "rate_limited", "Too many attempts from this address; retry later", { "Retry-After": String(wait) });
  };

  const assertSession = (model: string, session: SessionConfig | undefined, maxCostUsd?: number) => {
    if (!config.prices.models[model]) throw new HttpError(400, "model_not_priced", `No price entry for model ${model}`);
    const asr = transcriptionModel(session);
    if (asr && !config.prices.transcription[asr]) throw new HttpError(400, "transcription_not_priced", `No price entry for transcription model ${asr}`);
    if (maxCostUsd === undefined) return;
    // A stored prompt's instructions, or an MCP server's tool list, can't be counted, so no reservation could cover them.
    if (isObject(session?.prompt)) throw new HttpError(400, "prompt_not_supported", "session.prompt can't be bounded by the guard; put the instructions in session.instructions");
    if (Array.isArray(session?.tools) && session.tools.some((tool) => isObject(tool) && tool.type === "mcp")) {
      throw new HttpError(400, "mcp_not_supported", "MCP tools can't be bounded by the guard: their definitions come from the server at run time; declare function tools instead");
    }
    const shortfall = capShortfall(config.prices, model, responseLimits(buildSession(session, model, config.maxOutputTokens, config.maxInputTokens)), maxCostUsd);
    if (shortfall) throw new HttpError(400, "invalid_max_cost_usd", `max_cost_usd ${shortfall}`);
  };

  const settleUnconnected = (id: string) =>
    ctx.ledger.settle(id, { reason: "not_connected", monitoringComplete: true, now: now() }).then(
      () => undefined,
      (error: unknown) => log.error("ledger.settle_failed", { call: id, reason: "not_connected", error: describeError(error) }),
    );

  return {
    limit,
    assertSession,
    settleUnconnected,

    requireApiKey(req) {
      if (timingSafeEqual(digest(bearer(req)), apiKeyDigest)) return;
      // Only failed attempts count, so a busy backend is never throttled.
      limit(req);
      throw new HttpError(401, "unauthorized", "Missing or wrong API key");
    },

    cors(req): Record<string, string> | undefined {
      const origin = req.headers.origin;
      if (!origin) return {};
      if (!config.allowedOrigins.includes(origin) && !config.allowedOrigins.includes("*")) return undefined;
      return { "Access-Control-Allow-Origin": origin, Vary: "Origin", "Access-Control-Expose-Headers": "Location" };
    },

    precheck(req) {
      if (closing) throw new HttpError(503, "shutting_down", "This instance is shutting down; retry shortly", { "Retry-After": "5" });
      let claims: TicketClaims;
      try {
        claims = verifyTicket(bearer(req), config.signingSecret.reveal(), {
          now: now(),
          maxTtlMs: config.ticketTtlSeconds * 1000,
          maxSeconds: config.maxCallSeconds,
          maxCostUsd: config.maxCallCostUsd,
        });
      } catch (error) {
        throw new HttpError(401, "invalid_ticket", error instanceof TicketError ? error.message : "Invalid ticket");
      }
      // The in-memory ledger forgets used tickets on restart, so a ticket issued before this process started could be replayed.
      // No clock-skew allowance here: a backend whose clock runs behind sees its tickets refused for that long after a restart.
      const issuedAt = claims.iat ?? claims.exp - config.ticketTtlSeconds * 1000;
      if (ctx.ledger.kind === "memory" && issuedAt < startedAt) {
        throw new HttpError(401, "invalid_ticket", "Ticket was issued before this instance started; mint a new one");
      }
      // `admitting` already counts the request being checked.
      if (ctx.active.size + admitting > config.maxConcurrentCalls) throw new HttpError(503, "at_capacity", "Too many live calls; retry shortly", { "Retry-After": "5" });
      // An inline session is checked here, before any I/O; a stored one once claim() has read it.
      assertSession(claims.model, claims.session, claims.stored ? undefined : claims.maxCostUsd);
      return claims;
    },

    async claim(claims) {
      // The body may have taken a while to arrive; the ticket must still be valid now.
      if (claims.exp <= now()) throw new HttpError(401, "invalid_ticket", "Ticket expired");
      const claimed = await ctx.ledger.claim({ id: claims.id, model: claims.model, maxSeconds: claims.maxSeconds, maxCostUsd: claims.maxCostUsd, owner: ctx.instanceId, now: now() });
      if (!claimed) throw new HttpError(409, "ticket_used", "This ticket was already used");
      if (claims.stored && !claimed.session) {
        await settleUnconnected(claims.id);
        throw new HttpError(410, "session_expired", "The session stored for this ticket has expired; mint a new ticket");
      }
      if (claims.stored) {
        // A ticket signed elsewhere can claim a stored session with a smaller cap than it was minted with: check them together.
        try {
          assertSession(claims.model, claimed.session, claims.maxCostUsd);
        } catch (error) {
          await settleUnconnected(claims.id);
          throw error;
        }
      }
      return claimed.session ?? claims.session;
    },

    enter() {
      admitting += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        admitting -= 1;
      };
    },

    get admitting() {
      return admitting;
    },

    close() {
      closing = true;
    },

    get closing() {
      return closing;
    },
  };
}
