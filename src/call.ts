// One supervised call: deadline timer, heartbeat, usage metering, policy
// checks, and a single finish path that stops spending first, hangs up, and
// settles last. A WebRTC call is never settled until OpenAI confirms the hang-up.
//
// Spend control ("observed + reserved spend"): every response OpenAI starts
// reserves its true worst case (see budget.ts) until it reports its usage. The
// call ends as soon as observed spend, the running responses' reservations (at
// least one response's worth) and one more worst-case response would pass the
// cap. The guard learns of a response only once it has started, so that last
// slot is for the response it can't see yet. One response runs at a time;
// extras are cancelled as they start.

import { DEFAULT_INSTRUCTIONS_BYTES, canonicalTools, responseLimits, worstResponseUsd } from "./budget.js";
import type { GuardConfig } from "./config.js";
import { describeError } from "./http.js";
import type { EndReason, Ledger, SessionConfig, Transport } from "./ledger.js";
import type { Logger } from "./log.js";
import type { OpenAIRealtime, SocketLike } from "./openai.js";
import { estimateResponseCost, estimateTranscriptionCost, reportsUsage, type CostEstimate } from "./pricing.js";
import type { TicketClaims } from "./ticket.js";
import { SESSION_LIMIT_MS, sleep, withTimeout } from "./util.js";
import type { Notifier } from "./webhook.js";

/** Shared state for every call on one guard instance. */
export interface GuardContext {
  config: GuardConfig;
  ledger: Ledger;
  openai: OpenAIRealtime;
  log: Logger;
  notify: Notifier;
  instanceId: string;
  now: () => number;
  /** Calls owned by this instance, from creation until they are settled. */
  active: Map<string, Call>;
  /** Wait between hang-up retries when OpenAI does not confirm one. */
  hangupRetryMs: number;
  /**
   * How long a response may run without reporting before the call ends as
   * `monitor_lost`. Undefined: 60 seconds plus 100 ms per token of the output cap.
   */
  responseTimeoutMs: number | undefined;
}

type ProviderEvent = Record<string, unknown> & { type?: unknown };
type MessageData = Buffer | ArrayBuffer | Buffer[];

const OPEN = 1;
/** A WebSocket closed without a close frame: the connection dropped. */
const ABNORMAL_CLOSE = 1006;
const PROVIDER_CLOSE_WAIT_MS = 2000;
const DRAIN_WAIT_MS = 5000;
const SETTLE_TIMEOUT_MS = 10_000;
/** Consecutive failed heartbeats that end a call; one miss is tolerated (a short Redis failover). */
const HEARTBEAT_MISSES = 2;
/** OpenAI's highest output cap. A response that claims "inf", or in WebRTC mode shows no cap, is reserved at this. */
const OPENAI_MAX_OUTPUT_TOKENS = 4096;
const RESPONSE_TIMEOUT_BASE_MS = 60_000;
/** Twice real time: a token of output audio is 50 ms of speech. */
const RESPONSE_TIMEOUT_PER_TOKEN_MS = 100;
/** These reasons mean some usage may not have been observed. */
const LOSSY: ReadonlySet<EndReason> = new Set(["monitor_lost", "heartbeat_lost", "provider_error", "unpriced_usage", "watchdog_deadline", "watchdog_stale"]);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isWholeNumber = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1;

export function dataToString(data: MessageData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data).toString("utf8");
}

export function parseEvent(data: MessageData): ProviderEvent | undefined {
  try {
    const event: unknown = JSON.parse(dataToString(data));
    return isObject(event) ? event : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The session sent to OpenAI: the caller's config with the model forced, the
 * output cap clamped, and a truncation limit that bounds how much conversation
 * each response re-reads (and so what its input can cost).
 */
export function buildSession(base: SessionConfig | undefined, model: string, maxOutputTokens: number, maxInputTokens: number): SessionConfig {
  const requested = base?.max_output_tokens;
  const outputCap = isWholeNumber(requested) ? Math.min(requested, maxOutputTokens) : maxOutputTokens;
  const asked = isObject(base?.truncation) ? base.truncation : {};
  const ratio = typeof asked.retention_ratio === "number" && asked.retention_ratio > 0 && asked.retention_ratio <= 1 ? asked.retention_ratio : 0.8;
  const askedLimit = isObject(asked.token_limits) ? asked.token_limits.post_instructions : undefined;
  const inputCap = isWholeNumber(askedLimit) ? Math.min(askedLimit, maxInputTokens) : maxInputTokens;
  return {
    ...base,
    type: "realtime",
    model,
    max_output_tokens: outputCap,
    truncation: { type: "retention_ratio", retention_ratio: ratio, token_limits: { post_instructions: inputCap } },
  };
}

export function transcriptionModel(session: unknown): string | undefined {
  if (!isObject(session) || !isObject(session.audio) || !isObject(session.audio.input)) return undefined;
  const transcription = session.audio.input.transcription;
  return isObject(transcription) && typeof transcription.model === "string" ? transcription.model : undefined;
}

/** True when an output cap reported by OpenAI is a number no higher than `cap`. */
const withinCap = (value: unknown, cap: number) => value === undefined || (typeof value === "number" && value <= cap);

/** True when a reported truncation setting still bounds input at `cap` tokens or fewer. */
function truncationWithin(value: unknown, cap: number): boolean {
  if (value === undefined) return true;
  if (!isObject(value) || !isObject(value.token_limits)) return false;
  const limit = value.token_limits.post_instructions;
  return typeof limit === "number" && limit <= cap;
}

export class Call {
  readonly id: string;
  readonly outputCap: number;
  readonly inputCap: number;
  /** The most one response can cost on this call. Every running response reserves this much. */
  readonly worstResponseUsd: number;
  providerCallId: string | undefined;
  private provider: SocketLike | undefined;
  private client: SocketLike | undefined;
  private providerClosed: Promise<void> = Promise.resolve();
  private finishing: Promise<void> | undefined;
  private complete = true;
  private pending: Promise<void> = Promise.resolve();
  private boundAt: number | undefined;
  private deadlineAt: number | undefined;
  private deadline: NodeJS.Timeout | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private heartbeatMisses = 0;
  private responses = 0;
  private asrModel: string | undefined;
  private readonly responseTimeoutMs: number;
  /** The session's instructions. Once known, any change ends the call. */
  private instructions: string | undefined;
  /** The session's tool definitions, canonical. Any change ends the call. */
  private readonly tools: string;
  /** Responses OpenAI has started and not reported, with the cost reserved for each and the timer that gives up on it. */
  private readonly inFlight = new Map<string, { usd: number; timer: NodeJS.Timeout }>();
  private readonly metered = new Set<string>();
  private readonly cancelled = new Set<string>();
  private spentUsd = 0;

  constructor(
    private readonly ctx: GuardContext,
    readonly claims: TicketClaims,
    readonly session: SessionConfig,
    readonly transport: Transport,
  ) {
    this.id = claims.id;
    const limits = responseLimits(session);
    this.outputCap = limits.outputTokens;
    this.inputCap = limits.conversationTokens;
    // Admission refuses unpriced models. If one slipped through, Infinity ends the call at its first event.
    this.worstResponseUsd = worstResponseUsd(ctx.config.prices, claims.model, limits) ?? Number.POSITIVE_INFINITY;
    this.responseTimeoutMs = ctx.responseTimeoutMs ?? RESPONSE_TIMEOUT_BASE_MS + this.outputCap * RESPONSE_TIMEOUT_PER_TOKEN_MS;
    this.instructions = typeof session.instructions === "string" ? session.instructions : undefined;
    this.tools = canonicalTools(session.tools);
    this.asrModel = transcriptionModel(session);
    ctx.active.set(this.id, this);
  }

  /** True once the call has started to finish. */
  get ended(): boolean {
    return this.finishing !== undefined;
  }

  /** True while a response is running. The relay refuses new response.create events meanwhile. */
  get responding(): boolean {
    return this.inFlight.size > 0;
  }

  /**
   * Watches the provider socket (sideband or upstream) and, in relay mode, the
   * client socket. `onEvent` runs after metering, for relay forwarding.
   */
  attach(provider: SocketLike, client?: SocketLike, onEvent?: (event: ProviderEvent, data: MessageData) => void): void {
    this.provider = provider;
    this.client = client;
    this.providerClosed = new Promise((resolve) => provider.on("close", () => resolve()));
    provider.on("message", (data) => {
      const event = parseEvent(data);
      if (!event) {
        void this.finish("monitor_lost");
        return;
      }
      this.onProviderEvent(event);
      onEvent?.(event, data);
    });
    provider.on("error", () => void this.finish("monitor_lost"));
    provider.on("close", (code?: number) => void this.finish(this.deadline && code !== ABNORMAL_CLOSE ? "ended" : "monitor_lost"));
  }

  /** Records the provider call and its deadline. Call start() once media can flow. */
  async bind(providerCallId: string): Promise<void> {
    this.providerCallId = providerCallId;
    this.boundAt = this.ctx.now();
    this.deadlineAt = this.boundAt + this.claims.maxSeconds * 1000;
    await this.ctx.ledger.bind(this.id, { transport: this.transport, providerCallId, now: this.boundAt, deadlineAt: this.deadlineAt });
  }

  /** Starts the deadline timer (measured from bind) and the heartbeat. */
  start(): void {
    if (this.ended || this.deadline) return;
    const remaining = Math.max(0, (this.deadlineAt ?? this.ctx.now()) - this.ctx.now());
    this.deadline = setTimeout(() => void this.finish("max_duration"), remaining);
    this.heartbeat = setInterval(() => {
      this.ctx.ledger.heartbeat(this.id, this.ctx.now()).then(
        ({ active }) => {
          this.heartbeatMisses = 0;
          if (!active) void this.finish("stopped");
        },
        () => {
          this.ctx.log.warn("call.heartbeat_missed", { call: this.id, misses: this.heartbeatMisses + 1 });
          if (++this.heartbeatMisses >= HEARTBEAT_MISSES) void this.finish("heartbeat_lost");
        },
      );
    }, this.ctx.config.heartbeatSeconds * 1000);
  }

  private policy(event: string): void {
    this.ctx.log.warn("call.policy", { call: this.id, event });
    void this.finish("policy");
  }

  private send(event: Record<string, unknown>): void {
    if (this.provider?.readyState === OPEN) this.provider.send(JSON.stringify(event));
  }

  private cancel(responseId: string): void {
    if (this.cancelled.has(responseId)) return;
    this.cancelled.add(responseId);
    this.ctx.log.warn("call.response_cancelled", { call: this.id, response: responseId });
    this.send({ type: "response.cancel", response_id: responseId });
  }

  /**
   * Ends the call once observed spend, the running responses' reservations and
   * one more worst-case response would pass the cap. True if it did. With
   * nothing running it still counts one response, so an idle call ends right
   * after its last affordable response instead of starting one it must cancel.
   */
  private checkBudget(): boolean {
    if (this.ended) return false;
    let reserved = 0;
    for (const { usd } of this.inFlight.values()) reserved += usd;
    // Written as !(... <= cap) so a NaN anywhere ends the call.
    if (this.spentUsd + Math.max(reserved, this.worstResponseUsd) + this.worstResponseUsd <= this.claims.maxCostUsd) return false;
    void this.finish("max_cost");
    return true;
  }

  /** Holds `usd` for a response until it reports, and gives up on the call if it never does. */
  private reserve(id: string, usd: number): void {
    if (this.inFlight.has(id) || this.metered.has(id)) return;
    const timer = setTimeout(() => {
      this.ctx.log.warn("call.response_lost", { call: this.id, response: id, afterMs: this.responseTimeoutMs });
      void this.finish("monitor_lost");
    }, this.responseTimeoutMs);
    timer.unref();
    this.inFlight.set(id, { usd, timer });
  }

  /** Ends a reservation and returns it: the worst case if the response was never seen starting. */
  private release(id: string): number {
    const entry = this.inFlight.get(id);
    if (!entry) return this.worstResponseUsd;
    clearTimeout(entry.timer);
    this.inFlight.delete(id);
    return entry.usd;
  }

  /**
   * True when `instructions` (if a string) differ from the session's. A session
   * created without instructions runs on OpenAI's defaults: the first ones seen
   * are accepted if they fit the room reserved for them, then held to.
   */
  private instructionsChanged(instructions: unknown): boolean {
    if (typeof instructions !== "string") return false;
    if (this.instructions === undefined && Buffer.byteLength(instructions) <= DEFAULT_INSTRUCTIONS_BYTES) this.instructions = instructions;
    return instructions !== this.instructions;
  }

  /** What a `session.updated` changed that the guard can't allow, or undefined. */
  private sessionBreach(session: Record<string, unknown>): string | undefined {
    if (typeof session.model === "string" && session.model !== this.claims.model) return "model";
    if (!withinCap(session.max_output_tokens, this.outputCap)) return "max_output_tokens";
    if (!truncationWithin(session.truncation, this.inputCap)) return "truncation";
    if (isObject(session.prompt)) return "prompt";
    if (session.tools !== undefined && canonicalTools(session.tools) !== this.tools) return "tools";
    if (this.instructionsChanged(session.instructions)) return "instructions";
    return undefined;
  }

  /**
   * What a `response.created` shows the guard can't allow, or undefined. In
   * WebRTC mode the browser can send response.create itself, with its own
   * output cap, instructions or stored prompt; those show up here if OpenAI reports them.
   */
  private responseBreach(response: Record<string, unknown>): string | undefined {
    if (!withinCap(response.max_output_tokens, this.outputCap)) return "max_output_tokens";
    if (isObject(response.prompt)) return "prompt";
    if (this.instructionsChanged(response.instructions)) return "instructions";
    return undefined;
  }

  /**
   * The most a started response can cost. A response that breaks policy is
   * counted with its own output cap and instructions. In WebRTC mode, a response
   * whose cap the event doesn't show is counted at OpenAI's highest cap, since the
   * browser may have set one; relayed responses always carry the guard's cap.
   */
  private reservationFor(response: Record<string, unknown>, breach: string | undefined): number {
    const cap = response.max_output_tokens;
    const unseen = cap === undefined && this.transport === "webrtc";
    if (!breach && !unseen) return this.worstResponseUsd;
    const outputTokens = typeof cap === "number" && cap > this.outputCap ? cap : breach === "max_output_tokens" || unseen ? OPENAI_MAX_OUTPUT_TOKENS : this.outputCap;
    const session = typeof response.instructions === "string" ? { ...this.session, instructions: response.instructions } : this.session;
    return worstResponseUsd(this.ctx.config.prices, this.claims.model, { ...responseLimits(session), outputTokens }) ?? Number.POSITIVE_INFINITY;
  }

  private onProviderEvent(event: ProviderEvent): void {
    if (event.type === "session.updated" && isObject(event.session)) {
      // In WebRTC mode the browser can send session.update itself; these are the changes that would break the bound.
      const breach = this.sessionBreach(event.session);
      if (breach) {
        this.policy(`session.updated:${breach}`);
        return;
      }
      this.asrModel = transcriptionModel(event.session) ?? this.asrModel;
      return;
    }
    if (event.type === "response.created") {
      const response = isObject(event.response) ? event.response : {};
      if (typeof response.id !== "string") {
        // Without an id the response can be neither cancelled nor matched to its usage.
        this.ctx.log.warn("call.response_without_id", { call: this.id });
        void this.finish("monitor_lost");
        return;
      }
      const breach = this.responseBreach(response);
      this.reserve(response.id, this.reservationFor(response, breach));
      if (breach || this.inFlight.size > 1 || this.ended) this.cancel(response.id);
      if (breach) this.policy(`response.created:${breach}`);
      else this.checkBudget();
      return;
    }
    if (event.type === "response.done") {
      const response = isObject(event.response) ? event.response : {};
      const id = typeof response.id === "string" ? response.id : `event:${String(event.event_id)}`;
      const reserved = this.release(id);
      if (reportsUsage(response.usage)) {
        this.meter(id, estimateResponseCost(this.ctx.config.prices, this.claims.model, response.usage), true);
      } else {
        // No usage: charge what was reserved, the response's worst case.
        if (!this.metered.has(id)) this.ctx.log.warn("call.usage_missing", { call: this.id, response: id });
        this.meter(id, { usd: reserved, complete: false }, true);
      }
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.completed") {
      const id = `transcription:${String(event.item_id)}:${String(event.content_index ?? 0)}`;
      this.meter(id, estimateTranscriptionCost(this.ctx.config.prices, this.asrModel ?? "", event.usage), false);
    }
  }

  /** Counts usage synchronously, so caps never wait on the ledger; the ledger write follows. */
  private meter(responseId: string, estimate: CostEstimate | undefined, isResponse: boolean): void {
    if (this.metered.has(responseId)) return;
    this.metered.add(responseId);
    if (!estimate) {
      this.complete = false;
      this.ctx.log.warn("call.unpriced_usage", { call: this.id, usage: isResponse ? "response" : "transcription" });
      void this.finish("unpriced_usage");
      return;
    }
    if (!estimate.complete) this.complete = false;
    if (isResponse) this.responses += 1;
    this.record(responseId, estimate.usd, estimate.complete);
    if (!this.checkBudget() && this.responses >= this.ctx.config.maxResponsesPerCall) void this.finish("max_responses");
  }

  private record(responseId: string, usd: number, complete: boolean): void {
    this.spentUsd += usd;
    this.pending = this.pending
      .then(() => this.ctx.ledger.observe(this.id, { responseId, costUsd: usd, complete }))
      .then(() => undefined)
      .catch((error: unknown) => {
        this.complete = false;
        this.ctx.log.error("ledger.observe_failed", { call: this.id, error: describeError(error) });
        void this.finish("monitor_lost");
      });
  }

  /** Charges every response that never reported its full reservation, and marks the call incomplete. */
  private chargeUnreported(): void {
    for (const [id, { usd, timer }] of this.inFlight) {
      clearTimeout(timer);
      this.ctx.log.warn("call.response_unreported", { call: this.id, response: id });
      this.complete = false;
      this.metered.add(id);
      this.record(id, usd, false);
    }
    this.inFlight.clear();
  }

  /** Idempotent: the first reason wins. Stops spending, hangs up, closes sockets, waits for metering, then settles. */
  finish(reason: EndReason): Promise<void> {
    // Deferred one microtask so a socket that closes synchronously inside run()
    // re-enters here after `finishing` is set.
    this.finishing ??= Promise.resolve().then(() => this.run(reason));
    return this.finishing;
  }

  /** Stops everything that spends: automatic turns, transcription, and every running response. New ones are cancelled as they start. */
  private quiesce(): void {
    this.send({ type: "session.update", session: { type: "realtime", audio: { input: { turn_detection: null, transcription: null } } } });
    for (const id of this.inFlight.keys()) this.cancel(id);
  }

  /**
   * Retries the hang-up until OpenAI confirms it. On shutdown it gives up after
   * one round, leaving the call unsettled for another instance's watchdog.
   * Otherwise it retries until OpenAI's session limit has certainly passed.
   */
  private async hangUp(callId: string, persistent: boolean): Promise<boolean> {
    const giveUpAt = (this.boundAt ?? this.ctx.now()) + SESSION_LIMIT_MS;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.ctx.openai.hangup(callId);
        return true;
      } catch (error) {
        this.ctx.log.error("call.hangup_unconfirmed", { call: this.id, providerCall: callId, attempt, error: describeError(error) });
      }
      // Written as !(now < giveUpAt) so a NaN clock ends the loop instead of spinning.
      if (!persistent || !(this.ctx.now() < giveUpAt)) return false;
      await sleep(this.ctx.hangupRetryMs);
    }
  }

  private async run(reason: EndReason): Promise<void> {
    clearTimeout(this.deadline);
    clearInterval(this.heartbeat);
    // Stop the spending before anything that can wait, such as a hang-up OpenAI is slow to confirm.
    this.quiesce();
    try {
      let confirmed = true;
      if (this.transport === "webrtc" && this.providerCallId) {
        // The sideband stays open while we retry, so metering continues.
        confirmed = await this.hangUp(this.providerCallId, reason !== "shutdown");
        if (!confirmed && reason === "shutdown") {
          this.ctx.log.error("call.left_running", { call: this.id, providerCall: this.providerCallId });
          return;
        }
      }
      for (const socket of [this.provider, this.client]) {
        if (socket && socket.readyState <= OPEN) socket.close(1000, "call ended");
      }
      // Let trailing provider events (the final response.done) arrive, then meter them.
      await Promise.race([this.providerClosed, sleep(PROVIDER_CLOSE_WAIT_MS)]);
      this.provider?.terminate();
      // Give the client a moment to receive our close frame.
      setTimeout(() => this.client?.terminate(), 1000).unref();
      this.chargeUnreported();
      const drained = await Promise.race([this.pending.then(() => true), sleep(DRAIN_WAIT_MS).then(() => false)]);
      const complete = this.complete && drained && confirmed && !LOSSY.has(reason);
      const result = await withTimeout(this.ctx.ledger.settle(this.id, { reason, monitoringComplete: complete, now: this.ctx.now() }), SETTLE_TIMEOUT_MS, "Ledger settle");
      if (!result?.first) return;
      const { record } = result;
      this.ctx.log.info("call.settled", {
        call: record.id,
        reason: record.endReason,
        seconds: record.durationSeconds,
        costUsd: Number(record.costUsd.toFixed(6)),
        complete: record.monitoringComplete,
      });
      await this.ctx.notify(record);
    } catch (error) {
      this.ctx.log.error("ledger.settle_failed", { call: this.id, reason, error: describeError(error) });
    } finally {
      for (const { timer } of this.inFlight.values()) clearTimeout(timer);
      this.ctx.active.delete(this.id);
    }
  }
}
