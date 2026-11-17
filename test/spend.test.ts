// "Observed + reserved spend": every response reserves its true worst case, the
// call ends while one more response would still fit, and a cap too small for
// that is refused before the call starts. The attack shapes here come from the
// independent re-check of 2bf6150 (probes P1 to P13).

import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_INSTRUCTIONS_BYTES, FRAMING_TOKENS, minimumCapUsd, responseLimits, worstResponseUsd } from "../src/budget.js";
import { buildSession } from "../src/call.js";
import { signTicket } from "../src/ticket.js";
import { API_KEY, MODEL, PRICES, SIGNING_SECRET, startGuard, waitFor } from "./helpers.js";

type Harness = Awaited<ReturnType<typeof startGuard>>;
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const BIG = "gpt-realtime-2.1"; // $32 audio in, $4 text in, $64 audio out per 1M tokens

const settled = (harness: Harness, id: string) => waitFor(async () => {
  const record = await harness.ledger.get(id);
  return record?.settledAt !== undefined ? record : undefined;
});

/** Usage with `audioIn` uncached audio tokens and `textIn` text tokens read, and `audioOut` audio tokens written. */
const usage = (audioIn: number, textIn: number, audioOut: number) => ({
  input_tokens: audioIn + textIn,
  output_tokens: audioOut,
  input_token_details: { text_tokens: textIn, audio_tokens: audioIn, cached_tokens_details: { text_tokens: 0, audio_tokens: 0 } },
  output_token_details: { text_tokens: 0, audio_tokens: audioOut },
});

async function connect(harness: Harness, body: Record<string, unknown> = {}) {
  const ticket = await harness.mint(body);
  expect((await harness.offer(ticket.value)).status).toBe(201);
  const call = harness.guard.context.active.get(ticket.call_id);
  if (!call) throw new Error("no call");
  return { id: ticket.call_id, sideband: harness.openai.lastSocket(), worst: call.worstResponseUsd, limits: responseLimits(call.session) };
}

const cancels = (sent: Array<Record<string, unknown>>) => sent.filter((event) => event.type === "response.cancel").map((event) => event.response_id);
const pause = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the worst case one response can cost", () => {
  it("is the input limit at the dearest input rate, the instructions at the text rate, and the output cap at the dearest output rate", () => {
    const tools = [{ type: "function", name: "lookup", parameters: { type: "object" } }];
    const limits = responseLimits(buildSession({ instructions: "Be brief.", tools }, BIG, 1024, 4000));
    const toolBytes = JSON.stringify([{ name: "lookup", parameters: { type: "object" }, type: "function" }]).length;
    expect(limits).toEqual({ conversationTokens: 4000, instructionTokens: 9 + toolBytes + FRAMING_TOKENS, outputTokens: 1024 });
    expect(worstResponseUsd(PRICES, BIG, limits)).toBeCloseTo((4000 * 32 + limits.instructionTokens * 4 + 1024 * 64) / 1e6, 12);
    // No instructions: room is kept for OpenAI's defaults.
    expect(responseLimits(buildSession(undefined, BIG, 1024, 4000)).instructionTokens).toBe(DEFAULT_INSTRUCTIONS_BYTES + FRAMING_TOKENS);
    expect(worstResponseUsd(PRICES, "gpt-unknown", limits)).toBeUndefined();
  });
});

describe("caps too small for the bound are refused before a call starts", () => {
  it("at mint, naming the variables and the minimum (P1, P13)", async () => {
    h = await startGuard({ config: { maxInputTokens: 16000, maxCallCostUsd: 5 } });
    // P1's call: $0.10 on gpt-realtime-2.1 with a 16,000-token input limit, where one response can cost about $0.58.
    const refused = await h.mint({ session: { model: BIG }, max_cost_usd: 0.1 });
    expect(refused.status).toBe(400);
    expect(refused.error?.code).toBe("invalid_max_cost_usd");
    const message = (refused.error as { message?: string } | undefined)?.message ?? "";
    expect(message).toContain("MAX_INPUT_TOKENS");
    expect(message).toContain("MAX_OUTPUT_TOKENS");
    expect(message).toMatch(/at least \$1\.16\d\d for gpt-realtime-2\.1/);
    expect(h.openai.requests).toHaveLength(0);
  });

  it("for self-signed tickets, at the offer, before OpenAI is called", async () => {
    h = await startGuard();
    const ticket = signTicket({ id: "call_small_cap1", exp: Date.now() + 60_000, model: MODEL, maxSeconds: 60, maxCostUsd: 0.05, session: {} }, SIGNING_SECRET);
    const response = await h.offer(ticket);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("invalid_max_cost_usd");
    expect(h.openai.requests).toHaveLength(0);
  });

  it("refuses a stored prompt or MCP tools, whose size it can't count", async () => {
    h = await startGuard();
    expect((await h.mint({ session: { model: MODEL, prompt: { id: "pmpt_123" } } })).error?.code).toBe("prompt_not_supported");
    const mcp = { type: "mcp", server_label: "crm", server_url: "https://mcp.example.com/sse" };
    expect((await h.mint({ session: { model: MODEL, tools: [{ type: "function", name: "lookup" }, mcp] } })).error?.code).toBe("mcp_not_supported");
    expect((await h.mint({ session: { model: MODEL, tools: [{ type: "function", name: "lookup" }] } })).status).toBe(201);
  });

  it("for a self-signed ticket that claims a stored session with a smaller cap, after the claim", async () => {
    h = await startGuard();
    // The session was minted with room for two worst cases; a ticket signed elsewhere claims it with $0.05.
    expect((await h.mint({ max_cost_usd: 0.5, call_id: "call_stored_low1" })).status).toBe(201);
    const forged = signTicket({ id: "call_stored_low1", exp: Date.now() + 60_000, model: MODEL, maxSeconds: 60, maxCostUsd: 0.05, stored: true }, SIGNING_SECRET);
    const response = await h.offer(forged);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("invalid_max_cost_usd");
    expect(h.openai.creates()).toHaveLength(0);
    expect(await settled(h, "call_stored_low1")).toMatchObject({ endReason: "not_connected" });
  });
});

describe("observed + reserved spend stays under the cap", () => {
  it("when every response costs its full worst case (P2)", async () => {
    h = await startGuard({ config: { maxInputTokens: 16000, maxCallCostUsd: 5 } });
    const { id, sideband, worst, limits } = await connect(h, { session: { model: BIG }, max_cost_usd: 2.5 });
    let n = 0;
    while ((await h.ledger.get(id))?.settledAt === undefined && n < 20) {
      n += 1;
      sideband.server({ type: "response.created", response: { id: `resp_${n}`, max_output_tokens: 1024 } });
      sideband.server({ type: "response.done", response: { id: `resp_${n}`, usage: usage(limits.conversationTokens, limits.instructionTokens, limits.outputTokens) } });
      await pause(10);
    }
    const record = await settled(h, id);
    expect(record.endReason).toBe("max_cost");
    expect(record.costUsd).toBeCloseTo(n * worst, 9);
    expect(record.costUsd).toBeLessThanOrEqual(2.5);
    // Every response ran to the end while two more worst cases fitted; the call ended right after the last one.
    expect(n).toBe(Math.floor(2.5 / worst) - 1);
    expect(record.costUsd + 2 * worst).toBeGreaterThan(2.5);
  });

  it("when the first response reads the whole input limit (P1)", async () => {
    h = await startGuard({ config: { maxInputTokens: 16000, maxCallCostUsd: 5 } });
    const { id, sideband, worst, limits } = await connect(h, { session: { model: BIG }, max_cost_usd: 1.2 });
    expect(minimumCapUsd(worst)).toBeLessThanOrEqual(1.2);
    sideband.server({ type: "response.created", response: { id: "resp_1", max_output_tokens: 1024 } });
    await pause();
    expect((await h.ledger.get(id))?.settledAt).toBeUndefined(); // it runs: two worst cases fit in $1.20
    sideband.server({ type: "response.done", response: { id: "resp_1", usage: usage(limits.conversationTokens, 0, limits.outputTokens) } });
    const record = await settled(h, id); // no room left for two more, so the call ends after its one response
    expect(record.endReason).toBe("max_cost");
    expect(record.costUsd).toBeCloseTo((16000 * 32 + 1024 * 64) / 1e6, 9);
    expect(record.costUsd).toBeLessThanOrEqual(1.2);
  });

  it("when a response reports no usage: it is charged its full reservation (P3)", async () => {
    h = await startGuard();
    const { id, sideband, worst } = await connect(h, { max_cost_usd: 0.1 });
    let n = 0;
    while ((await h.ledger.get(id))?.settledAt === undefined && n < 20) {
      n += 1;
      sideband.server({ type: "response.created", response: { id: `resp_${n}`, max_output_tokens: 1024 } });
      sideband.server({ type: "response.done", response: { id: `resp_${n}`, status: "completed", usage: null } });
      await pause(10);
    }
    const record = await settled(h, id);
    expect(record).toMatchObject({ endReason: "max_cost", monitoringComplete: false });
    expect(record.costUsd).toBeCloseTo(n * worst, 9);
    expect(record.costUsd).toBeLessThanOrEqual(0.1);
    expect(h.lines.some((line) => line.message === "call.usage_missing")).toBe(true);
  });

  it("with transcription, checked as each one is reported", async () => {
    h = await startGuard();
    const { id, sideband, worst } = await connect(h, { session: { model: MODEL, audio: { input: { transcription: { model: "gpt-realtime-whisper" } } } }, max_cost_usd: 0.1 });
    // $0.017 a minute: two minutes of speech ($0.034) still leaves room for two worst-case responses.
    sideband.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_1", usage: { type: "duration", seconds: 120 } });
    await pause();
    expect((await h.ledger.get(id))?.settledAt).toBeUndefined();
    expect(0.034 + 2 * worst).toBeLessThanOrEqual(0.1);
    sideband.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_2", usage: { type: "duration", seconds: 30 } });
    const record = await settled(h, id);
    expect(record.endReason).toBe("max_cost");
    expect(record.costUsd).toBeCloseTo(0.0425, 9);
  });
});

describe("concurrent responses (P2b)", () => {
  it("are cancelled as they start; the overshoot is what responses starting after the hang-up decision are charged", async () => {
    h = await startGuard();
    const { id, sideband, worst, limits } = await connect(h, { max_cost_usd: 0.1 });
    for (let i = 1; i <= 10; i++) sideband.server({ type: "response.created", response: { id: `resp_${i}`, max_output_tokens: 1024 } });
    // Only resp_1 runs; every other response is cancelled the moment it starts.
    expect(cancels(sideband.sent)).toEqual(["resp_2", "resp_3", "resp_4", "resp_5", "resp_6", "resp_7", "resp_8", "resp_9", "resp_10"]);
    // Each cancelled one reports its input. Whether OpenAI bills that is not verified; the guard counts it.
    sideband.server({ type: "response.done", response: { id: "resp_1", usage: usage(limits.conversationTokens, limits.instructionTokens, limits.outputTokens) } });
    for (let i = 2; i <= 10; i++) sideband.server({ type: "response.done", response: { id: `resp_${i}`, status: "cancelled", usage: usage(limits.conversationTokens, limits.instructionTokens, 5) } });
    const record = await settled(h, id);
    expect(record.endReason).toBe("max_cost");
    expect(h.openai.hangups()).toHaveLength(1);
    const inputUsd = (limits.conversationTokens * 10 + limits.instructionTokens * 0.6 + 5 * 20) / 1e6;
    expect(record.costUsd).toBeCloseTo(worst + 9 * inputUsd, 9);
    // resp_1 to resp_3 started while the call was live and fit under the cap (resp_3 used the room kept for one more).
    expect(worst + 2 * inputUsd).toBeLessThanOrEqual(0.1);
    // resp_4 to resp_10 started after the guard decided to hang up: the documented WebRTC bound adds what they were charged.
    expect(record.costUsd).toBeLessThanOrEqual(0.1 + 7 * inputUsd);
  });
});

describe("responses the guard can't see finish", () => {
  it("a response.done that never comes ends the call as monitor_lost after the response timeout (P9)", async () => {
    h = await startGuard({ responseTimeoutMs: 100 });
    const { id, sideband, worst } = await connect(h);
    sideband.server({ type: "response.created", response: { id: "resp_lost", max_output_tokens: 1024 } });
    const record = await settled(h, id);
    expect(record).toMatchObject({ endReason: "monitor_lost", monitoringComplete: false });
    expect(record.costUsd).toBeCloseTo(worst, 9); // charged its reservation
    expect(h.lines.some((line) => line.message === "call.response_lost")).toBe(true);
  });

  it("a response still running when the call ends is charged its reservation, and the record says so (P4)", async () => {
    h = await startGuard();
    const { id, sideband, worst } = await connect(h);
    sideband.server({ type: "response.created", response: { id: "resp_running", max_output_tokens: 1024 } });
    await fetch(`${h.url}/v1/admin/calls/${id}/stop`, { method: "POST", headers: { Authorization: `Bearer ${API_KEY}` } });
    const record = await settled(h, id);
    expect(record).toMatchObject({ endReason: "stopped", monitoringComplete: false });
    expect(record.costUsd).toBeCloseTo(worst, 9);
  });

  it("a response with no id ends the call", async () => {
    h = await startGuard();
    const { id, sideband } = await connect(h);
    sideband.server({ type: "response.created", response: { max_output_tokens: 1024 } });
    expect((await settled(h, id)).endReason).toBe("monitor_lost");
  });
});

describe("policy", () => {
  it("a response that raises its output cap is reserved and cancelled, and ends the call (P5)", async () => {
    h = await startGuard({ openai: { hangup: Array(300).fill(500) } });
    const { sideband } = await connect(h);
    sideband.server({ type: "response.created", response: { id: "resp_big", max_output_tokens: "inf" } });
    expect(cancels(sideband.sent)).toContain("resp_big");
    sideband.server({ type: "response.created", response: { id: "resp_next", max_output_tokens: 1024 } });
    expect(cancels(sideband.sent)).toContain("resp_next");
  });

  it("a response with its own instructions is reserved with them, cancelled, and ends the call (A1)", async () => {
    h = await startGuard({ openai: { hangup: Array(300).fill(500) } });
    const { id, sideband } = await connect(h, { session: { model: MODEL, instructions: "Be brief." } });
    // OpenAI reporting the session's own instructions on a response is fine.
    sideband.server({ type: "response.created", response: { id: "resp_echo", max_output_tokens: 1024, instructions: "Be brief." } });
    sideband.server({ type: "response.done", response: { id: "resp_echo", usage: usage(10, 10, 10) } });
    await pause();
    expect((await h.ledger.get(id))?.settledAt).toBeUndefined();
    const call = h.guard.context.active.get(id);
    sideband.server({ type: "response.created", response: { id: "resp_own", conversation_id: "conv_1", max_output_tokens: 1024, instructions: "x".repeat(60_000) } });
    expect(cancels(sideband.sent)).toContain("resp_own");
    expect(h.lines.find((line) => line.message === "call.policy")?.fields?.event).toBe("response.created:instructions");
    expect(call?.ended).toBe(true);
  });

  it("in WebRTC mode, a response whose cap the event doesn't show is reserved at OpenAI's 4,096 tokens (A2)", async () => {
    h = await startGuard();
    const { id, sideband, worst, limits } = await connect(h, { max_cost_usd: 1 });
    sideband.server({ type: "response.created", response: { id: "resp_capless" } });
    await fetch(`${h.url}/v1/admin/calls/${id}/stop`, { method: "POST", headers: { Authorization: `Bearer ${API_KEY}` } });
    const record = await settled(h, id);
    const at4096 = (limits.conversationTokens * 10 + limits.instructionTokens * 0.6 + 4096 * 20) / 1e6;
    expect(record.costUsd).toBeCloseTo(at4096, 9); // charged the reservation it never reported against
    expect(at4096).toBeGreaterThan(worst);

    // At a $0.10 cap, that reservation plus one more response doesn't fit: the call ends at once.
    const small = await connect(h, { max_cost_usd: 0.1 });
    small.sideband.server({ type: "response.created", response: { id: "resp_capless" } });
    expect((await settled(h, small.id)).endReason).toBe("max_cost");
    expect(cancels(small.sideband.sent)).toContain("resp_capless");
  });

  it("forces a truncation limit on every session and hangs up if the client lifts it", async () => {
    h = await startGuard({ config: { maxInputTokens: 8000 } });
    const { id, sideband } = await connect(h, { session: { model: MODEL, truncation: { type: "retention_ratio", retention_ratio: 0.5, token_limits: { post_instructions: 50_000 } } } });
    expect(h.openai.sessions[0]?.truncation).toEqual({ type: "retention_ratio", retention_ratio: 0.5, token_limits: { post_instructions: 8000 } });
    sideband.server({ type: "session.updated", session: { model: MODEL, max_output_tokens: 1024, truncation: { type: "retention_ratio", retention_ratio: 0.5, token_limits: { post_instructions: 8000 } } } });
    await pause();
    expect((await h.ledger.get(id))?.settledAt).toBeUndefined();
    sideband.server({ type: "session.updated", session: { model: MODEL, max_output_tokens: 1024, truncation: "auto" } });
    expect((await settled(h, id)).endReason).toBe("policy");
  });

  it.each([
    ["new instructions", { instructions: "z ".repeat(60_000) }],
    ["an added tool", { instructions: "Be brief.", tools: [{ type: "function", name: "f" }] }],
    ["a stored prompt", { instructions: "Be brief.", prompt: { id: "pmpt_123" } }],
  ])("a browser session.update with %s ends the call (P11)", async (_label, change) => {
    h = await startGuard();
    const { id, sideband } = await connect(h, { session: { model: MODEL, instructions: "Be brief." } });
    sideband.server({ type: "session.updated", session: { model: MODEL, max_output_tokens: 1024, instructions: "Be brief.", tools: [] } }); // an echo: fine
    await pause();
    expect((await h.ledger.get(id))?.settledAt).toBeUndefined();
    sideband.server({ type: "session.updated", session: { model: MODEL, max_output_tokens: 1024, ...change } });
    expect((await settled(h, id)).endReason).toBe("policy");
  });

  it("without instructions of its own, a session accepts OpenAI's short defaults once, then polices them", async () => {
    h = await startGuard();
    const { id, sideband } = await connect(h);
    sideband.server({ type: "session.updated", session: { model: MODEL, instructions: "You are a helpful assistant." } });
    sideband.server({ type: "session.updated", session: { model: MODEL, instructions: "You are a helpful assistant." } });
    await pause();
    expect((await h.ledger.get(id))?.settledAt).toBeUndefined();
    sideband.server({ type: "session.updated", session: { model: MODEL, instructions: "Something else." } });
    expect((await settled(h, id)).endReason).toBe("policy");
  });
});

describe("a call that is ending stops spending at once (P6)", () => {
  it("turns off automatic turns and transcription and cancels responses before the hang-up is confirmed", async () => {
    h = await startGuard({ openai: { hangup: Array(300).fill("hang") } });
    const { id, sideband } = await connect(h);
    sideband.server({ type: "response.created", response: { id: "resp_running", max_output_tokens: 1024 } });
    const started = Date.now();
    await fetch(`${h.url}/v1/admin/calls/${id}/stop`, { method: "POST", headers: { Authorization: `Bearer ${API_KEY}` } });
    await waitFor(() => sideband.sent.some((event) => event.type === "session.update"));
    expect(Date.now() - started).toBeLessThan(500);
    expect(sideband.sent.find((event) => event.type === "session.update")).toEqual({
      type: "session.update",
      session: { type: "realtime", audio: { input: { turn_detection: null, transcription: null } } },
    });
    expect(cancels(sideband.sent)).toContain("resp_running");
    sideband.server({ type: "response.created", response: { id: "resp_new", max_output_tokens: 1024 } });
    expect(cancels(sideband.sent)).toContain("resp_new");
    expect((await h.ledger.get(id))?.settledAt).toBeUndefined(); // still unsettled while the hang-up is unconfirmed
    h.guard.context.config.shutdownGraceSeconds = 1;
  });
});
