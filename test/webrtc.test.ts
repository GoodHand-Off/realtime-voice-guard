// WebRTC path end to end against a mocked OpenAI: tickets, caps, policy,
// hang-up and settlement.

import { afterEach, describe, expect, it } from "vitest";
import { Secret } from "../src/secret.js";
import { signTicket } from "../src/ticket.js";
import { verifyWebhookSignature } from "../src/webhook.js";
import { API_KEY, MODEL, SIGNING_SECRET, WEBHOOK_SECRET, startGuard, waitFor } from "./helpers.js";

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

/** Usage that costs `usd` on gpt-realtime-2.1-mini (output audio at $20 per 1M tokens). */
const usageCosting = (usd: number) => {
  const audio = Math.round((usd * 1e6) / 20);
  return { input_tokens: 0, output_tokens: audio, input_token_details: { text_tokens: 0, audio_tokens: 0, image_tokens: 0, cached_tokens: 0, cached_tokens_details: {} }, output_token_details: { text_tokens: 0, audio_tokens: audio } };
};

async function connect(harness: Harness, body: Record<string, unknown> = {}) {
  const ticket = await harness.mint(body);
  const response = await harness.offer(ticket.value);
  return { ticket, response, sideband: harness.openai.lastSocket() };
}

describe("tickets endpoint", () => {
  it("needs the API key", async () => {
    h = await startGuard();
    const response = await fetch(`${h.url}/v1/tickets`, { method: "POST", body: JSON.stringify({ session: { model: MODEL } }) });
    expect(response.status).toBe(401);
  });

  it("rejects unpriced models, out-of-range caps and reused call ids", async () => {
    h = await startGuard({ config: { maxCallSeconds: 300, maxCallCostUsd: 0.5 } });
    expect((await h.mint({ session: { model: "gpt-unknown" } })).error?.code).toBe("model_not_priced");
    expect((await h.mint({ session: { model: MODEL, audio: { input: { transcription: { model: "mystery-asr" } } } } })).error?.code).toBe("transcription_not_priced");
    expect((await h.mint({ max_seconds: 301 })).error?.code).toBe("invalid_max_seconds");
    expect((await h.mint({ max_cost_usd: 0.51 })).error?.code).toBe("invalid_max_cost_usd");
    expect((await h.mint({ call_id: "my_call_0001" })).status).toBe(201);
    expect((await h.mint({ call_id: "my_call_0001" })).error?.code).toBe("call_id_used");
  });
});

describe("WebRTC calls", () => {
  it("never reaches OpenAI without a valid ticket", async () => {
    h = await startGuard();
    expect((await h.offer("not-a-ticket")).status).toBe(401);
    const expired = signTicket({ id: "call_expired_1", exp: Date.now() - 1, model: MODEL, maxSeconds: 60, maxCostUsd: 0.1 }, SIGNING_SECRET);
    expect((await h.offer(expired)).status).toBe(401);
    const tooLong = signTicket({ id: "call_toolong_1", exp: Date.now() + 60_000, model: MODEL, maxSeconds: 3600, maxCostUsd: 0.1 }, SIGNING_SECRET);
    expect((await h.offer(tooLong)).status).toBe(401);
    expect(h.openai.requests).toHaveLength(0);
  });

  it("forces the model and output cap, returns the answer only after the monitor attaches, and allows one use per ticket", async () => {
    h = await startGuard();
    const { ticket, response, sideband } = await connect(h, { session: { model: MODEL, instructions: "Be brief.", max_output_tokens: 4096 } });
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("v=0 fake-answer");
    expect(response.headers.get("location")).toBe(`/v1/realtime/calls/${ticket.call_id}`);
    expect(h.openai.sessions[0]).toEqual({ type: "realtime", model: MODEL, instructions: "Be brief.", max_output_tokens: 1024, truncation: { type: "retention_ratio", retention_ratio: 0.8, token_limits: { post_instructions: 1000 } } });
    expect(sideband.url).toBe("wss://openai.test/v1/realtime?call_id=rtc_test123");
    expect(h.openai.socketAuth.at(-1)).toBe("Bearer fake");
    expect((await h.offer(ticket.value)).status).toBe(409);
    expect(h.openai.creates()).toHaveLength(1);
  });

  it("accepts a ticket the backend signed itself, with an inline session", async () => {
    h = await startGuard();
    const ticket = signTicket({ id: "call_selfsigned", exp: Date.now() + 60_000, model: MODEL, maxSeconds: 60, maxCostUsd: 0.1, sid: "user-hash", session: { voice: "marin" } }, SIGNING_SECRET);
    const response = await h.offer(ticket);
    expect(response.status).toBe(201);
    expect(h.openai.sessions[0]).toMatchObject({ voice: "marin", model: MODEL });
    expect(h.openai.creates()[0]?.headers.get("openai-safety-identifier")).toBe("user-hash");
  });

  it("hangs up once spend leaves no room for one more worst-case response", async () => {
    h = await startGuard();
    // One response can cost about $0.031 here, so with nothing running the call ends once more than about $0.0375 is spent.
    const { ticket, sideband } = await connect(h, { max_cost_usd: 0.1 });
    sideband.server({ type: "response.done", response: { id: "resp_1", usage: usageCosting(0.02) } });
    sideband.server({ type: "response.done", response: { id: "resp_1", usage: usageCosting(0.02) } }); // duplicate
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.openai.hangups()).toHaveLength(0);
    sideband.server({ type: "response.done", response: { id: "resp_2", usage: usageCosting(0.05) } });
    const record = await settled(h, ticket.call_id);
    expect(record).toMatchObject({ endReason: "max_cost", usageEvents: 2, monitoringComplete: true });
    expect(record.costUsd).toBeCloseTo(0.07, 10);
    expect(h.openai.hangups()).toEqual(["https://openai.test/v1/realtime/calls/rtc_test123/hangup"]);
  });

  it("hangs up at the duration cap", async () => {
    h = await startGuard();
    const started = Date.now();
    const { ticket } = await connect(h, { max_seconds: 1 });
    const record = await settled(h, ticket.call_id);
    expect(record.endReason).toBe("max_duration");
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(h.openai.hangups()).toHaveLength(1);
  });

  it("hangs up after the response cap", async () => {
    h = await startGuard({ config: { maxResponsesPerCall: 2 } });
    const { ticket, sideband } = await connect(h);
    sideband.server({ type: "response.done", response: { id: "resp_1", usage: usageCosting(0.001) } });
    sideband.server({ type: "response.done", response: { id: "resp_2", usage: usageCosting(0.001) } });
    expect((await settled(h, ticket.call_id)).endReason).toBe("max_responses");
  });

  it("meters transcription and stops on usage it cannot price", async () => {
    h = await startGuard();
    const { ticket, sideband } = await connect(h, { session: { model: MODEL, audio: { input: { transcription: { model: "gpt-4o-mini-transcribe" } } } } });
    sideband.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_1", content_index: 0, usage: { type: "tokens", input_tokens: 13, output_tokens: 9, total_tokens: 22 } });
    await waitFor(async () => (await h?.ledger.get(ticket.call_id))?.usageEvents === 1);
    // The browser switches transcription to a model with no price entry.
    sideband.server({ type: "session.updated", session: { model: MODEL, max_output_tokens: 1024, audio: { input: { transcription: { model: "mystery-asr" } } } } });
    sideband.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_2", usage: { type: "duration", seconds: 3 } });
    const record = await settled(h, ticket.call_id);
    expect(record).toMatchObject({ endReason: "unpriced_usage", monitoringComplete: false });
    expect(record.costUsd).toBeCloseTo((13 * 1.25 + 9 * 5) / 1e6, 12);
  });

  it.each([
    ["a different model", { model: "gpt-realtime-2.1", max_output_tokens: 1024 }],
    ["an unlimited output cap", { model: MODEL, max_output_tokens: "inf" }],
    ["a higher output cap", { model: MODEL, max_output_tokens: 4096 }],
  ])("hangs up when the client switches to %s", async (_label, session) => {
    h = await startGuard();
    const { ticket, sideband } = await connect(h);
    sideband.server({ type: "session.updated", session });
    expect((await settled(h, ticket.call_id)).endReason).toBe("policy");
    expect(h.openai.hangups()).toHaveLength(1);
  });

  it("settles cleanly when the call ends on its own", async () => {
    h = await startGuard();
    const { ticket, sideband } = await connect(h);
    sideband.server({ type: "response.done", response: { id: "resp_1", usage: usageCosting(0.001) } });
    sideband.close();
    expect(await settled(h, ticket.call_id)).toMatchObject({ endReason: "ended", monitoringComplete: true });
    expect(h.openai.hangups()).toHaveLength(1); // always confirmed, even if OpenAI already ended it
  });

  it("never returns an answer when the monitor cannot attach, and hangs up", async () => {
    h = await startGuard({ openai: { sideband: "error" } });
    const ticket = await h.mint();
    const response = await h.offer(ticket.value);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("fake-answer");
    expect(h.openai.hangups()).toHaveLength(1);
    expect(await settled(h, ticket.call_id)).toMatchObject({ endReason: "monitor_lost", monitoringComplete: false });
  });

  it("reports an OpenAI rejection without leaking provider details", async () => {
    h = await startGuard({ openai: { createStatus: 401 } });
    const ticket = await h.mint();
    const response = await h.offer(ticket.value);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { code: "provider_rejected", message: "OpenAI did not accept the call" } });
    expect(h.openai.hangups()).toHaveLength(0);
    expect((await settled(h, ticket.call_id)).endReason).toBe("provider_error");
  });

  it("retries the hang-up, and flags the call when it cannot be confirmed", async () => {
    h = await startGuard({ openai: { hangup: ["throw", 500, 200] } });
    const first = await connect(h, { max_seconds: 1 });
    expect((await settled(h, first.ticket.call_id)).monitoringComplete).toBe(true);
    expect(h.openai.hangups()).toHaveLength(3);
    await h.close();

    // Three failures, then success on the next round: the call settles only once OpenAI confirms.
    h = await startGuard({ openai: { hangup: [500, 500, 500] } });
    const second = await connect(h, { max_seconds: 1 });
    expect(await settled(h, second.ticket.call_id)).toMatchObject({ endReason: "max_duration", monitoringComplete: true });
    expect(h.openai.hangups()).toHaveLength(4);
    expect(h.lines.find((line) => line.message === "call.hangup_unconfirmed")?.fields?.error).toBe("ProviderError: Hang-up not confirmed after 3 attempts");
  });

  it("never settles a call whose hang-up OpenAI has not confirmed, until it cannot still be running", async () => {
    let offset = 0;
    h = await startGuard({ openai: { hangup: Array(60).fill(500) }, now: () => Date.now() + offset });
    const { ticket, sideband } = await connect(h, { max_seconds: 1 });
    await waitFor(() => h?.lines.some((line) => line.message === "call.hangup_unconfirmed"));
    // Still metering while it retries.
    sideband.server({ type: "response.done", response: { id: "resp_late", usage: usageCosting(0.001) } });
    await waitFor(async () => (await h?.ledger.get(ticket.call_id))?.usageEvents === 1);
    expect((await h.ledger.get(ticket.call_id))?.settledAt).toBeUndefined();
    expect(h.guard.context.active.has(ticket.call_id)).toBe(true);
    offset = 62 * 60_000;
    expect(await settled(h, ticket.call_id)).toMatchObject({ endReason: "max_duration", monitoringComplete: false });
  });

  it("stops a call from the admin API and from a stop request seen by the heartbeat", async () => {
    h = await startGuard({ config: { heartbeatSeconds: 1 } });
    const a = await connect(h);
    const stop = await fetch(`${h.url}/v1/admin/calls/${a.ticket.call_id}/stop`, { method: "POST", headers: { Authorization: `Bearer ${API_KEY}` } });
    expect(stop.status).toBe(202);
    expect((await settled(h, a.ticket.call_id)).endReason).toBe("stopped");

    const b = await connect(h);
    await h.ledger.requestStop(b.ticket.call_id); // as another instance would
    expect((await settled(h, b.ticket.call_id)).endReason).toBe("stopped");
    expect(h.openai.hangups()).toHaveLength(2);

    const read = await fetch(`${h.url}/v1/admin/calls/${b.ticket.call_id}`, { headers: { Authorization: `Bearer ${API_KEY}` } });
    expect(((await read.json()) as { call: { endReason: string } }).call.endReason).toBe("stopped");
    expect((await fetch(`${h.url}/v1/admin/calls/${b.ticket.call_id}`)).status).toBe(401);
  });

  it("refuses calls beyond the concurrency cap", async () => {
    h = await startGuard({ config: { maxConcurrentCalls: 1 } });
    expect((await connect(h)).response.status).toBe(201);
    const second = await h.offer((await h.mint()).value);
    expect(second.status).toBe(503);
    expect(second.headers.get("retry-after")).toBe("5");
  });

  it("answers CORS preflights only for allowed origins", async () => {
    h = await startGuard();
    const allowed = await fetch(`${h.url}/v1/realtime/calls`, { method: "OPTIONS", headers: { Origin: "http://app.test" } });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://app.test");
    const denied = await fetch(`${h.url}/v1/realtime/calls`, { method: "OPTIONS", headers: { Origin: "http://evil.test" } });
    expect(denied.status).toBe(403);
    const ticket = await h.mint();
    const response = await h.offer(ticket.value, { Origin: "http://app.test" });
    expect(response.headers.get("access-control-expose-headers")).toBe("Location");
  });

  it("hangs up live calls on shutdown and posts a signed settlement webhook", async () => {
    const webhookUrl = "https://backend.test/hooks/voice";
    h = await startGuard({ config: { settleWebhookUrl: webhookUrl, settleWebhookSecret: new Secret(WEBHOOK_SECRET) }, openai: { webhookUrl } });
    const { ticket } = await connect(h);
    const { openai } = h;
    await h.close();
    h = undefined;
    expect(openai.hangups()).toHaveLength(1);
    const hook = openai.webhooks[0];
    expect(hook).toBeDefined();
    const body = JSON.parse(hook?.body ?? "{}") as { type: string; call: { id: string; endReason: string } };
    expect(body).toMatchObject({ type: "call.settled", call: { id: ticket.call_id, endReason: "shutdown" } });
    const timestamp = hook?.headers.get("x-guard-timestamp") ?? "";
    const signature = hook?.headers.get("x-guard-signature") ?? "";
    expect(verifyWebhookSignature(hook?.body ?? "", timestamp, signature, WEBHOOK_SECRET)).toBe(true);
    expect(verifyWebhookSignature(`${hook?.body ?? ""} `, timestamp, signature, WEBHOOK_SECRET)).toBe(false);
  });

  it("reports health without secrets", async () => {
    h = await startGuard();
    const health = (await (await fetch(`${h.url}/health`)).json()) as Record<string, unknown>;
    expect(health).toEqual({ status: "ok", activeCalls: 0, ledger: "memory", pricesChecked: "2026-11-17" });
  });
});
