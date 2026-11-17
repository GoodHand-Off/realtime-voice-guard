// Call lifecycle edges from the independent review: shutdown races, sockets
// that reset mid-upgrade, expiring tickets and sessions, late usage, and calls
// stopped while OpenAI is still creating them.

import { request } from "node:http";
import { connect } from "node:net";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryLedger, type ClaimInput } from "../src/ledger.js";
import { API_KEY, MODEL, startGuard, waitFor } from "./helpers.js";

type Harness = Awaited<ReturnType<typeof startGuard>>;
let h: Harness | undefined;
const clients: WebSocket[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) if (client.readyState === WebSocket.OPEN) client.terminate();
  await h?.close();
  h = undefined;
});

const settled = (harness: Harness, id: string) => waitFor(async () => {
  const record = await harness.ledger.get(id);
  return record?.settledAt !== undefined ? record : undefined;
});

/** Starts an SDP offer and returns a function that sends the rest of the body. */
function slowOffer(harness: Harness, ticket: string) {
  const url = new URL(`${harness.url}/v1/realtime/calls`);
  let status = 0;
  const req = request({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { Authorization: `Bearer ${ticket}`, "Content-Type": "application/sdp" } });
  const done = new Promise<number>((resolve) => {
    req.on("response", (res) => {
      status = res.statusCode ?? 0;
      res.resume();
      res.on("end", () => resolve(status));
    });
    req.on("error", () => resolve(-1));
  });
  req.write("v=0 ");
  return { finish: () => req.end("slow-offer"), done };
}

const upgradeRequest = (ticket: string, key = "dGhlIHNhbXBsZSBub25jZQ==") =>
  `GET /v1/realtime HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${ticket}\r\n\r\n`;

describe("shutdown", () => {
  it("finishes a call that was still being admitted when shutdown began", async () => {
    h = await startGuard();
    const ticket = await h.mint();
    const offer = slowOffer(h, ticket.value);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const closing = h.close();
    offer.finish();
    await closing;
    expect(await offer.done).toBe(201);
    expect((await h.ledger.get(ticket.call_id))?.endReason).toBe("shutdown");
    expect(h.openai.hangups()).toHaveLength(1);
    h = undefined;
  });

  it("leaves a call unsettled for another instance when its hang-up fails during shutdown", async () => {
    h = await startGuard({ openai: { hangup: [500, 500, 500] } });
    const ticket = await h.mint();
    expect((await h.offer(ticket.value)).status).toBe(201);
    const { ledger, lines } = h;
    await h.close();
    h = undefined;
    expect(lines.some((line) => line.message === "call.left_running")).toBe(true);
    expect((await ledger.get(ticket.call_id))?.settledAt).toBeUndefined();
  });
});

describe("WebSocket upgrades", () => {
  it("survive a client that resets the connection after being refused", async () => {
    h = await startGuard();
    for (let i = 0; i < 3; i++) {
      const socket = connect(Number(new URL(h.url).port), "127.0.0.1");
      socket.on("error", () => {});
      await new Promise((resolve) => socket.once("connect", resolve));
      socket.write(upgradeRequest("not-a-ticket"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      socket.resetAndDestroy();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await fetch(`${h.url}/health`)).status).toBe(200);
  });

  it("do not burn a ticket on a malformed handshake", async () => {
    h = await startGuard();
    const ticket = await h.mint();
    const socket = connect(Number(new URL(h.url).port), "127.0.0.1");
    const reply = new Promise<string>((resolve) => socket.once("data", (data) => resolve(String(data))));
    socket.write(upgradeRequest(ticket.value, "short"));
    expect(await reply).toContain("400");
    socket.destroy();
    const client = new WebSocket(`${h.url.replace("http", "ws")}/v1/realtime`, { headers: { Authorization: `Bearer ${ticket.value}` } });
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once("open", () => resolve());
      client.once("error", reject);
    });
  });

  it.each([
    [100, "closes"],
    [400, "resets"],
  ] as const)("settle the claim as not_connected when the client leaves during a %i ms claim (%s)", async (delay, how) => {
    const ledger = new MemoryLedger();
    const claim = ledger.claim.bind(ledger);
    ledger.claim = async (input: ClaimInput) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return claim(input);
    };
    h = await startGuard({ ledger });
    const ticket = await h.mint();
    const socket = connect(Number(new URL(h.url).port), "127.0.0.1");
    socket.on("error", () => {});
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write(upgradeRequest(ticket.value));
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (how === "resets") socket.resetAndDestroy();
    else socket.destroy();
    expect(await settled(h, ticket.call_id)).toMatchObject({ endReason: "not_connected", durationSeconds: 0 });
    expect(h.openai.sockets).toHaveLength(0);
  });

  it("answer 500 without internals when the ledger fails during an upgrade", async () => {
    const ledger = new MemoryLedger();
    ledger.claim = async () => {
      throw new Error("secret internal detail");
    };
    h = await startGuard({ ledger });
    const ticket = await h.mint();
    const socket = connect(Number(new URL(h.url).port), "127.0.0.1");
    const reply = new Promise<string>((resolve) => socket.once("data", (data) => resolve(String(data))));
    socket.write(upgradeRequest(ticket.value));
    const text = await reply;
    socket.destroy();
    expect(text).toContain("500");
    expect(text).not.toContain("secret");
    expect(h.lines.some((line) => line.message === "upgrade.failed")).toBe(true);
  });
});

describe("tickets and sessions that expire mid-request", () => {
  it("refuse a ticket that expired while its body was arriving", async () => {
    let offset = 0;
    h = await startGuard({ now: () => Date.now() + offset });
    const ticket = await h.mint();
    const offer = slowOffer(h, ticket.value);
    await new Promise((resolve) => setTimeout(resolve, 30));
    offset = 10 * 60_000;
    offer.finish();
    expect(await offer.done).toBe(401);
    expect(h.openai.creates()).toHaveLength(0);
  });

  it("refuse a stored-session ticket whose session is gone, instead of running without it", async () => {
    const ledger = new MemoryLedger();
    const claim = ledger.claim.bind(ledger);
    ledger.claim = async (input: ClaimInput) => {
      const claimed = await claim(input);
      return claimed && { record: claimed.record };
    };
    h = await startGuard({ ledger });
    const ticket = await h.mint({ session: { model: MODEL, instructions: "Operator rules." } });
    const response = await h.offer(ticket.value);
    expect(response.status).toBe(410);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("session_expired");
    expect((await ledger.get(ticket.call_id))?.endReason).toBe("not_connected");
    expect(h.openai.creates()).toHaveLength(0);
  });
});

describe("provider edges", () => {
  it("hangs up when the browser raises the output cap on a single response", async () => {
    h = await startGuard();
    const ticket = await h.mint();
    await h.offer(ticket.value);
    h.openai.lastSocket().server({ type: "response.created", response: { id: "resp_1", max_output_tokens: "inf" } });
    expect((await settled(h, ticket.call_id)).endReason).toBe("policy");
  });

  it("accepts responses within the output cap", async () => {
    h = await startGuard();
    const ticket = await h.mint();
    await h.offer(ticket.value);
    h.openai.lastSocket().server({ type: "response.created", response: { id: "resp_1", max_output_tokens: 1024 } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await h.ledger.get(ticket.call_id))?.settledAt).toBeUndefined();
  });

  it("records a dropped sideband connection as monitor_lost, not a normal end", async () => {
    h = await startGuard();
    const ticket = await h.mint();
    await h.offer(ticket.value);
    const sideband = h.openai.lastSocket();
    sideband.readyState = 3;
    sideband.emit("close", 1006);
    expect(await settled(h, ticket.call_id)).toMatchObject({ endReason: "monitor_lost", monitoringComplete: false });
    expect(h.openai.hangups()).toHaveLength(1);
  });

  it("hangs up a call OpenAI created after it was already stopped", async () => {
    h = await startGuard({ openai: { createDelayMs: 150 } });
    const ticket = await h.mint();
    const offer = h.offer(ticket.value);
    await waitFor(async () => (await h?.ledger.get(ticket.call_id)) !== undefined);
    await fetch(`${h.url}/v1/admin/calls/${ticket.call_id}/stop`, { method: "POST", headers: { Authorization: `Bearer ${API_KEY}` } });
    expect((await offer).status).toBe(502);
    expect(h.openai.hangups()).toEqual(["https://openai.test/v1/realtime/calls/rtc_test123/hangup"]);
    expect((await h.ledger.get(ticket.call_id))?.endReason).toBe("stopped");
  });

  it("ignores usage that arrives after settlement", async () => {
    const ledger = new MemoryLedger();
    await ledger.claim({ id: "call_late_0001", model: MODEL, maxSeconds: 60, maxCostUsd: 1, owner: "a", now: 0 });
    await ledger.settle("call_late_0001", { reason: "ended", monitoringComplete: true, now: 1 });
    expect(await ledger.observe("call_late_0001", { responseId: "resp_x", costUsd: 5, complete: true })).toEqual({ duplicate: true, costUsd: 0, usageEvents: 0 });
  });

  it("purges claims that never became calls after a day", async () => {
    let now = 0;
    const ledger = new MemoryLedger(() => now);
    await ledger.claim({ id: "call_stale_0001", model: MODEL, maxSeconds: 60, maxCostUsd: 1, owner: "a", now: 0 });
    now = 25 * 60 * 60_000;
    await ledger.overdue({ now, deadlineGraceMs: 0, staleAfterMs: 0 });
    expect(await ledger.get("call_stale_0001")).toBeUndefined();
  });
});
