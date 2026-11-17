// One contract, three ledgers: in-memory, Redis against a fake, and Redis
// against a real server when REDIS_URL is set (CI runs a Redis service).
// `at(t)` sets the time for the next operations: the `now` passed in for the
// memory ledger, and Redis's own clock (TIME) for the fake. A real Redis keeps
// its own time, so the timing assertions are skipped there.

import { createClient } from "redis";
import { afterAll, describe, expect, it } from "vitest";
import { MemoryLedger, type Ledger } from "../src/ledger.js";
import { RedisLedger, nodeRedisCommands, type NodeRedisClient } from "../src/redis-ledger.js";
import { FakeRedis } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

let counter = 0;
const uniqueId = () => `call_${process.pid}_${Date.now()}_${counter++}`;

interface Subject {
  ledger: Ledger;
  at(t: number): number;
}

const ledgers: Array<[string, () => Promise<Subject>, boolean]> = [
  [
    "memory",
    async () => {
      let time = 0;
      return { ledger: new MemoryLedger(() => time), at: (t) => (time = t) };
    },
    false,
  ],
  [
    "redis (fake)",
    async () => {
      const redis = new FakeRedis();
      let time = 0;
      redis.clock = () => time;
      return { ledger: new RedisLedger(redis, "test:"), at: (t) => (time = t) };
    },
    false,
  ],
];
if (process.env.REDIS_URL) {
  ledgers.push([
    "redis (real)",
    async () => {
      const client = createClient({ url: process.env.REDIS_URL });
      await client.connect();
      const ledger = new RedisLedger(nodeRedisCommands(client as unknown as NodeRedisClient), `rvg-test-${process.pid}-${Date.now()}:`);
      cleanups.push(() => ledger.close());
      return { ledger, at: (t) => t };
    },
    true,
  ]);
}

describe.each(ledgers)("%s ledger", (_name, make, realClock) => {
  const claimInput = (id: string, now = 1000) => ({ id, model: "gpt-realtime-2.1-mini", maxSeconds: 60, maxCostUsd: 0.5, owner: "instance-a", now });

  it("answers ping", async () => {
    const { ledger } = await make();
    await expect(ledger.ping()).resolves.toBeUndefined();
  });

  it("stores a session config once and hands it to the first claim only", async () => {
    const { ledger } = await make();
    const id = uniqueId();
    expect(await ledger.putSessionConfig(id, { model: "gpt-realtime-2.1-mini", instructions: "hi" }, 60_000)).toBe(true);
    expect(await ledger.putSessionConfig(id, { model: "other" }, 60_000)).toBe(false);
    const first = await ledger.claim(claimInput(id));
    expect(first?.session).toEqual({ model: "gpt-realtime-2.1-mini", instructions: "hi" });
    expect(first?.record).toMatchObject({ id, costUsd: 0, usageEvents: 0, stopRequested: false });
    expect(await ledger.claim(claimInput(id))).toBeUndefined();
    expect(await ledger.putSessionConfig(id, { model: "x" }, 60_000)).toBe(false);
  });

  it("sums cost once per response id", async () => {
    const { ledger } = await make();
    const id = uniqueId();
    await ledger.claim(claimInput(id));
    await ledger.bind(id, { transport: "webrtc", providerCallId: "rtc_a", now: 1000, deadlineAt: 61_000 });
    expect(await ledger.observe(id, { responseId: "resp_1", costUsd: 0.1, complete: true })).toMatchObject({ duplicate: false, usageEvents: 1 });
    expect(await ledger.observe(id, { responseId: "resp_1", costUsd: 0.1, complete: true })).toMatchObject({ duplicate: true, usageEvents: 1 });
    const second = await ledger.observe(id, { responseId: "resp_2", costUsd: 0.25, complete: false });
    expect(second.costUsd).toBeCloseTo(0.35, 10);
    expect((await ledger.get(id))?.usageComplete).toBe(false);
  });

  it("refuses to rebind a call to another provider call", async () => {
    const { ledger } = await make();
    const id = uniqueId();
    await ledger.claim(claimInput(id));
    await ledger.bind(id, { transport: "webrtc", providerCallId: "rtc_a", now: 1000, deadlineAt: 61_000 });
    await expect(ledger.bind(id, { transport: "webrtc", providerCallId: "rtc_b", now: 1000, deadlineAt: 61_000 })).rejects.toThrow();
  });

  it("turns a heartbeat inactive after a stop request, and reports the reason as stopped", async () => {
    const { ledger, at } = await make();
    const id = uniqueId();
    await ledger.claim(claimInput(id, at(1000)));
    await ledger.bind(id, { transport: "webrtc", providerCallId: "rtc_a", now: at(1000), deadlineAt: 61_000 });
    expect(await ledger.heartbeat(id, at(2000))).toEqual({ active: true });
    expect((await ledger.requestStop(id))?.stopRequested).toBe(true);
    expect(await ledger.heartbeat(id, at(3000))).toEqual({ active: false });
    const settled = await ledger.settle(id, { reason: "ended", monitoringComplete: true, now: at(31_000) });
    expect(settled?.record).toMatchObject({ endReason: "stopped", monitoringComplete: true });
    if (!realClock) expect(settled?.record.durationSeconds).toBe(30);
    expect(await ledger.requestStop("call_missing_000")).toBeUndefined();
  });

  it("settles once; the first settlement wins", async () => {
    const { ledger, at } = await make();
    const id = uniqueId();
    await ledger.claim(claimInput(id, at(1000)));
    await ledger.bind(id, { transport: "websocket", providerCallId: `ws:${id}`, now: at(1000), deadlineAt: 61_000 });
    const first = await ledger.settle(id, { reason: "max_cost", monitoringComplete: true, now: at(11_000) });
    const second = await ledger.settle(id, { reason: "shutdown", monitoringComplete: false, now: at(12_000) });
    expect(first).toMatchObject({ first: true, record: { endReason: "max_cost" } });
    expect(second).toMatchObject({ first: false, record: { endReason: "max_cost" } });
    if (!realClock) {
      expect(first?.record.durationSeconds).toBe(10);
      expect(second?.record.settledAt).toBe(11_000);
    }
    expect(await ledger.heartbeat(id, at(13_000))).toEqual({ active: false });
    expect(await ledger.observe(id, { responseId: "late", costUsd: 9, complete: true })).toMatchObject({ duplicate: true, costUsd: 0 });
    expect(await ledger.settle("call_missing_000", { reason: "ended", monitoringComplete: true, now: 1 })).toBeUndefined();
  });

  it.skipIf(realClock)("lists bound calls past their deadline or without a recent heartbeat", async () => {
    const { ledger, at } = await make();
    const late = uniqueId();
    const quiet = uniqueId();
    const fine = uniqueId();
    const unbound = uniqueId();
    at(1000);
    for (const id of [late, quiet, fine, unbound]) await ledger.claim(claimInput(id));
    await ledger.bind(late, { transport: "webrtc", providerCallId: "rtc_late", now: 1000, deadlineAt: 5000 });
    await ledger.bind(quiet, { transport: "webrtc", providerCallId: "rtc_quiet", now: 1000, deadlineAt: 900_000 });
    await ledger.bind(fine, { transport: "webrtc", providerCallId: "rtc_fine", now: 1000, deadlineAt: 900_000 });
    await ledger.heartbeat(fine, at(50_000));
    const window = { now: at(60_000), deadlineGraceMs: 50_000, staleAfterMs: 40_000 };
    const byId = Object.fromEntries((await ledger.overdue(window)).map((item) => [item.record.id, item.why]));
    expect(byId[late]).toBe("deadline");
    expect(byId[quiet]).toBe("stale");
    expect(byId[fine]).toBeUndefined();
    expect(byId[unbound]).toBeUndefined();
    await ledger.settle(late, { reason: "watchdog_deadline", monitoringComplete: false, now: at(61_000) });
    expect((await ledger.overdue(window)).map((item) => item.record.id)).not.toContain(late);
  });
});

describe("redis ledger clock", () => {
  it("uses Redis's TIME, so instances with skewed clocks agree", async () => {
    const redis = new FakeRedis();
    let redisTime = 1_000_000;
    redis.clock = () => redisTime;
    const ledger = new RedisLedger(redis, "skew:");
    // The owner's clock runs 10 minutes behind Redis; its deadline length still counts from Redis time.
    const ownerNow = redisTime - 600_000;
    await ledger.claim({ id: "call_skewed_01", model: "m", maxSeconds: 60, maxCostUsd: 1, owner: "a", now: ownerNow });
    await ledger.bind("call_skewed_01", { transport: "webrtc", providerCallId: "rtc_skew", now: ownerNow, deadlineAt: ownerNow + 60_000 });
    expect((await ledger.get("call_skewed_01"))?.deadlineAt).toBe(redisTime + 60_000);
    // A watchdog whose own clock is 10 minutes ahead still sees a live call.
    redisTime += 20_000;
    expect(await ledger.overdue({ now: redisTime + 600_000, deadlineGraceMs: 60_000, staleAfterMs: 60_000 })).toEqual([]);
    redisTime += 70_000;
    expect((await ledger.overdue({ now: 0, deadlineGraceMs: 0, staleAfterMs: 60_000 })).map((item) => item.why)).toEqual(["deadline"]);
  });
});
