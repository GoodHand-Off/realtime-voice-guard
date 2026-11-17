// The watchdog ends calls whose owning instance died: past the deadline or
// silent for four heartbeats.

import { afterEach, describe, expect, it } from "vitest";
import { MemoryLedger } from "../src/ledger.js";
import { RedisLedger } from "../src/redis-ledger.js";
import { FakeRedis, startGuard } from "./helpers.js";

type Harness = Awaited<ReturnType<typeof startGuard>>;
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

let redis: FakeRedis | undefined;

/** A call bound `boundAgoMs` ago by an instance that has since died. Winds the fake Redis clock back too. */
async function orphan(harness: Harness, id: string, transport: "webrtc" | "websocket", boundAgoMs: number, maxSeconds: number) {
  const now = Date.now();
  if (redis) redis.clock = () => Date.now() - boundAgoMs;
  await harness.ledger.claim({ id, model: "gpt-realtime-2.1-mini", maxSeconds, maxCostUsd: 0.5, owner: "dead-instance", now: now - boundAgoMs });
  await harness.ledger.bind(id, {
    transport,
    providerCallId: transport === "webrtc" ? `rtc_${id}` : `ws:${id}`,
    now: now - boundAgoMs,
    deadlineAt: now - boundAgoMs + maxSeconds * 1000,
  });
  if (redis) redis.clock = Date.now;
}

describe.each([
  [
    "memory",
    () => {
      redis = undefined;
      return new MemoryLedger();
    },
  ],
  [
    "redis (fake)",
    () => {
      redis = new FakeRedis();
      return new RedisLedger(redis, "wd:");
    },
  ],
])("watchdog with the %s ledger", (_name, makeLedger) => {
  it("hangs up an orphaned WebRTC call past its deadline", async () => {
    h = await startGuard({ ledger: makeLedger() });
    await orphan(h, "call_orphan_late", "webrtc", 200_000, 60);
    await h.guard.watchdog.tick();
    expect(h.openai.hangups()).toEqual(["https://openai.test/v1/realtime/calls/rtc_call_orphan_late/hangup"]);
    expect(await h.ledger.get("call_orphan_late")).toMatchObject({ endReason: "watchdog_deadline", monitoringComplete: false });
  });

  it("hangs up an orphaned call that stopped sending heartbeats", async () => {
    h = await startGuard({ ledger: makeLedger(), config: { heartbeatSeconds: 15 } });
    await orphan(h, "call_orphan_quiet", "webrtc", 61_000, 600);
    await h.guard.watchdog.tick();
    expect(h.openai.hangups()).toHaveLength(1);
    expect((await h.ledger.get("call_orphan_quiet"))?.endReason).toBe("watchdog_stale");
  });

  it("leaves healthy calls alone and only settles orphaned relay calls", async () => {
    h = await startGuard({ ledger: makeLedger() });
    await orphan(h, "call_healthy_01", "webrtc", 5_000, 600);
    await orphan(h, "call_orphan_ws1", "websocket", 200_000, 60);
    await h.guard.watchdog.tick();
    expect(h.openai.hangups()).toHaveLength(0);
    expect((await h.ledger.get("call_healthy_01"))?.settledAt).toBeUndefined();
    expect((await h.ledger.get("call_orphan_ws1"))?.endReason).toBe("watchdog_deadline");
  });

  it("keeps retrying an unconfirmed hang-up until the call cannot still be running", async () => {
    let offset = 0;
    h = await startGuard({ ledger: makeLedger(), openai: { hangup: Array(30).fill(500) }, now: () => Date.now() + offset });
    await orphan(h, "call_orphan_stuck", "webrtc", 200_000, 60);
    for (let tick = 0; tick < 5; tick++) await h.guard.watchdog.tick();
    expect((await h.ledger.get("call_orphan_stuck"))?.settledAt).toBeUndefined();
    offset = 61 * 60_000; // past OpenAI's 60-minute session limit
    await h.guard.watchdog.tick();
    expect(await h.ledger.get("call_orphan_stuck")).toMatchObject({ endReason: "watchdog_deadline", monitoringComplete: false });
    expect(h.lines.filter((line) => line.message === "watchdog.hangup_unconfirmed")).toHaveLength(6);
  });
});
