// The ledger records each call's claim, provider binding, observed spend and
// settlement. The in-memory ledger suits a single instance; RedisLedger keeps
// the same records across restarts and instances.

/** Why a call ended, as recorded in its settled record. */
export type EndReason =
  | "ended" // the caller or OpenAI ended the call
  | "max_duration"
  | "max_cost"
  | "max_responses"
  | "stopped" // POST /v1/admin/calls/:id/stop
  | "policy" // the client tried to change the model or raise the output cap
  | "unpriced_usage" // usage arrived for a model with no price entry
  | "monitor_lost"
  | "heartbeat_lost"
  | "provider_error"
  | "shutdown"
  | "watchdog_deadline" // the owning instance missed its own deadline
  | "watchdog_stale" // the owning instance stopped sending heartbeats
  | "not_connected" // the ticket was claimed but no call was created
  | "slow_client"; // the relay client stopped reading and its buffer filled

/** How the client reached OpenAI through the guard. */
export type Transport = "webrtc" | "websocket";

/** One call's ledger entry, from claim to settlement. Times are milliseconds since the epoch. */
export interface CallRecord {
  id: string;
  model: string;
  maxSeconds: number;
  maxCostUsd: number;
  /** Instance that owns the live connection. */
  owner: string;
  claimedAt: number;
  transport?: Transport;
  /** OpenAI's call id (WebRTC) or `ws:<id>` (WebSocket relay). */
  providerCallId?: string;
  boundAt?: number;
  deadlineAt?: number;
  lastSeenAt?: number;
  /** Estimated spend so far, in US dollars. */
  costUsd: number;
  /** Responses and transcriptions metered. */
  usageEvents: number;
  /** False once any usage was missing or priced conservatively. */
  usageComplete: boolean;
  stopRequested: boolean;
  settledAt?: number;
  endReason?: EndReason;
  durationSeconds?: number;
  /** True when every response was observed and priced exactly. */
  monitoringComplete?: boolean;
}

/** An OpenAI Realtime session object, passed through as given apart from the fields the guard forces. */
export type SessionConfig = Record<string, unknown>;

export interface ClaimInput {
  id: string;
  model: string;
  maxSeconds: number;
  maxCostUsd: number;
  owner: string;
  now: number;
}

export interface BindInput {
  transport: Transport;
  providerCallId: string;
  now: number;
  deadlineAt: number;
}

export interface ObserveInput {
  responseId: string;
  costUsd: number;
  complete: boolean;
}

export interface SettleInput {
  reason: EndReason;
  monitoringComplete: boolean;
  now: number;
}

/** What the watchdog asks for. Times are milliseconds; a shared ledger may use its own clock for `now`. */
export interface OverdueInput {
  now: number;
  /** A call is overdue this long after its deadline. */
  deadlineGraceMs: number;
  /** A call is stale this long after its last heartbeat. */
  staleAfterMs: number;
}

export interface OverdueCall {
  record: CallRecord;
  why: "deadline" | "stale";
}

/** Storage for call records. Implementations must pass test/ledger.test.ts. */
export interface Ledger {
  /** Short name shown by /health, such as "memory" or "redis". */
  readonly kind: string;
  /** Stores a session config for a ticket. False if the id was already used. */
  putSessionConfig(id: string, session: SessionConfig, ttlMs: number): Promise<boolean>;
  /** Claims a ticket id once. Undefined if it was already claimed. */
  claim(input: ClaimInput): Promise<{ record: CallRecord; session?: SessionConfig } | undefined>;
  bind(id: string, input: BindInput): Promise<void>;
  /** Adds a response's cost once per responseId and returns the running totals. A no-op (duplicate) once the call is settled. */
  observe(id: string, input: ObserveInput): Promise<{ duplicate: boolean; costUsd: number; usageEvents: number }>;
  /** Refreshes liveness. Inactive once a stop was requested or the call settled. */
  heartbeat(id: string, now: number): Promise<{ active: boolean }>;
  requestStop(id: string): Promise<CallRecord | undefined>;
  /** Settles once. Later calls return the first settlement with first=false. */
  settle(id: string, input: SettleInput): Promise<{ record: CallRecord; first: boolean } | undefined>;
  get(id: string): Promise<CallRecord | undefined>;
  /** Bound, unsettled calls past their deadline or without a recent heartbeat. */
  overdue(input: OverdueInput): Promise<OverdueCall[]>;
  /** Resolves if the ledger can serve requests; rejects otherwise. Used by GET /ready. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

/** Settled records and unclaimed session configs are kept this long. */
export const RECORD_TTL_MS = 24 * 60 * 60 * 1000;

/** A remote stop makes the call end on its own; report that as "stopped". */
export function finalReason(record: CallRecord, reason: EndReason): EndReason {
  return record.stopRequested && (reason === "ended" || reason === "monitor_lost" || reason === "heartbeat_lost") ? "stopped" : reason;
}

export function durationSeconds(record: CallRecord, now: number): number {
  return record.boundAt === undefined ? 0 : Math.max(0, Math.round((now - record.boundAt) / 100) / 10);
}

/** {@link Ledger} in process memory. Right for one instance; records are lost on restart. */
export class MemoryLedger implements Ledger {
  readonly kind = "memory";
  private readonly configs = new Map<string, { session: SessionConfig; expiresAt: number }>();
  private readonly records = new Map<string, CallRecord>();
  private readonly seen = new Map<string, Set<string>>();

  constructor(private readonly clock: () => number = Date.now) {}

  async putSessionConfig(id: string, session: SessionConfig, ttlMs: number): Promise<boolean> {
    const now = this.clock();
    const existing = this.configs.get(id);
    if (this.records.has(id) || (existing && existing.expiresAt > now)) return false;
    this.configs.set(id, { session: structuredClone(session), expiresAt: now + ttlMs });
    return true;
  }

  async claim(input: ClaimInput) {
    if (this.records.has(input.id)) return undefined;
    const record: CallRecord = {
      id: input.id,
      model: input.model,
      maxSeconds: input.maxSeconds,
      maxCostUsd: input.maxCostUsd,
      owner: input.owner,
      claimedAt: input.now,
      costUsd: 0,
      usageEvents: 0,
      usageComplete: true,
      stopRequested: false,
    };
    this.records.set(input.id, record);
    this.seen.set(input.id, new Set());
    const config = this.configs.get(input.id);
    this.configs.delete(input.id);
    const session = config && config.expiresAt > input.now ? config.session : undefined;
    return session ? { record: { ...record }, session } : { record: { ...record } };
  }

  async bind(id: string, input: BindInput): Promise<void> {
    const record = this.mustGet(id);
    if (record.settledAt !== undefined) throw new Error("Call already settled");
    if (record.providerCallId && record.providerCallId !== input.providerCallId) throw new Error("Call already bound");
    Object.assign(record, {
      transport: input.transport,
      providerCallId: input.providerCallId,
      boundAt: input.now,
      lastSeenAt: input.now,
      deadlineAt: input.deadlineAt,
    });
  }

  async observe(id: string, input: ObserveInput) {
    const record = this.mustGet(id);
    if (record.settledAt !== undefined) return { duplicate: true, costUsd: record.costUsd, usageEvents: record.usageEvents };
    const seen = this.seen.get(id) ?? new Set<string>();
    this.seen.set(id, seen);
    if (seen.has(input.responseId)) return { duplicate: true, costUsd: record.costUsd, usageEvents: record.usageEvents };
    seen.add(input.responseId);
    record.costUsd += input.costUsd;
    record.usageEvents += 1;
    record.usageComplete &&= input.complete;
    return { duplicate: false, costUsd: record.costUsd, usageEvents: record.usageEvents };
  }

  async heartbeat(id: string, now: number) {
    const record = this.records.get(id);
    if (!record || record.settledAt !== undefined || record.stopRequested) return { active: false };
    record.lastSeenAt = now;
    return { active: true };
  }

  async requestStop(id: string) {
    const record = this.records.get(id);
    if (!record) return undefined;
    record.stopRequested = true;
    return { ...record };
  }

  async settle(id: string, input: SettleInput) {
    const record = this.records.get(id);
    if (!record) return undefined;
    if (record.settledAt !== undefined) return { record: { ...record }, first: false };
    Object.assign(record, {
      settledAt: input.now,
      endReason: finalReason(record, input.reason),
      durationSeconds: durationSeconds(record, input.now),
      monitoringComplete: input.monitoringComplete && record.usageComplete,
    });
    this.seen.delete(id);
    return { record: { ...record }, first: true };
  }

  async get(id: string) {
    const record = this.records.get(id);
    return record ? { ...record } : undefined;
  }

  async overdue({ now: at, deadlineGraceMs, staleAfterMs }: OverdueInput): Promise<OverdueCall[]> {
    const input = { deadlineBefore: at - deadlineGraceMs, seenBefore: at - staleAfterMs };
    const now = this.clock();
    for (const [id, config] of this.configs) if (config.expiresAt <= now) this.configs.delete(id);
    const out: OverdueCall[] = [];
    for (const [id, record] of this.records) {
      if (record.settledAt !== undefined) {
        if (record.settledAt + RECORD_TTL_MS <= now) this.records.delete(id);
        continue;
      }
      if (record.boundAt === undefined) {
        // A claim that never became a call is kept as long as a settled record.
        if (record.claimedAt + RECORD_TTL_MS <= now) this.records.delete(id);
        continue;
      }
      if (record.deadlineAt !== undefined && record.deadlineAt <= input.deadlineBefore) out.push({ record: { ...record }, why: "deadline" });
      else if ((record.lastSeenAt ?? record.boundAt) <= input.seenBefore) out.push({ record: { ...record }, why: "stale" });
    }
    return out;
  }

  async ping(): Promise<void> {}

  async close(): Promise<void> {}

  private mustGet(id: string): CallRecord {
    const record = this.records.get(id);
    if (!record) throw new Error("Unknown call");
    return record;
  }
}
