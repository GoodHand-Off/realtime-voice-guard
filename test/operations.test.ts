// Operating the guard: stop and shutdown while OpenAI misbehaves, readiness,
// Redis outages, backpressure, bad headers, skewed clocks and restarts.

import { connect as tcpConnect } from "node:net";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSession } from "../src/call.js";
import { MemoryLedger } from "../src/ledger.js";
import { RedisLedger } from "../src/redis-ledger.js";
import { relayWebSocket } from "../src/relay.js";
import { Secret } from "../src/secret.js";
import { signTicket } from "../src/ticket.js";
import { API_KEY, FakeRedis, FakeSocket, MODEL, SIGNING_SECRET, startGuard, waitFor } from "./helpers.js";

type Harness = Awaited<ReturnType<typeof startGuard>>;
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const settled = (harness: Harness, id: string) => waitFor(async () => {
  const record = await harness.ledger.get(id);
  return record?.settledAt !== undefined ? record : undefined;
});

async function connect(harness: Harness, body: Record<string, unknown> = {}) {
  const ticket = await harness.mint(body);
  expect((await harness.offer(ticket.value)).status).toBe(201);
  return ticket.call_id;
}

describe("stop and shutdown while OpenAI won't confirm a hang-up", () => {
  it("answers a stop at once and keeps retrying in the background", async () => {
    h = await startGuard({ config: { shutdownGraceSeconds: 1 }, openai: { hangup: Array(30).fill("hang") } });
    const id = await connect(h);
    const started = Date.now();
    const response = await fetch(`${h.url}/v1/admin/calls/${id}/stop`, { method: "POST", headers: { Authorization: `Bearer ${API_KEY}` } });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ stopping: true, call: { id, stopRequested: true } });
  });

  it("finishes shutdown within its grace period", async () => {
    h = await startGuard({ config: { shutdownGraceSeconds: 1 }, openai: { hangup: ["hang"] } });
    await connect(h);
    const { lines } = h;
    const started = Date.now();
    await h.close();
    h = undefined;
    expect(Date.now() - started).toBeLessThan(2500);
    expect(lines.some((line) => line.message === "guard.shutdown_incomplete")).toBe(true);
  });
});

describe("readiness and Redis outages", () => {
  it("reports ready, then not ready while Redis is down, then ready again", async () => {
    const redis = new FakeRedis();
    h = await startGuard({ ledger: new RedisLedger(redis, "ready:") });
    const ready = async () => fetch(`${h?.url}/ready`).then(async (r) => [r.status, ((await r.json()) as { status?: string; error?: { code: string } })] as const);
    expect(await ready()).toEqual([200, { status: "ready", ledger: "redis" }]);
    redis.down = true;
    const [status, body] = await ready();
    expect(status).toBe(503);
    expect(body.error?.code).toBe("ledger_unavailable");
    expect((await fetch(`${h.url}/health`)).status).toBe(200); // liveness is unaffected
    redis.down = false;
    expect((await ready())[0]).toBe(200);
  });

  it("rides out one missed heartbeat, and ends the call after two", async () => {
    const redis = new FakeRedis();
    h = await startGuard({ ledger: new RedisLedger(redis, "hb:"), config: { heartbeatSeconds: 1 } });
    const id = await connect(h);
    redis.down = true;
    await waitFor(() => h?.lines.some((line) => line.message === "call.heartbeat_missed"), 3000);
    redis.down = false;
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(h.guard.context.active.has(id)).toBe(true); // a short failover doesn't end calls
    redis.down = true;
    await waitFor(() => !h?.guard.context.active.has(id), 5000);
    expect(h.lines.filter((line) => line.message === "call.heartbeat_missed").length).toBeGreaterThanOrEqual(2);
    redis.down = false;
  });
});

describe("relay safety", () => {
  async function relayWith(harness: Harness, id: string, options: { client?: FakeSocket; failConnect?: boolean } = {}) {
    const ctx = harness.guard.context;
    await ctx.ledger.claim({ id, model: MODEL, maxSeconds: 60, maxCostUsd: 1, owner: ctx.instanceId, now: Date.now() });
    const client = options.client ?? new FakeSocket("client", "open");
    await waitFor(() => client.readyState === 1);
    if (options.failConnect) {
      ctx.openai.connect = () => {
        throw new TypeError("Invalid character in header content");
      };
    }
    const claims = { id, exp: Date.now() + 60_000, model: MODEL, maxSeconds: 60, maxCostUsd: 1 };
    const call = relayWebSocket(ctx, claims, buildSession(undefined, MODEL, 1024, 1000), client);
    return { call, client };
  }

  it("ends the call when the client stops reading", async () => {
    h = await startGuard();
    const { client } = await relayWith(h, "call_slow_client");
    const upstream = h.openai.lastSocket();
    await waitFor(() => upstream.sent.length > 0); // session.update sent
    client.bufferedAmount = 9 * 1024 * 1024;
    upstream.server({ type: "response.output_audio.delta", delta: "AAAA" });
    expect((await settled(h, "call_slow_client")).endReason).toBe("slow_client");
  });

  it("ends the call when OpenAI stops reading", async () => {
    h = await startGuard();
    const { client } = await relayWith(h, "call_slow_openai");
    const upstream = h.openai.lastSocket();
    await waitFor(async () => (await h?.ledger.get("call_slow_openai"))?.boundAt !== undefined);
    upstream.bufferedAmount = 9 * 1024 * 1024;
    client.emit("message", Buffer.from(JSON.stringify({ type: "input_audio_buffer.append", audio: "AAAA" })));
    expect((await settled(h, "call_slow_openai")).endReason).toBe("provider_error");
  });

  it("ends a relay call whose session OpenAI never confirms within 15 seconds", async () => {
    h = await startGuard({ openai: { relayReady: false } });
    const ctx = h.guard.context;
    await ctx.ledger.claim({ id: "call_never_ready", model: MODEL, maxSeconds: 60, maxCostUsd: 1, owner: ctx.instanceId, now: Date.now() });
    const client = new FakeSocket("client", "open");
    await waitFor(() => client.readyState === 1);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    relayWebSocket(ctx, { id: "call_never_ready", exp: Date.now() + 60_000, model: MODEL, maxSeconds: 60, maxCostUsd: 1 }, buildSession(undefined, MODEL, 1024, 1000), client);
    vi.advanceTimersByTime(15_001);
    vi.useRealTimers();
    expect((await settled(h, "call_never_ready")).endReason).toBe("provider_error");
  });

  it("ends the call if the ledger refuses the binding, or the client socket errors", async () => {
    h = await startGuard();
    const ctx = h.guard.context;
    // Not claimed first, so the ledger refuses to bind it.
    const unclaimed = new FakeSocket("client", "open");
    await waitFor(() => unclaimed.readyState === 1);
    relayWebSocket(ctx, { id: "call_unclaimed_1", exp: Date.now() + 60_000, model: MODEL, maxSeconds: 60, maxCostUsd: 1 }, buildSession(undefined, MODEL, 1024, 1000), unclaimed);
    await waitFor(() => !ctx.active.has("call_unclaimed_1"));
    const { client } = await relayWith(h, "call_client_err");
    client.emit("error", new Error("reset"));
    expect((await settled(h, "call_client_err")).endReason).toBe("monitor_lost");
  });

  it("resets the frame budget every second", async () => {
    h = await startGuard();
    const { client } = await relayWith(h, "call_frames_ok");
    const upstream = h.openai.lastSocket();
    await waitFor(async () => (await h?.ledger.get("call_frames_ok"))?.boundAt !== undefined);
    const append = Buffer.from(JSON.stringify({ type: "input_audio_buffer.append", audio: "AA" }));
    for (let i = 0; i < 90; i++) client.emit("message", append);
    await new Promise((resolve) => setTimeout(resolve, 1050));
    for (let i = 0; i < 90; i++) client.emit("message", append);
    expect(upstream.sent.filter((event) => event.type === "input_audio_buffer.append")).toHaveLength(180);
    expect(h.guard.context.active.has("call_frames_ok")).toBe(true);
  });

  it("ends the call when OpenAI neither starts nor refuses a response.create within 10 seconds (A4)", async () => {
    h = await startGuard();
    const { client } = await relayWith(h, "call_start_lost");
    const upstream = h.openai.lastSocket();
    await waitFor(async () => (await h?.ledger.get("call_start_lost"))?.boundAt !== undefined);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    client.emit("message", Buffer.from(JSON.stringify({ type: "response.create" })));
    vi.advanceTimersByTime(9_999);
    client.emit("message", Buffer.from(JSON.stringify({ type: "response.create" }))); // still waiting: refused
    vi.advanceTimersByTime(2);
    vi.useRealTimers();
    expect((await settled(h, "call_start_lost")).endReason).toBe("monitor_lost");
    expect(upstream.sent.filter((event) => event.type === "response.create")).toHaveLength(1);
    expect(client.sent.some((event) => (event.error as { code?: string } | undefined)?.code === "response_in_progress")).toBe(true);
    expect(h.lines.some((line) => line.message === "call.response_start_lost")).toBe(true);
  });

  it("does not leak a call when the upstream connection can't even be opened", async () => {
    h = await startGuard();
    const { client } = await relayWith(h, "call_bad_upstream", { failConnect: true });
    expect((await settled(h, "call_bad_upstream")).endReason).toBe("provider_error");
    expect(client.readyState).toBe(3);
    expect(h.guard.context.active.has("call_bad_upstream")).toBe(false);
  });
});

describe("tickets at the edges", () => {
  it("refuses a safety identifier that can't go into an HTTP header", async () => {
    h = await startGuard();
    expect((await h.mint({ safety_identifier: "has space" })).error?.code).toBe("invalid_safety_identifier");
    expect((await h.mint({ safety_identifier: "emoji-🙂" })).error?.code).toBe("invalid_safety_identifier");
    const forged = signTicket({ id: "call_bad_sid_01", exp: Date.now() + 60_000, model: MODEL, maxSeconds: 60, maxCostUsd: 0.1, sid: "line\nbreak" }, SIGNING_SECRET);
    expect((await h.offer(forged)).status).toBe(401);
  });

  it("allows 30 seconds of clock skew between the instance that signed and the one that verifies", async () => {
    h = await startGuard({ ledger: new RedisLedger(new FakeRedis(), "skew:") });
    const sign = (id: string, extra: number) => signTicket({ id, exp: Date.now() + 120_000 + extra, model: MODEL, maxSeconds: 60, maxCostUsd: 0.1 }, SIGNING_SECRET);
    expect((await h.offer(sign("call_skew_ok_1", 20_000))).status).toBe(201);
    expect((await h.offer(sign("call_skew_bad1", 40_000))).status).toBe(401);
  });

  it("with the in-memory ledger, refuses tickets issued before this instance started, however shortly before", async () => {
    const before = Date.now();
    h = await startGuard({ ledger: new MemoryLedger() });
    const old = signTicket({ id: "call_replay_001", iat: Date.now() - 60_000, exp: Date.now() + 60_000, model: MODEL, maxSeconds: 60, maxCostUsd: 0.1 }, SIGNING_SECRET);
    const response = await h.offer(old);
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain("before this instance started");
    // A ticket used just before a restart can't be replayed within a clock-skew window either.
    const recent = signTicket({ id: "call_replay_003", iat: before - 1000, exp: Date.now() + 60_000, model: MODEL, maxSeconds: 60, maxCostUsd: 0.1 }, SIGNING_SECRET);
    expect((await h.offer(recent)).status).toBe(401);
    const fresh = signTicket({ id: "call_replay_002", exp: Date.now() + 60_000, model: MODEL, maxSeconds: 60, maxCostUsd: 0.1 }, SIGNING_SECRET);
    expect((await h.offer(fresh)).status).toBe(201);
  });

  it("refuses an upgrade with an unsupported WebSocket version without burning the ticket", async () => {
    h = await startGuard();
    const ticket = await h.mint();
    const socket = tcpConnect(Number(new URL(h.url).port), "127.0.0.1");
    const reply = new Promise<string>((resolve) => socket.once("data", (data) => resolve(String(data))));
    socket.write(`GET /v1/realtime HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 7\r\nAuthorization: Bearer ${ticket.value}\r\n\r\n`);
    expect(await reply).toContain("400");
    socket.destroy();
    expect(await h.ledger.get(ticket.call_id)).toBeUndefined();
  });
});

describe("keys stay out of a live call", () => {
  it("inspecting a call object or the guard's context shows no keys", async () => {
    // A distinctive key, and fake sockets that keep no headers (as real ones don't), so a leak would show.
    const openaiKey = "sk-test-" + "o".repeat(32);
    h = await startGuard({ config: { openaiApiKey: new Secret(openaiKey) } });
    const id = await connect(h);
    h.openai.lastSocket().server({ type: "response.created", response: { id: "resp_1", max_output_tokens: 1024 } });
    expect(h.openai.socketAuth.at(-1)).toBe(`Bearer ${openaiKey}`); // it was sent
    for (const target of [h.guard.context.active.get(id), h.guard.context]) {
      const text = inspect(target, { depth: 10, showHidden: true });
      for (const key of [openaiKey, SIGNING_SECRET, API_KEY]) expect(text).not.toContain(key);
    }
  });
});
