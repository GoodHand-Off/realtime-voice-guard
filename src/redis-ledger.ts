// Durable ledger on Redis. Every step uses a single atomic Redis command
// (SET NX, HSETNX, SADD, HINCRBYFLOAT), so several guard instances can share
// one Redis without Lua scripts.

import { ConfigError } from "./config.js";
import {
  RECORD_TTL_MS,
  durationSeconds,
  finalReason,
  type BindInput,
  type CallRecord,
  type ClaimInput,
  type EndReason,
  type Ledger,
  type ObserveInput,
  type OverdueCall,
  type OverdueInput,
  type SessionConfig,
  type SettleInput,
  type Transport,
} from "./ledger.js";
import type { Logger } from "./log.js";
import { assertFinite, withTimeout } from "./util.js";

/**
 * The handful of Redis commands the ledger needs. Implement it to run the
 * ledger on any Redis client; {@link nodeRedisCommands} adapts node-redis v5.
 */
export interface RedisCommands {
  /** SET key value NX PX ttlMs. True if the key was set. */
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;
  /** GETDEL key. */
  getDel(key: string): Promise<string | null>;
  /** EXISTS key. */
  exists(key: string): Promise<boolean>;
  /** HSET key field value [field value ...]. */
  hSet(key: string, fields: Record<string, string>): Promise<void>;
  /** HSETNX key field value. True if the field was set. */
  hSetIfAbsent(key: string, field: string, value: string): Promise<boolean>;
  /** HGETALL key. */
  hGetAll(key: string): Promise<Record<string, string>>;
  /** HINCRBYFLOAT key field by. Returns the new value. */
  hIncrByFloat(key: string, field: string, by: number): Promise<number>;
  /** HINCRBY key field by. Returns the new value. */
  hIncrBy(key: string, field: string, by: number): Promise<number>;
  /** SADD key member. True if the member was new. */
  sAdd(key: string, member: string): Promise<boolean>;
  /** PEXPIRE key ttlMs. */
  pExpire(key: string, ttlMs: number): Promise<void>;
  /** ZADD key score member. */
  zAdd(key: string, score: number, member: string): Promise<void>;
  /** ZREM key member. */
  zRem(key: string, member: string): Promise<void>;
  /** ZRANGEBYSCORE key -inf max. */
  zRangeByScore(key: string, max: number): Promise<string[]>;
  /** TIME, in milliseconds. Every instance reads the same clock, so their own clocks may drift. */
  time(): Promise<number>;
  /** PING. Rejects if Redis does not answer. */
  ping(): Promise<void>;
  /** Closes the connection. */
  quit(): Promise<void>;
}

/** Structural subset of a node-redis v5 client, so callers can pass their own. */
export interface NodeRedisClient {
  set(key: string, value: string, options: { condition: "NX"; expiration: { type: "PX"; value: number } }): Promise<unknown>;
  getDel(key: string): Promise<unknown>;
  exists(key: string): Promise<unknown>;
  hSet(key: string, fields: Record<string, string>): Promise<unknown>;
  hSetNX(key: string, field: string, value: string): Promise<unknown>;
  hGetAll(key: string): Promise<unknown>;
  hIncrByFloat(key: string, field: string, by: number): Promise<unknown>;
  hIncrBy(key: string, field: string, by: number): Promise<unknown>;
  sAdd(key: string, member: string): Promise<unknown>;
  pExpire(key: string, ttlMs: number): Promise<unknown>;
  zAdd(key: string, member: { score: number; value: string }): Promise<unknown>;
  zRem(key: string, member: string): Promise<unknown>;
  zRangeByScore(key: string, min: string, max: number): Promise<unknown>;
  time(): Promise<unknown>;
  ping(): Promise<unknown>;
  close?(): Promise<unknown>;
  quit?(): Promise<unknown>;
}

/** Adapts a connected node-redis v5 client. Every command fails after `timeoutMs` rather than hanging. */
export function nodeRedisCommands(client: NodeRedisClient, timeoutMs = 5000): RedisCommands {
  assertFinite("timeoutMs", timeoutMs, 1);
  const run = <T>(what: string, promise: Promise<T>) => withTimeout(promise, timeoutMs, `Redis ${what}`);
  return {
    setIfAbsent: async (key, value, ttlMs) =>
      (await run("SET", client.set(key, value, { condition: "NX", expiration: { type: "PX", value: ttlMs } }))) === "OK",
    getDel: async (key) => {
      const value = await run("GETDEL", client.getDel(key));
      return typeof value === "string" ? value : null;
    },
    exists: async (key) => Number(await run("EXISTS", client.exists(key))) > 0,
    hSet: async (key, fields) => void (await run("HSET", client.hSet(key, fields))),
    hSetIfAbsent: async (key, field, value) => Number(await run("HSETNX", client.hSetNX(key, field, value))) === 1,
    hGetAll: async (key) => {
      const value = await run("HGETALL", client.hGetAll(key));
      return typeof value === "object" && value !== null ? (value as Record<string, string>) : {};
    },
    hIncrByFloat: async (key, field, by) => Number(await run("HINCRBYFLOAT", client.hIncrByFloat(key, field, by))),
    hIncrBy: async (key, field, by) => Number(await run("HINCRBY", client.hIncrBy(key, field, by))),
    sAdd: async (key, member) => Number(await run("SADD", client.sAdd(key, member))) === 1,
    pExpire: async (key, ttlMs) => void (await run("PEXPIRE", client.pExpire(key, ttlMs))),
    zAdd: async (key, score, member) => void (await run("ZADD", client.zAdd(key, { score, value: member }))),
    zRem: async (key, member) => void (await run("ZREM", client.zRem(key, member))),
    zRangeByScore: async (key, max) => {
      const value = await run("ZRANGEBYSCORE", client.zRangeByScore(key, "-inf", max));
      return Array.isArray(value) ? value.map(String) : [];
    },
    time: async () => {
      const reply = await run("TIME", client.time());
      const [seconds, micros] = Array.isArray(reply) ? reply.map(Number) : [Number.NaN, Number.NaN];
      const ms = (seconds as number) * 1000 + Math.floor((micros as number) / 1000);
      if (!Number.isFinite(ms)) throw new Error("Redis TIME returned an unexpected reply");
      return ms;
    },
    ping: async () => void (await run("PING", client.ping())),
    quit: async () => {
      const close = client.close ?? client.quit;
      if (close) await run("close", close.call(client));
    },
  };
}

/**
 * Connects to Redis with node-redis and returns a {@link RedisLedger}.
 * Fails with a {@link ConfigError} naming REDIS_URL if Redis does not answer within `timeoutMs`.
 */
export async function connectRedisLedger(url: string, prefix: string, log: Logger, timeoutMs = 5000): Promise<RedisLedger> {
  assertFinite("timeoutMs", timeoutMs, 1);
  const { createClient } = await import("redis");
  const client = createClient({
    url,
    // Fail commands at once while disconnected, so the guard ends calls instead of queueing.
    disableOfflineQueue: true,
    socket: { connectTimeout: timeoutMs, reconnectStrategy: (retries: number) => Math.min(100 * 2 ** retries, 2000) },
  });
  client.on("error", (error: Error) => log.error("redis.error", { error: `${error.name}: ${error.message}`.slice(0, 200) }));
  const connecting = client.connect();
  connecting.catch(() => {});
  try {
    await withTimeout(connecting, timeoutMs, "Redis connect");
  } catch (error) {
    client.destroy();
    throw new ConfigError("REDIS_URL", `did not answer within ${timeoutMs / 1000} s`, "Check the URL and that Redis is reachable, or unset REDIS_URL to use the in-memory ledger.", { cause: error });
  }
  return new RedisLedger(nodeRedisCommands(client as unknown as NodeRedisClient), prefix);
}

const num = (value: string | undefined): number | undefined => (value === undefined || value === "" ? undefined : Number(value));

function decode(hash: Record<string, string>): CallRecord | undefined {
  if (!hash.id) return undefined;
  const record: CallRecord = {
    id: hash.id,
    model: hash.model ?? "",
    maxSeconds: Number(hash.maxSeconds),
    maxCostUsd: Number(hash.maxCostUsd),
    owner: hash.owner ?? "",
    claimedAt: Number(hash.claimedAt),
    costUsd: Number(hash.costUsd ?? 0),
    usageEvents: Number(hash.usageEvents ?? 0),
    usageComplete: hash.usageComplete !== "0",
    stopRequested: hash.stopRequested === "1",
  };
  const optional: Array<[keyof CallRecord, number | undefined]> = [
    ["boundAt", num(hash.boundAt)],
    ["deadlineAt", num(hash.deadlineAt)],
    ["lastSeenAt", num(hash.lastSeenAt)],
    ["settledAt", num(hash.settledAt)],
    ["durationSeconds", num(hash.durationSeconds)],
  ];
  for (const [key, value] of optional) if (value !== undefined) Object.assign(record, { [key]: value });
  if (hash.transport) record.transport = hash.transport as Transport;
  if (hash.providerCallId) record.providerCallId = hash.providerCallId;
  if (hash.endReason) record.endReason = hash.endReason as EndReason;
  if (hash.monitoringComplete) record.monitoringComplete = hash.monitoringComplete === "1";
  return record;
}

/** {@link Ledger} on Redis, safe to share between guard instances. Records expire after 24 hours. */
export class RedisLedger implements Ledger {
  readonly kind = "redis";

  constructor(
    private readonly redis: RedisCommands,
    private readonly prefix = "rvg:",
  ) {}

  private key(kind: string, id = ""): string {
    return `${this.prefix}${kind}${id ? `:${id}` : ""}`;
  }

  async putSessionConfig(id: string, session: SessionConfig, ttlMs: number): Promise<boolean> {
    if (await this.redis.exists(this.key("claim", id))) return false;
    return this.redis.setIfAbsent(this.key("cfg", id), JSON.stringify(session), ttlMs);
  }

  // Every timestamp in Redis comes from Redis's own clock, so instances whose
  // clocks disagree still agree on deadlines and heartbeats. Callers' `now`
  // values are used only for differences such as a deadline's length.

  async claim(input: ClaimInput) {
    if (!(await this.redis.setIfAbsent(this.key("claim", input.id), input.owner, RECORD_TTL_MS))) return undefined;
    const now = await this.redis.time();
    const call = this.key("call", input.id);
    await this.redis.hSet(call, {
      id: input.id,
      model: input.model,
      maxSeconds: String(input.maxSeconds),
      maxCostUsd: String(input.maxCostUsd),
      owner: input.owner,
      claimedAt: String(now),
      costUsd: "0",
      usageEvents: "0",
      usageComplete: "1",
      stopRequested: "0",
    });
    await this.redis.pExpire(call, RECORD_TTL_MS);
    const raw = await this.redis.getDel(this.key("cfg", input.id));
    const record = decode(await this.redis.hGetAll(call)) as CallRecord;
    return raw ? { record, session: JSON.parse(raw) as SessionConfig } : { record };
  }

  async bind(id: string, input: BindInput): Promise<void> {
    const call = this.key("call", id);
    const record = decode(await this.redis.hGetAll(call));
    if (!record) throw new Error("Unknown call");
    if (record.settledAt !== undefined) throw new Error("Call already settled");
    if (record.providerCallId && record.providerCallId !== input.providerCallId) throw new Error("Call already bound");
    const now = await this.redis.time();
    const deadlineAt = now + (input.deadlineAt - input.now);
    await this.redis.hSet(call, {
      transport: input.transport,
      providerCallId: input.providerCallId,
      boundAt: String(now),
      lastSeenAt: String(now),
      deadlineAt: String(deadlineAt),
    });
    await this.redis.zAdd(this.key("deadlines"), deadlineAt, id);
    await this.redis.zAdd(this.key("seen"), now, id);
  }

  async observe(id: string, input: ObserveInput) {
    const call = this.key("call", id);
    const responsesKey = this.key("responses", id);
    const before = decode(await this.redis.hGetAll(call));
    if (!before) throw new Error("Unknown call");
    if (before.settledAt !== undefined || !(await this.redis.sAdd(responsesKey, input.responseId))) {
      const record = before.settledAt !== undefined ? before : decode(await this.redis.hGetAll(call));
      return { duplicate: true, costUsd: record?.costUsd ?? 0, usageEvents: record?.usageEvents ?? 0 };
    }
    await this.redis.pExpire(responsesKey, RECORD_TTL_MS);
    const costUsd = await this.redis.hIncrByFloat(call, "costUsd", input.costUsd);
    const usageEvents = await this.redis.hIncrBy(call, "usageEvents", 1);
    if (!input.complete) await this.redis.hSet(call, { usageComplete: "0" });
    return { duplicate: false, costUsd, usageEvents };
  }

  async heartbeat(id: string) {
    const record = decode(await this.redis.hGetAll(this.key("call", id)));
    if (!record || record.settledAt !== undefined || record.stopRequested) return { active: false };
    const now = await this.redis.time();
    await this.redis.hSet(this.key("call", id), { lastSeenAt: String(now) });
    await this.redis.zAdd(this.key("seen"), now, id);
    return { active: true };
  }

  async requestStop(id: string) {
    const call = this.key("call", id);
    const record = decode(await this.redis.hGetAll(call));
    if (!record) return undefined;
    await this.redis.hSet(call, { stopRequested: "1" });
    return { ...record, stopRequested: true };
  }

  async settle(id: string, input: SettleInput) {
    const call = this.key("call", id);
    const before = decode(await this.redis.hGetAll(call));
    if (!before) return undefined;
    const now = await this.redis.time();
    if (!(await this.redis.hSetIfAbsent(call, "settledAt", String(now)))) {
      return { record: decode(await this.redis.hGetAll(call)) as CallRecord, first: false };
    }
    const record: CallRecord = {
      ...before,
      settledAt: now,
      endReason: finalReason(before, input.reason),
      durationSeconds: durationSeconds(before, now),
      monitoringComplete: input.monitoringComplete && before.usageComplete,
    };
    await this.redis.hSet(call, {
      endReason: record.endReason as string,
      durationSeconds: String(record.durationSeconds),
      monitoringComplete: record.monitoringComplete ? "1" : "0",
    });
    await this.redis.zRem(this.key("deadlines"), id);
    await this.redis.zRem(this.key("seen"), id);
    return { record, first: true };
  }

  async get(id: string) {
    return decode(await this.redis.hGetAll(this.key("call", id)));
  }

  async overdue({ deadlineGraceMs, staleAfterMs }: OverdueInput): Promise<OverdueCall[]> {
    const now = await this.redis.time();
    const late = await this.redis.zRangeByScore(this.key("deadlines"), now - deadlineGraceMs);
    const quiet = await this.redis.zRangeByScore(this.key("seen"), now - staleAfterMs);
    const out: OverdueCall[] = [];
    for (const [ids, why] of [[late, "deadline"], [quiet, "stale"]] as const) {
      for (const id of ids) {
        if (out.some((item) => item.record.id === id)) continue;
        const record = await this.get(id);
        if (!record || record.settledAt !== undefined) {
          await this.redis.zRem(this.key("deadlines"), id);
          await this.redis.zRem(this.key("seen"), id);
          continue;
        }
        out.push({ record, why });
      }
    }
    return out;
  }

  async ping(): Promise<void> {
    await this.redis.ping();
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
