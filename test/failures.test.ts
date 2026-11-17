// Failure paths a deployment can hit: ledger outages, malformed provider
// events, misbehaving clients, bad requests and bad settings.

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { MemoryLedger, type CallRecord, type ObserveInput, type OverdueInput, type SettleInput } from "../src/ledger.js";
import { ProviderError, createOpenAIRealtime, defaultSocketFactory } from "../src/openai.js";
import { TicketError, verifyTicket } from "../src/ticket.js";
import { API_KEY, SIGNING_SECRET, startGuard, waitFor } from "./helpers.js";

type Harness = Awaited<ReturnType<typeof startGuard>>;
let h: Harness | undefined;
const clients: WebSocket[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) if (client.readyState === WebSocket.OPEN) client.terminate();
  await h?.close();
  h = undefined;
});

/** A ledger whose writes can be made to fail on demand. */
class FlakyLedger extends MemoryLedger {
  fail = { observe: false, heartbeat: false, settle: false, overdue: false };
  override async observe(id: string, input: ObserveInput) {
    if (this.fail.observe) throw new Error("ledger down");
    return super.observe(id, input);
  }
  override async heartbeat(id: string, now: number) {
    if (this.fail.heartbeat) throw new Error("ledger down");
    return super.heartbeat(id, now);
  }
  override async settle(id: string, input: SettleInput) {
    if (this.fail.settle) throw new Error("ledger down");
    return super.settle(id, input);
  }
  override async overdue(input: OverdueInput) {
    if (this.fail.overdue) throw new Error("ledger down");
    return super.overdue(input);
  }
}

const settled = (harness: Harness, id: string) => waitFor(async () => {
  const record = await harness.ledger.get(id);
  return record?.settledAt !== undefined ? record : undefined;
});

async function webrtc(harness: Harness, body: Record<string, unknown> = {}) {
  const ticket = await harness.mint(body);
  expect((await harness.offer(ticket.value)).status).toBe(201);
  return { id: ticket.call_id, sideband: harness.openai.lastSocket() };
}

async function relay(harness: Harness) {
  const ticket = await harness.mint();
  const client = new WebSocket(`${harness.url.replace("http", "ws")}/v1/realtime`, { headers: { Authorization: `Bearer ${ticket.value}` } });
  clients.push(client);
  await new Promise<void>((resolve, reject) => {
    client.once("open", () => resolve());
    client.once("error", reject);
  });
  return { id: ticket.call_id, client, upstream: harness.openai.lastSocket() };
}

describe("ledger outages end the call", () => {
  it("when metering cannot be recorded", async () => {
    const ledger = new FlakyLedger();
    h = await startGuard({ ledger });
    const { id, sideband } = await webrtc(h);
    ledger.fail.observe = true;
    sideband.server({ type: "response.done", response: { id: "resp_1", usage: { input_tokens: 1, output_tokens: 1 } } });
    expect(await settled(h, id)).toMatchObject({ endReason: "monitor_lost", monitoringComplete: false });
    expect(h.lines.some((line) => line.message === "ledger.observe_failed")).toBe(true);
  });

  it("when the heartbeat cannot be written", async () => {
    const ledger = new FlakyLedger();
    h = await startGuard({ ledger, config: { heartbeatSeconds: 1 } });
    const { id } = await webrtc(h);
    ledger.fail.heartbeat = true;
    expect((await settled(h, id)).endReason).toBe("heartbeat_lost");
    expect(h.openai.hangups()).toHaveLength(1);
  });

  it("and still hangs up when the settlement cannot be written", async () => {
    const ledger = new FlakyLedger();
    h = await startGuard({ ledger, config: { maxCallSeconds: 1 } });
    await webrtc(h, { max_seconds: 1 });
    ledger.fail.settle = true;
    await waitFor(() => h?.lines.some((line) => line.message === "ledger.settle_failed"));
    expect(h.openai.hangups()).toHaveLength(1);
  });
});

describe("malformed provider events", () => {
  it("end a WebRTC call when the sideband sends something that is not JSON", async () => {
    h = await startGuard();
    const { id, sideband } = await webrtc(h);
    sideband.emit("message", Buffer.from("not json"));
    expect((await settled(h, id)).endReason).toBe("monitor_lost");
  });

  it("end a relay call when upstream sends something that is not JSON", async () => {
    h = await startGuard();
    const { id, upstream } = await relay(h);
    await waitFor(async () => (await h?.ledger.get(id))?.boundAt !== undefined);
    upstream.emit("message", [Buffer.from("not "), Buffer.from("json")]);
    expect((await settled(h, id)).endReason).toBe("monitor_lost");
  });
});

describe("misbehaving relay clients", () => {
  it("are cut off for invalid JSON", async () => {
    h = await startGuard();
    const { id, client } = await relay(h);
    client.send("{nope");
    expect((await settled(h, id)).endReason).toBe("policy");
  });

  it("are cut off for flooding more than 100 frames a second", async () => {
    h = await startGuard();
    const { id, client } = await relay(h);
    for (let i = 0; i < 120; i++) client.send(JSON.stringify({ type: "input_audio_buffer.append", audio: "AA" }));
    expect((await settled(h, id)).endReason).toBe("policy");
  });

  it("are cut off for queueing too much before the session is ready", async () => {
    h = await startGuard({ openai: { relayReady: false } });
    const { id, client } = await relay(h);
    const chunk = JSON.stringify({ type: "input_audio_buffer.append", audio: "A".repeat(100_000) });
    for (let i = 0; i < 3; i++) client.send(chunk);
    expect((await settled(h, id)).endReason).toBe("policy");
    expect((await h.ledger.get(id))?.boundAt).toBeUndefined();
  });

  it("that leave before the session is ready settle as ended", async () => {
    h = await startGuard({ openai: { relayReady: false } });
    const { id, client } = await relay(h);
    client.close();
    expect(await settled(h, id)).toMatchObject({ endReason: "ended", durationSeconds: 0 });
  });
});

describe("bad requests", () => {
  it("get clear errors without reaching OpenAI", async () => {
    h = await startGuard();
    const post = (path: string, body: string, auth = API_KEY) => fetch(`${h?.url}${path}`, { method: "POST", headers: { Authorization: `Bearer ${auth}` }, body });
    expect((await fetch(`${h.url}/nope`)).status).toBe(404);
    expect(((await (await post("/v1/tickets", "{")).json()) as { error: { code: string } }).error.code).toBe("invalid_json");
    expect(((await (await post("/v1/tickets", "[]")).json()) as { error: { code: string } }).error.code).toBe("invalid_request");
    expect((await post("/v1/tickets", "x".repeat(70_000))).status).toBe(413);
    expect((await h.mint({ call_id: "bad id!" })).error?.code).toBe("invalid_call_id");
    expect((await h.mint({ safety_identifier: "x".repeat(65) })).error?.code).toBe("invalid_safety_identifier");
    const ticket = await h.mint();
    expect((await fetch(`${h.url}/v1/realtime/calls`, { method: "POST", headers: { Authorization: `Bearer ${ticket.value}` }, body: " " })).status).toBe(400);
    expect((await fetch(`${h.url}/v1/admin/calls/call_unknown_1`, { headers: { Authorization: `Bearer ${API_KEY}` } })).status).toBe(404);
    expect((await post("/v1/admin/calls/call_unknown_1/stop", "")).status).toBe(404);
    expect(h.openai.requests).toHaveLength(0);
  });

  it("refuse WebSocket upgrades on other paths", async () => {
    h = await startGuard();
    const client = new WebSocket(`${h.url.replace("http", "ws")}/elsewhere`);
    clients.push(client);
    expect(await new Promise((resolve) => client.once("unexpected-response", (_req, res) => resolve(res.statusCode)))).toBe(404);
  });

  it("answer 500 without internals when the ledger fails during a claim", async () => {
    const ledger = new MemoryLedger();
    ledger.claim = async () => {
      throw new Error("secret internal detail");
    };
    h = await startGuard({ ledger });
    const response = await h.offer((await h.mint()).value);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret internal detail");
  });
});

describe("stopping a call another instance owns", () => {
  it("hangs it up at OpenAI directly", async () => {
    h = await startGuard();
    await h.ledger.claim({ id: "call_remote_01", model: "gpt-realtime-2.1-mini", maxSeconds: 60, maxCostUsd: 1, owner: "other", now: Date.now() });
    await h.ledger.bind("call_remote_01", { transport: "webrtc", providerCallId: "rtc_remote", now: Date.now(), deadlineAt: Date.now() + 60_000 });
    const response = await fetch(`${h.url}/v1/admin/calls/call_remote_01/stop`, { method: "POST", headers: { Authorization: `Bearer ${API_KEY}` } });
    expect(response.status).toBe(202);
    expect(((await response.json()) as { call: CallRecord }).call.stopRequested).toBe(true);
    expect(h.openai.hangups()).toEqual(["https://openai.test/v1/realtime/calls/rtc_remote/hangup"]);
  });
});

describe("watchdog edge cases", () => {
  it("finishes its own call if the local deadline timer was missed", async () => {
    let offset = 0;
    h = await startGuard({ now: () => Date.now() + offset });
    const { id } = await webrtc(h, { max_seconds: 60 });
    offset = 2 * 60_000;
    await h.guard.watchdog.tick();
    expect((await settled(h, id)).endReason).toBe("max_duration");
  });

  it("logs and carries on when the ledger is unreachable", async () => {
    const ledger = new FlakyLedger();
    ledger.fail.overdue = true;
    h = await startGuard({ ledger });
    await Promise.all([h.guard.watchdog.tick(), h.guard.watchdog.tick()]);
    expect(h.lines.filter((line) => line.message === "watchdog.ledger_unavailable")).toHaveLength(1);
  });

  it("logs a call it could not settle and keeps going", async () => {
    const ledger = new FlakyLedger();
    h = await startGuard({ ledger });
    await ledger.claim({ id: "call_orphan_bad", model: "gpt-realtime-2.1-mini", maxSeconds: 1, maxCostUsd: 1, owner: "dead", now: 0 });
    await ledger.bind("call_orphan_bad", { transport: "websocket", providerCallId: "ws:call_orphan_bad", now: 0, deadlineAt: 1000 });
    ledger.fail.settle = true;
    await h.guard.watchdog.tick();
    expect(h.lines.some((line) => line.message === "watchdog.failed")).toBe(true);
  });
});

describe("OpenAI client", () => {
  it("rejects a create response without a call id, and treats 404 on hang-up as done", async () => {
    const openai = createOpenAIRealtime({
      apiKey: "fake",
      baseUrl: "https://openai.test",
      fetch: (async (url: string) => (String(url).endsWith("/hangup") ? new Response(null, { status: 404 }) : new Response("v=0", { status: 201 }))) as typeof fetch,
    });
    await expect(openai.createCall("v=0", { model: "m" })).rejects.toBeInstanceOf(ProviderError);
    await expect(openai.hangup("rtc_gone")).resolves.toBeUndefined();
  });

  it("opens real WebSockets with the bearer header", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((resolve) => server.once("listening", resolve));
    const seen = new Promise<string | undefined>((resolve) => server.once("connection", (_socket, req) => resolve(req.headers.authorization)));
    const port = (server.address() as { port: number }).port;
    const socket = defaultSocketFactory(`ws://127.0.0.1:${port}/v1/realtime?model=m`, { Authorization: "Bearer fake" });
    expect(await seen).toBe("Bearer fake");
    await new Promise<void>((resolve) => socket.on("open", () => resolve()));
    socket.close();
    server.close();
  });
});

describe("settings and tickets at the edges", () => {
  const prices = readFileSync(new URL("../prices.json", import.meta.url), "utf8");
  const base = { OPENAI_API_KEY: "fake", GUARD_SIGNING_SECRET: SIGNING_SECRET, GUARD_API_KEY: API_KEY };
  const variable = (env: Record<string, string>) => {
    try {
      loadConfig({ ...base, ...env }, () => prices);
      return "none";
    } catch (error) {
      return (error as ConfigError).variable;
    }
  };

  it("names the variable for every kind of bad value", () => {
    expect(variable({ TRUST_PROXY: "true" })).toBe("TRUST_PROXY"); // renamed: fails with a pointer to TRUSTED_PROXIES
    expect(variable({ TRUSTED_PROXIES: "yes" })).toBe("TRUSTED_PROXIES");
    expect(variable({ MAX_INPUT_TOKENS: "500" })).toBe("MAX_INPUT_TOKENS");
    expect(variable({ SHUTDOWN_GRACE_SECONDS: "0" })).toBe("SHUTDOWN_GRACE_SECONDS");
    expect(variable({ SETTLE_WEBHOOK_URL: "https://hooks.example.com/x", SETTLE_WEBHOOK_SECRET: API_KEY })).toBe("SETTLE_WEBHOOK_SECRET");
    expect(variable({ ALLOWED_ORIGINS: "https://ok.example, https://bad.example/path" })).toBe("ALLOWED_ORIGINS");
    expect(variable({ ALLOWED_ORIGINS: "not a url" })).toBe("ALLOWED_ORIGINS");
    expect(variable({ REDIS_URL: "http://localhost:6379" })).toBe("REDIS_URL");
    expect(variable({ REDIS_PREFIX: "bad prefix" })).toBe("REDIS_PREFIX");
    expect(variable({ OPENAI_BASE_URL: "nope" })).toBe("OPENAI_BASE_URL");
    expect(variable({ PORT: "80.5" })).toBe("PORT");
    expect(variable({ SETTLE_WEBHOOK_URL: "https://hooks.example.com/x", SETTLE_WEBHOOK_SECRET: "short" })).toBe("SETTLE_WEBHOOK_SECRET");
    expect(variable({ TRUSTED_PROXIES: "1", ALLOWED_ORIGINS: "*, http://localhost:3000", REDIS_URL: "rediss://cache.example.com:6380" })).toBe("none");
  });

  it("parses booleans and keeps the webhook settings", () => {
    const config = loadConfig({ ...base, TRUSTED_PROXIES: "2", SETTLE_WEBHOOK_URL: "https://hooks.example.com/x/", SETTLE_WEBHOOK_SECRET: "w".repeat(40) }, () => prices);
    expect(config).toMatchObject({ trustedProxies: 2, settleWebhookUrl: "https://hooks.example.com/x", rateLimitPerMinute: 60, maxInputTokens: 4000, shutdownGraceSeconds: 25 });
  });

  it("rejects tickets whose signed payload is not a claims object", () => {
    const limits = { now: 0, maxTtlMs: 120_000, maxSeconds: 600, maxCostUsd: 1 };
    const forge = (payload: unknown) => {
      const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const hmac = createHmacSig(encoded);
      return `rvg1.${encoded}.${hmac}`;
    };
    expect(() => verifyTicket(forge(null), SIGNING_SECRET, limits)).toThrow(TicketError);
    const good = { id: "call_edge_0001", exp: 60_000, model: "m", maxSeconds: 60, maxCostUsd: 0.5 };
    expect(() => verifyTicket(forge({ ...good, session: [] }), SIGNING_SECRET, limits)).toThrow(TicketError);
    expect(() => verifyTicket(forge({ ...good, sid: "x".repeat(65) }), SIGNING_SECRET, limits)).toThrow(TicketError);
    expect(verifyTicket(forge(good), SIGNING_SECRET, limits).id).toBe("call_edge_0001");
  });
});

function createHmacSig(payload: string): string {
  return createHmac("sha256", SIGNING_SECRET).update(payload).digest("base64url");
}
