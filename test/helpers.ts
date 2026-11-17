import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { GuardConfig } from "../src/config.js";
import { MemoryLedger, type Ledger } from "../src/ledger.js";
import type { LogFields, Logger } from "../src/log.js";
import type { SocketLike } from "../src/openai.js";
import { parsePriceTable } from "../src/pricing.js";
import { Secret } from "../src/secret.js";
import type { RedisCommands } from "../src/redis-ledger.js";
import { createGuard, type Guard } from "../src/server.js";

// Deliberately low-entropy so no secret scanner mistakes a fixture for a key.
export const SIGNING_SECRET = "s".repeat(40);
export const API_KEY = "k".repeat(40);
export const WEBHOOK_SECRET = "w".repeat(40);
export const MODEL = "gpt-realtime-2.1-mini";
export const PRICES = parsePriceTable(JSON.parse(readFileSync(new URL("../prices.json", import.meta.url), "utf8")));

export function testConfig(overrides: Partial<GuardConfig> = {}): GuardConfig {
  return {
    openaiApiKey: new Secret("fake"),
    openaiBaseUrl: "https://openai.test",
    signingSecret: new Secret(SIGNING_SECRET),
    apiKey: new Secret(API_KEY),
    host: "127.0.0.1",
    port: 0,
    prices: PRICES,
    maxCallSeconds: 600,
    maxCallCostUsd: 1,
    maxConcurrentCalls: 10,
    maxOutputTokens: 1024,
    maxResponsesPerCall: 300,
    heartbeatSeconds: 15,
    ticketTtlSeconds: 120,
    allowedOrigins: ["http://app.test"],
    rateLimitPerMinute: 0,
    trustedProxies: 0,
    // The lowest allowed, so a $0.10 test cap covers two worst-case responses on the mini model (about $0.031 each).
    maxInputTokens: 1000,
    shutdownGraceSeconds: 25,
    redisPrefix: "rvg:",
    ...overrides,
  };
}

/**
 * A stand-in for a `ws` WebSocket to OpenAI. Like a real one, it keeps no
 * request headers, so inspecting a live call can catch a key the guard leaks.
 */
export class FakeSocket extends EventEmitter implements SocketLike {
  readyState = 0;
  bufferedAmount = 0;
  readonly sent: Array<Record<string, unknown>> = [];

  constructor(
    readonly url: string,
    open: "open" | "error",
    private readonly answerSessionUpdate = true,
  ) {
    super();
    setTimeout(() => {
      if (this.readyState !== 0) return;
      if (open === "error") {
        this.emit("error", new Error("offline"));
        this.close();
        return;
      }
      this.readyState = 1;
      this.emit("open");
    }, 1);
  }

  send(data: string): void {
    const event = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(event);
    // OpenAI answers session.update with the effective session.
    if (event.type === "session.update" && this.answerSessionUpdate) {
      const model = new URL(this.url).searchParams.get("model");
      setTimeout(() => this.server({ type: "session.updated", session: { ...(event.session as object), model } }), 1);
    }
  }

  close(): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.emit("close");
  }

  terminate(): void {
    this.close();
  }

  /** Delivers a server event to the guard. */
  server(event: Record<string, unknown>): void {
    if (this.readyState === 1) this.emit("message", Buffer.from(JSON.stringify(event)));
  }
}

export interface FakeOpenAIOptions {
  createStatus?: number;
  location?: string | null;
  /** Status per hang-up attempt, in order; "throw" is a network error, "hang" never answers. Defaults to 200. */
  hangup?: Array<number | "throw" | "hang">;
  sideband?: "open" | "error";
  /** When false, the relay upstream never answers session.update. */
  relayReady?: boolean;
  /** Delay before OpenAI answers a create-call request. */
  createDelayMs?: number;
  webhookUrl?: string;
}

export function fakeOpenAI(options: FakeOpenAIOptions = {}) {
  const requests: Array<{ url: string; method: string; headers: Headers }> = [];
  const sessions: Array<Record<string, unknown>> = [];
  const webhooks: Array<{ body: string; headers: Headers }> = [];
  const sockets: FakeSocket[] = [];
  /** The Authorization header each socket was opened with, kept here rather than on the socket. */
  const socketAuth: Array<string | undefined> = [];
  const hangupPlan = [...(options.hangup ?? [])];

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({ url, method: init?.method ?? "GET", headers });
    if (options.webhookUrl && url === options.webhookUrl) {
      webhooks.push({ body: String(init?.body), headers });
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/hangup")) {
      const next = hangupPlan.shift() ?? 200;
      if (next === "throw") throw new Error("network down");
      if (next === "hang") {
        // Never answers, but honours the abort signal the way a real fetch does.
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      return new Response(null, { status: next });
    }
    if (url.endsWith("/v1/realtime/calls")) {
      if (options.createDelayMs) await new Promise((resolve) => setTimeout(resolve, options.createDelayMs));
      const form = init?.body as FormData;
      sessions.push(JSON.parse(String(form.get("session"))) as Record<string, unknown>);
      const location = options.location === undefined ? "/v1/realtime/calls/rtc_test123" : options.location;
      return new Response("v=0 fake-answer", { status: options.createStatus ?? 201, headers: location ? { Location: location } : {} });
    }
    return new Response(null, { status: 404 });
  };

  const socketFactory = (url: string, headers: Record<string, string>) => {
    const socket = new FakeSocket(url, url.includes("call_id=") ? (options.sideband ?? "open") : "open", options.relayReady ?? true);
    sockets.push(socket);
    socketAuth.push(headers.Authorization);
    return socket;
  };

  return {
    fetch: fetchImpl as typeof fetch,
    socketFactory,
    requests,
    sessions,
    webhooks,
    sockets,
    socketAuth,
    creates: () => requests.filter((r) => r.url.endsWith("/v1/realtime/calls")),
    hangups: () => requests.filter((r) => r.url.endsWith("/hangup")).map((r) => r.url),
    lastSocket: () => {
      const socket = sockets.at(-1);
      if (!socket) throw new Error("No socket opened");
      return socket;
    },
  };
}

export function captureLogger() {
  const lines: Array<{ level: string; message: string; fields?: LogFields }> = [];
  const logger: Logger = {
    info: (message, fields) => lines.push({ level: "info", message, fields }),
    warn: (message, fields) => lines.push({ level: "warn", message, fields }),
    error: (message, fields) => lines.push({ level: "error", message, fields }),
  };
  return { logger, lines };
}

export async function startGuard(options: { config?: Partial<GuardConfig>; openai?: FakeOpenAIOptions; ledger?: Ledger; now?: () => number; responseTimeoutMs?: number } = {}) {
  const openai = fakeOpenAI(options.openai);
  const ledger = options.ledger ?? new MemoryLedger();
  const { logger, lines } = captureLogger();
  const guard: Guard = await createGuard(testConfig(options.config), {
    ledger,
    fetch: openai.fetch,
    socketFactory: openai.socketFactory,
    log: logger,
    watchdogIntervalMs: 3_600_000,
    retryDelayMs: 1,
    now: options.now,
    responseTimeoutMs: options.responseTimeoutMs,
  });
  const port = await guard.listen(0, "127.0.0.1");
  const url = `http://127.0.0.1:${port}`;

  const mint = async (body: Record<string, unknown> = {}) => {
    const response = await fetch(`${url}/v1/tickets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ session: { model: MODEL }, ...body }),
    });
    const json = (await response.json()) as { value: string; call_id: string; error?: { code: string } };
    return { status: response.status, ...json };
  };

  const offer = (ticket: string, headers: Record<string, string> = {}) =>
    fetch(`${url}/v1/realtime/calls`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ticket}`, "Content-Type": "application/sdp", ...headers },
      body: "v=0 fake-offer",
    });

  return { guard, url, openai, ledger, lines, mint, offer, close: () => guard.close() };
}

export async function waitFor<T>(check: () => T | Promise<T>, timeoutMs = 4000): Promise<NonNullable<T>> {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** In-memory stand-in for Redis, implementing only the commands RedisLedger uses. */
export class FakeRedis implements RedisCommands {
  /** Redis's clock, which every instance shares. */
  clock: () => number = Date.now;
  /** While true, every command fails as if Redis were unreachable. */
  down = false;
  private readonly strings = new Map<string, { value: string; expiresAt: number }>();
  private readonly hashes = new Map<string, Map<string, string>>();
  private readonly sets = new Map<string, Set<string>>();
  private readonly zsets = new Map<string, Map<string, number>>();

  private live(key: string) {
    const entry = this.strings.get(key);
    if (entry && entry.expiresAt <= Date.now()) this.strings.delete(key);
    return this.strings.get(key);
  }

  private up(): void {
    if (this.down) throw new Error("Redis unavailable");
  }
  async time() {
    this.up();
    return this.clock();
  }
  async ping() {
    this.up();
  }
  async setIfAbsent(key: string, value: string, ttlMs: number) {
    this.up();
    if (this.live(key)) return false;
    this.strings.set(key, { value, expiresAt: Date.now() + ttlMs });
    return true;
  }
  async getDel(key: string) {
    this.up();
    const entry = this.live(key);
    this.strings.delete(key);
    return entry?.value ?? null;
  }
  async exists(key: string) {
    this.up();
    return Boolean(this.live(key)) || this.hashes.has(key);
  }
  async hSet(key: string, fields: Record<string, string>) {
    this.up();
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    for (const [field, value] of Object.entries(fields)) hash.set(field, value);
    this.hashes.set(key, hash);
  }
  async hSetIfAbsent(key: string, field: string, value: string) {
    this.up();
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    this.hashes.set(key, hash);
    if (hash.has(field)) return false;
    hash.set(field, value);
    return true;
  }
  async hGetAll(key: string) {
    this.up();
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }
  async hIncrByFloat(key: string, field: string, by: number) {
    this.up();
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    const next = Number(hash.get(field) ?? 0) + by;
    hash.set(field, String(next));
    this.hashes.set(key, hash);
    return next;
  }
  async hIncrBy(key: string, field: string, by: number) {
    return this.hIncrByFloat(key, field, by);
  }
  async sAdd(key: string, member: string) {
    this.up();
    const set = this.sets.get(key) ?? new Set<string>();
    this.sets.set(key, set);
    if (set.has(member)) return false;
    set.add(member);
    return true;
  }
  async pExpire() {}
  async zAdd(key: string, score: number, member: string) {
    this.up();
    const zset = this.zsets.get(key) ?? new Map<string, number>();
    zset.set(member, score);
    this.zsets.set(key, zset);
  }
  async zRem(key: string, member: string) {
    this.zsets.get(key)?.delete(member);
  }
  async zRangeByScore(key: string, max: number) {
    this.up();
    return [...(this.zsets.get(key) ?? [])].filter(([, score]) => score <= max).sort((a, b) => a[1] - b[1]).map(([member]) => member);
  }
  async quit() {}
}
