// WebSocket relay against a mocked OpenAI upstream.

import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { API_KEY, MODEL, startGuard, waitFor } from "./helpers.js";

type Harness = Awaited<ReturnType<typeof startGuard>>;
let h: Harness | undefined;
const clients: WebSocket[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) if (client.readyState === WebSocket.OPEN) client.terminate();
  await h?.close();
  h = undefined;
});

async function open(harness: Harness, body: Record<string, unknown> = {}) {
  const ticket = await harness.mint(body);
  const client = new WebSocket(`${harness.url.replace("http", "ws")}/v1/realtime`, { headers: { Authorization: `Bearer ${ticket.value}` } });
  clients.push(client);
  const received: Array<Record<string, unknown>> = [];
  client.on("message", (data) => received.push(JSON.parse(String(data)) as Record<string, unknown>));
  await new Promise<void>((resolve, reject) => {
    client.once("open", () => resolve());
    client.once("error", reject);
  });
  const upstream = harness.openai.lastSocket();
  await waitFor(() => received.some((event) => event.type === "session.updated"));
  await waitFor(async () => (await harness.ledger.get(ticket.call_id))?.boundAt !== undefined);
  return { ticket, client, upstream, received };
}

const settled = (harness: Harness, id: string) => waitFor(async () => {
  const record = await harness.ledger.get(id);
  return record?.settledAt !== undefined ? record : undefined;
});

describe("WebSocket relay", () => {
  it("configures the session from the ticket, not from the client", async () => {
    h = await startGuard();
    const { upstream, ticket } = await open(h, { session: { model: MODEL, instructions: "Stay in character." } });
    expect(upstream.url).toBe(`wss://openai.test/v1/realtime?model=${MODEL}`);
    expect(upstream.sent[0]).toEqual({ type: "session.update", session: { type: "realtime", instructions: "Stay in character.", max_output_tokens: 1024, truncation: { type: "retention_ratio", retention_ratio: 0.8, token_limits: { post_instructions: 1000 } } } });
    expect((await h.ledger.get(ticket.call_id))?.providerCallId).toBe(`ws:${ticket.call_id}`);
  });

  it("forwards allowed events, clamps the output cap, and runs one response at a time", async () => {
    h = await startGuard();
    const { client, upstream, received } = await open(h);
    client.send(JSON.stringify({ type: "input_audio_buffer.append", audio: "AAAA" }));
    client.send(JSON.stringify({ type: "response.create", response: { max_output_tokens: 4096 } }));
    client.send(JSON.stringify({ type: "response.create" })); // refused: one is already on its way
    await waitFor(() => received.some((event) => event.type === "error"));
    expect(upstream.sent.slice(1)).toEqual([
      { type: "input_audio_buffer.append", audio: "AAAA" },
      { type: "response.create", event_id: expect.stringMatching(/^rvg_/), response: { max_output_tokens: 1024 } },
    ]);
    expect(received.find((event) => event.type === "error")).toMatchObject({ error: { code: "response_in_progress" } });
    // Once OpenAI has started and finished that response, the next one goes through.
    upstream.server({ type: "response.created", response: { id: "resp_1", max_output_tokens: 1024 } });
    client.send(JSON.stringify({ type: "response.create" }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(upstream.sent).toHaveLength(3); // still refused while resp_1 runs
    upstream.server({ type: "response.done", response: { id: "resp_1", usage: { input_tokens: 0, output_tokens: 0, input_token_details: {}, output_token_details: {} } } });
    client.send(JSON.stringify({ type: "response.create" }));
    await waitFor(() => upstream.sent.length >= 4);
    expect(upstream.sent[3]).toMatchObject({ type: "response.create", response: { max_output_tokens: 1024 } });
  });

  it("runs one response at a time even when the client fires ten at once (P2b, relay)", async () => {
    h = await startGuard();
    const { client, upstream, received } = await open(h);
    for (let i = 0; i < 10; i++) client.send(JSON.stringify({ type: "response.create" }));
    await waitFor(() => received.filter((event) => event.type === "error").length === 9);
    expect(upstream.sent.filter((event) => event.type === "response.create")).toHaveLength(1);
  });

  it("refuses response.create with its own input, instructions, tools or conversation (P7)", async () => {
    h = await startGuard();
    const { client, upstream, received, ticket } = await open(h);
    const big = "word ".repeat(40_000);
    client.send(JSON.stringify({ type: "response.create", response: { conversation: "none", instructions: "x", tools: [{ type: "function", name: "f" }], input: [{ type: "message", role: "user", content: [{ type: "input_text", text: big }] }] } }));
    client.send(JSON.stringify({ type: "response.create", response: { prompt: { id: "pmpt_1" } } }));
    await waitFor(() => received.filter((event) => event.type === "error").length === 2);
    const errors = received.filter((event) => event.type === "error").map((event) => event.error as { code: string; message: string });
    expect(errors.map((error) => error.code)).toEqual(["response_field_not_allowed", "response_field_not_allowed"]);
    expect(errors[0]?.message).toContain("response.conversation, response.instructions, response.tools, response.input");
    expect(upstream.sent.filter((event) => event.type === "response.create")).toHaveLength(0);
    // conversation "auto" (the default) and the output settings are fine.
    client.send(JSON.stringify({ type: "response.create", response: { conversation: "auto", output_modalities: ["audio"], metadata: { turn: "1" } } }));
    await waitFor(() => upstream.sent.some((event) => event.type === "response.create"));
    expect((await h.ledger.get(ticket.call_id))?.settledAt).toBeUndefined();
  });

  it("only an error OpenAI ties to the pending response.create lets the next one through (P10)", async () => {
    h = await startGuard();
    const { client, upstream, received } = await open(h);
    client.send(JSON.stringify({ type: "response.create" }));
    const first = await waitFor(() => upstream.sent.find((event) => event.type === "response.create"));
    // An unrelated error, from some other client event.
    upstream.server({ type: "error", error: { type: "invalid_request_error", code: "item_not_found", message: "no such item", event_id: "evt_client_1" } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    client.send(JSON.stringify({ type: "response.create" }));
    await waitFor(() => received.some((event) => event.type === "error" && (event.error as { code: string }).code === "response_in_progress"));
    expect(upstream.sent.filter((event) => event.type === "response.create")).toHaveLength(1);
    // OpenAI rejects the pending one by its event_id: the next one may go.
    upstream.server({ type: "error", error: { type: "invalid_request_error", code: "conversation_already_has_active_response", message: "busy", event_id: first.event_id } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    client.send(JSON.stringify({ type: "response.create" }));
    await waitFor(() => upstream.sent.filter((event) => event.type === "response.create").length === 2);
  });

  it("ends the call when the client sends more than the inbound byte budget (P8)", async () => {
    h = await startGuard();
    const { client, upstream, ticket } = await open(h);
    const audio = Buffer.alloc(190_000, 0x7f).toString("base64"); // about 253 KB a frame
    const frame = JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_audio", audio }] } });
    for (let i = 0; i < 90; i++) client.send(frame);
    const record = await settled(h, ticket.call_id);
    expect(record.endReason).toBe("policy");
    // 2 MiB of burst lets eight of these through; the rest never reach OpenAI.
    expect(upstream.sent.filter((event) => event.type === "conversation.item.create").length).toBeLessThanOrEqual(9);
    expect(h.lines.some((line) => line.message === "call.policy" && line.fields?.event === "inbound_rate")).toBe(true);
  });

  it("reserves a relayed response that shows no cap at the session's cap, which the relay forced on it", async () => {
    h = await startGuard();
    const { upstream, ticket } = await open(h);
    upstream.server({ type: "response.created", response: { id: "resp_1" } });
    const call = h.guard.context.active.get(ticket.call_id);
    await fetch(`${h.url}/v1/admin/calls/${ticket.call_id}/stop`, { method: "POST", headers: { Authorization: `Bearer ${API_KEY}` } });
    expect((await settled(h, ticket.call_id)).costUsd).toBeCloseTo(call?.worstResponseUsd ?? NaN, 9);
  });

  it("closes the call when the client tries to send session.update", async () => {
    h = await startGuard();
    const { client, ticket } = await open(h);
    const closed = new Promise((resolve) => client.once("close", resolve));
    client.send(JSON.stringify({ type: "session.update", session: { model: "gpt-realtime-2.1" } }));
    await closed;
    expect((await settled(h, ticket.call_id)).endReason).toBe("policy");
  });

  it("meters upstream usage, forwards it, and closes at the spend cap", async () => {
    h = await startGuard();
    const { client, upstream, ticket, received } = await open(h, { max_cost_usd: 0.1 });
    const closed = new Promise((resolve) => client.once("close", resolve));
    // $0.08 spent leaves less than two worst-case responses (about $0.031 each) of room.
    const usage = { input_tokens: 0, output_tokens: 4000, input_token_details: { text_tokens: 0, audio_tokens: 0 }, output_token_details: { text_tokens: 0, audio_tokens: 4000 } };
    upstream.server({ type: "response.done", response: { id: "resp_1", usage } });
    await closed;
    expect(received.some((event) => event.type === "response.done")).toBe(true);
    const record = await settled(h, ticket.call_id);
    expect(record.endReason).toBe("max_cost");
    expect(record.costUsd).toBeCloseTo(0.08, 10);
    expect(h.openai.hangups()).toHaveLength(0); // relay calls end by closing the upstream socket
    expect(upstream.readyState).toBe(3);
  });

  it("closes at the duration cap", async () => {
    h = await startGuard();
    const { client, ticket } = await open(h, { max_seconds: 1 });
    await new Promise((resolve) => client.once("close", resolve));
    expect((await settled(h, ticket.call_id)).endReason).toBe("max_duration");
  });

  it("refuses the upgrade without a valid ticket", async () => {
    h = await startGuard();
    const client = new WebSocket(`${h.url.replace("http", "ws")}/v1/realtime`, { headers: { Authorization: "Bearer nope" } });
    clients.push(client);
    const status = await new Promise((resolve) => client.once("unexpected-response", (_req, res) => resolve(res.statusCode)));
    expect(status).toBe(401);
    expect(h.openai.sockets).toHaveLength(0);
  });
});
