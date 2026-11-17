// HTTP and WebSocket surface:
//   GET  /health                      liveness
//   GET  /ready                       readiness: ledger reachable and not shutting down
//   POST /v1/tickets                  (API key) store a session, get a signed ticket
//   POST /v1/realtime/calls           (ticket)  SDP offer in, SDP answer out
//   WS   /v1/realtime                 (ticket)  relay for native and server clients
//   GET  /v1/admin/calls/:id          (API key) the call's ledger record
//   POST /v1/admin/calls/:id/stop     (API key) hang up now

import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createAdmission } from "./admission.js";
import type { GuardContext } from "./call.js";
import { assertConfig, type GuardConfig } from "./config.js";
import { HttpError, describeError, isObject, readBody, sendJson } from "./http.js";
import { MemoryLedger, type Ledger } from "./ledger.js";
import { jsonLogger, type Logger } from "./log.js";
import { ProviderError, createOpenAIRealtime, type SocketFactory } from "./openai.js";
import { connectRedisLedger } from "./redis-ledger.js";
import { openWebRTCCall } from "./relay.js";
import { CALL_ID_PATTERN, SAFETY_ID_PATTERN, signTicket, type TicketClaims } from "./ticket.js";
import { attachRelay } from "./upgrade.js";
import { assertFinite, sleep, withTimeout } from "./util.js";
import { startWatchdog } from "./watchdog.js";
import { createNotifier } from "./webhook.js";

/** Dependencies you can replace, mainly for tests and custom deployments. */
export interface GuardOptions {
  /** Ledger to use. Defaults to Redis when `config.redisUrl` is set, else in-memory. */
  ledger?: Ledger;
  /** fetch used for OpenAI and the settlement webhook. */
  fetch?: typeof fetch;
  /** Opens WebSockets to OpenAI. */
  socketFactory?: SocketFactory;
  /** Defaults to JSON lines on stdout and stderr. */
  log?: Logger;
  /** Clock, in milliseconds since the epoch. */
  now?: () => number;
  /** How often the watchdog looks for orphaned calls. Default 5000. */
  watchdogIntervalMs?: number;
  /** Base delay between OpenAI hang-up and webhook retries, in milliseconds. */
  retryDelayMs?: number;
  /**
   * How long a response may run without reporting before its call ends as
   * `monitor_lost`, in milliseconds. Default: 60 seconds plus 100 ms per token of the output cap.
   */
  responseTimeoutMs?: number;
}

/** A running guard, as returned by {@link createGuard}. */
export interface Guard {
  /** The Node HTTP server, not yet listening. */
  server: Server;
  /** Shared state: config, ledger, OpenAI client and live calls. */
  context: GuardContext;
  /** The orphaned-call watchdog. `tick()` runs one pass now. */
  watchdog: { stop(): void; tick(): Promise<void> };
  /** Starts listening. Resolves with the bound port. */
  listen(port?: number, host?: string): Promise<number>;
  /** Stops admitting calls, hangs up live ones within SHUTDOWN_GRACE_SECONDS, and closes the server and ledger. */
  close(): Promise<void>;
}

const MAX_SDP_BYTES = 65_536;
const MAX_TICKET_REQUEST_BYTES = 65_536;
const READY_TIMEOUT_MS = 2000;

/**
 * Builds the guard: HTTP routes, the WebSocket relay, the ledger and the watchdog.
 * Call `listen()` on the result to start serving. Connects to Redis first when
 * `config.redisUrl` is set, and rejects with a ConfigError if it cannot.
 */
export async function createGuard(config: GuardConfig, options: GuardOptions = {}): Promise<Guard> {
  assertConfig(config);
  const retryDelayMs = assertFinite("retryDelayMs", options.retryDelayMs ?? 500);
  const watchdogIntervalMs = assertFinite("watchdogIntervalMs", options.watchdogIntervalMs ?? 5000, 1);
  const responseTimeoutMs = options.responseTimeoutMs === undefined ? undefined : assertFinite("responseTimeoutMs", options.responseTimeoutMs, 1);
  const log = options.log ?? jsonLogger;
  const now = options.now ?? Date.now;
  const ctx: GuardContext = {
    config,
    ledger: options.ledger ?? (config.redisUrl ? await connectRedisLedger(config.redisUrl.reveal(), config.redisPrefix, log) : new MemoryLedger()),
    openai: createOpenAIRealtime({
      apiKey: config.openaiApiKey.reveal(),
      baseUrl: config.openaiBaseUrl,
      fetch: options.fetch,
      socketFactory: options.socketFactory,
      retryDelayMs,
    }),
    log,
    notify: createNotifier({
      url: config.settleWebhookUrl,
      secret: config.settleWebhookSecret?.reveal(),
      log,
      fetch: options.fetch,
      retryDelayMs: retryDelayMs * 2,
    }),
    instanceId: randomUUID(),
    now,
    active: new Map(),
    hangupRetryMs: retryDelayMs * 10,
    responseTimeoutMs,
  };
  const admission = createAdmission(ctx, now());

  async function handleTicket(req: IncomingMessage, res: ServerResponse) {
    admission.requireApiKey(req);
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req, MAX_TICKET_REQUEST_BYTES));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "invalid_json", "Body must be JSON");
    }
    if (!isObject(body) || !isObject(body.session) || typeof body.session.model !== "string") {
      throw new HttpError(400, "invalid_request", "Body needs session.model");
    }
    const session = body.session;
    const model = session.model as string;
    const maxSeconds = body.max_seconds ?? config.maxCallSeconds;
    if (typeof maxSeconds !== "number" || !Number.isInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > config.maxCallSeconds) {
      throw new HttpError(400, "invalid_max_seconds", `max_seconds must be an integer from 1 to ${config.maxCallSeconds}`);
    }
    const maxCostUsd = body.max_cost_usd ?? config.maxCallCostUsd;
    if (typeof maxCostUsd !== "number" || !Number.isFinite(maxCostUsd) || maxCostUsd <= 0 || maxCostUsd > config.maxCallCostUsd) {
      throw new HttpError(400, "invalid_max_cost_usd", `max_cost_usd must be above 0 and at most ${config.maxCallCostUsd}`);
    }
    admission.assertSession(model, session, maxCostUsd);
    const id = body.call_id ?? `call_${randomBytes(12).toString("base64url")}`;
    if (typeof id !== "string" || !CALL_ID_PATTERN.test(id)) throw new HttpError(400, "invalid_call_id", "call_id must be 8 to 64 of A-Z a-z 0-9 _ -");
    const sid = body.safety_identifier;
    if (sid !== undefined && (typeof sid !== "string" || !SAFETY_ID_PATTERN.test(sid))) {
      throw new HttpError(400, "invalid_safety_identifier", "safety_identifier must be 1 to 64 printable ASCII characters with no spaces");
    }

    const ttlMs = config.ticketTtlSeconds * 1000;
    // The stored session outlives the ticket by a minute, so a ticket used just before expiry still finds it.
    if (!(await ctx.ledger.putSessionConfig(id, session, ttlMs + 60_000))) throw new HttpError(409, "call_id_used", "This call_id was already used");
    const issuedAt = now();
    const claims: TicketClaims = { id, iat: issuedAt, exp: issuedAt + ttlMs, model, maxSeconds, maxCostUsd, stored: true };
    if (sid) claims.sid = sid;
    sendJson(res, 201, {
      value: signTicket(claims, config.signingSecret.reveal()),
      expires_at: Math.floor(claims.exp / 1000),
      call_id: id,
      model,
      max_seconds: maxSeconds,
      max_cost_usd: maxCostUsd,
    });
  }

  async function handleOffer(req: IncomingMessage, res: ServerResponse, cors: Record<string, string>) {
    const release = admission.enter();
    try {
      const claims = admission.precheck(req);
      const sdp = await readBody(req, MAX_SDP_BYTES);
      if (!sdp.trim()) throw new HttpError(400, "invalid_sdp", "Body must be an SDP offer");
      const session = await admission.claim(claims);
      let answer: string;
      try {
        // openWebRTCCall registers the call in ctx.active synchronously, so the count moves over without a gap.
        release();
        answer = await openWebRTCCall(ctx, claims, session, sdp);
      } catch (error) {
        if (error instanceof ProviderError) {
          log.warn("call.provider_rejected", { call: claims.id, status: error.status });
          throw new HttpError(502, "provider_rejected", "OpenAI did not accept the call");
        }
        throw new HttpError(502, "monitor_unavailable", "Could not attach the call monitor; the call was ended");
      }
      res.writeHead(201, { ...cors, "Content-Type": "application/sdp", "Cache-Control": "no-store", Location: `/v1/realtime/calls/${claims.id}` });
      res.end(answer);
    } finally {
      release();
    }
  }

  async function handleAdmin(req: IncomingMessage, res: ServerResponse, id: string, stop: boolean) {
    admission.requireApiKey(req);
    if (!stop) {
      const record = await ctx.ledger.get(id);
      if (!record) throw new HttpError(404, "not_found", "No such call");
      sendJson(res, 200, { call: record });
      return;
    }
    // The stop is answered at once; the hang-up (and any retries) continue in the background.
    const local = ctx.active.get(id);
    void local?.finish("stopped");
    const record = await ctx.ledger.requestStop(id).catch((error: unknown) => {
      if (!local) throw error;
      log.error("admin.stop_not_recorded", { call: id, error: describeError(error) });
      return undefined;
    });
    if (!local && !record) throw new HttpError(404, "not_found", "No such call");
    if (!local && record && record.settledAt === undefined && record.transport === "webrtc" && record.providerCallId) {
      // Another instance owns the sockets; ending the call at OpenAI stops the spend now.
      void ctx.openai.hangup(record.providerCallId).catch((error: unknown) => log.error("admin.hangup_unconfirmed", { call: id, error: describeError(error) }));
    }
    sendJson(res, 202, { stopping: true, call: record ?? null });
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? "/", "http://guard").pathname;
    if (req.method === "GET" && path === "/health") {
      sendJson(res, 200, { status: "ok", activeCalls: ctx.active.size, ledger: ctx.ledger.kind, pricesChecked: config.prices.checked });
      return;
    }
    if (req.method === "GET" && path === "/ready") {
      if (admission.closing) throw new HttpError(503, "shutting_down", "This instance is shutting down");
      try {
        await withTimeout(ctx.ledger.ping(), READY_TIMEOUT_MS, "Ledger ping");
      } catch (error) {
        log.warn("ready.ledger_unavailable", { error: describeError(error) });
        throw new HttpError(503, "ledger_unavailable", "The ledger is not answering");
      }
      sendJson(res, 200, { status: "ready", ledger: ctx.ledger.kind });
      return;
    }
    if (path === "/v1/realtime/calls" && (req.method === "POST" || req.method === "OPTIONS")) {
      const cors = admission.cors(req);
      if (!cors) throw new HttpError(403, "origin_not_allowed", "Origin not allowed");
      if (req.method === "OPTIONS") {
        res.writeHead(204, { ...cors, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Max-Age": "600" });
        res.end();
        return;
      }
      admission.limit(req);
      await handleOffer(req, res, cors);
      return;
    }
    if (req.method === "POST" && path === "/v1/tickets") {
      await handleTicket(req, res);
      return;
    }
    const admin = /^\/v1\/admin\/calls\/([A-Za-z0-9_-]{8,64})(\/stop)?$/.exec(path);
    if (admin && ((req.method === "GET" && !admin[2]) || (req.method === "POST" && admin[2]))) {
      await handleAdmin(req, res, admin[1] as string, Boolean(admin[2]));
      return;
    }
    throw new HttpError(404, "not_found", "Not found");
  }

  const server = createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      if (res.headersSent) return;
      const known = error instanceof HttpError;
      if (!known) log.error("request.failed", { method: req.method, error: describeError(error) });
      const status = known ? error.status : 500;
      const cors = req.url?.startsWith("/v1/realtime/calls") ? (admission.cors(req) ?? {}) : {};
      sendJson(res, status, { error: { code: known ? error.code : "internal_error", message: known ? error.message : "Internal error" } }, {
        ...cors,
        ...(known ? error.headers : {}),
      });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;

  const relay = attachRelay(server, ctx, admission);
  const watchdog = startWatchdog(ctx, watchdogIntervalMs);

  return {
    server,
    context: ctx,
    watchdog,
    listen: (port = config.port, host = config.host) =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const address = server.address();
          resolve(typeof address === "object" && address ? address.port : port);
        });
      }),
    async close() {
      admission.close();
      watchdog.stop();
      server.close();
      server.closeIdleConnections();
      // Requests already past the closing check may still create calls; finish those too, within the grace period.
      const giveUpAt = Date.now() + config.shutdownGraceSeconds * 1000;
      do {
        const finishing = Promise.allSettled([...ctx.active.values()].map((call) => call.finish("shutdown")));
        await Promise.race([finishing, sleep(Math.max(0, giveUpAt - Date.now()))]);
        if (admission.admitting > 0) await sleep(50);
      } while ((admission.admitting > 0 || ctx.active.size > 0) && Date.now() < giveUpAt);
      if (ctx.active.size > 0) log.error("guard.shutdown_incomplete", { activeCalls: ctx.active.size });
      relay.close();
      server.closeAllConnections();
      await ctx.ledger.close().catch((error: unknown) => log.error("ledger.close_failed", { error: describeError(error) }));
    },
  };
}
