import type { IncomingMessage } from "node:http";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter, clientAddress, limitKey } from "../src/rate-limit.js";
import { API_KEY, startGuard } from "./helpers.js";

type Harness = Awaited<ReturnType<typeof startGuard>>;
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("RateLimiter", () => {
  it("allows the limit per minute, then reports the wait, then resets", () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(2, () => now);
    expect([limiter.take("a"), limiter.take("a")]).toEqual([0, 0]);
    expect(limiter.take("a")).toBe(60);
    expect(limiter.take("b")).toBe(0);
    now += 30_500;
    expect(limiter.take("a")).toBe(30);
    now += 30_000;
    expect(limiter.take("a")).toBe(0);
  });

  it("is off at 0", () => {
    const limiter = new RateLimiter(0);
    for (let i = 0; i < 1000; i++) expect(limiter.take("a")).toBe(0);
  });

  it("stays bounded under a flood of distinct addresses without resetting everyone", () => {
    let now = 0;
    const limiter = new RateLimiter(1, () => now, 100);
    for (let i = 0; i < 10; i++) limiter.take(`old-${i}`);
    now += 1;
    expect(limiter.take("victim")).toBe(0);
    expect(limiter.take("victim")).toBeGreaterThan(0); // limited
    now += 1;
    for (let i = 0; i < 89; i++) limiter.take(`flood-${i}`); // the table is now full
    for (let i = 89; i < 95; i++) limiter.take(`flood-${i}`); // more new addresses force an eviction
    expect(limiter.take("victim")).toBeGreaterThan(0); // still limited: only the ten oldest windows went
    expect(limiter.take("old-0")).toBe(0); // an evicted window starts over
    now += 60_001;
    expect(limiter.take("victim")).toBe(0); // windows still expire normally
  });

  it("keeps a limited client's window when a flood fills the table, even if it is the oldest", () => {
    let now = 0;
    const limiter = new RateLimiter(1, () => now, 100);
    limiter.take("victim");
    expect(limiter.take("victim")).toBeGreaterThan(0); // limited, and the oldest window in the table
    now += 1;
    for (let i = 0; i < 150; i++) limiter.take(`flood-${i}`);
    expect(limiter.take("victim")).toBeGreaterThan(0); // still limited
  });

  it("drops the oldest windows when every one of them is limited", () => {
    let now = 0;
    const limiter = new RateLimiter(1, () => now, 10);
    for (let i = 0; i < 10; i++) {
      limiter.take(`busy-${i}`);
      limiter.take(`busy-${i}`);
    }
    now += 1;
    expect(limiter.take("newcomer")).toBe(0);
    expect(limiter.take("busy-0")).toBe(0); // the oldest went to make room
    expect(limiter.take("busy-9")).toBeGreaterThan(0);
  });

  it("rejects a non-finite limit", () => {
    expect(() => new RateLimiter(1, Date.now, Number.NaN)).toThrow("maxTracked");
  });
});

describe("limitKey", () => {
  it("counts IPv6 clients per /64 and IPv4-mapped addresses as IPv4", () => {
    expect(limitKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(limitKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(limitKey("2001:0db8:0001:0002:ffff::9")).toBe("2001:db8:1:2::/64");
    expect(limitKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(limitKey("::1")).toBe("0:0:0:0::/64");
    expect(limitKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(limitKey("64:ff9b::192.0.2.33")).toBe("64:ff9b:0:0::/64");
    expect(limitKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(limitKey("203.0.113.9")).toBe("203.0.113.9");
    expect(limitKey("unknown")).toBe("unknown");
  });
});

describe("clientAddress", () => {
  const req = (forwarded?: string | string[]) => ({ headers: { "x-forwarded-for": forwarded }, socket: { remoteAddress: "10.0.0.1" } }) as unknown as IncomingMessage;
  it("uses the socket peer unless proxies are trusted", () => {
    expect(clientAddress(req("203.0.113.9"), 0)).toBe("10.0.0.1");
    expect(clientAddress(req(), 1)).toBe("10.0.0.1");
  });

  it("takes the hop the trusted proxies appended, never one the client wrote", () => {
    // One load balancer: it appends the real client after whatever the client sent.
    expect(clientAddress(req("1.2.3.4, 203.0.113.9"), 1)).toBe("203.0.113.9");
    expect(clientAddress(req("spoof-a, spoof-b, 203.0.113.9"), 1)).toBe("203.0.113.9");
    // Two proxies: the client is second from the right.
    expect(clientAddress(req("spoof, 198.51.100.4, 10.0.0.7"), 2)).toBe("198.51.100.4");
    expect(clientAddress(req(["spoof", "198.51.100.4"]), 1)).toBe("198.51.100.4");
    // Fewer hops than trusted proxies: fall back to the socket peer.
    expect(clientAddress(req("198.51.100.4"), 2)).toBe("10.0.0.1");
  });
});

describe("rate limits on the guard", () => {
  it("limits call attempts per address on the public route", async () => {
    h = await startGuard({ config: { rateLimitPerMinute: 2 } });
    expect((await h.offer("bad")).status).toBe(401);
    expect((await h.offer("bad")).status).toBe(401);
    const third = await h.offer("bad");
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("counts only failed API-key attempts, so the backend is never throttled", async () => {
    h = await startGuard({ config: { rateLimitPerMinute: 2 } });
    for (let i = 0; i < 4; i++) expect((await h.mint()).status).toBe(201);
    const wrong = () => fetch(`${h?.url}/v1/admin/calls/call_unknown_1`, { headers: { Authorization: "Bearer wrong" } });
    expect((await wrong()).status).toBe(401);
    expect((await wrong()).status).toBe(401);
    expect((await wrong()).status).toBe(429);
    expect((await fetch(`${h.url}/v1/admin/calls/call_unknown_1`, { headers: { Authorization: `Bearer ${API_KEY}` } })).status).toBe(404);
  });

  it("limits and origin-checks WebSocket upgrades", async () => {
    h = await startGuard({ config: { rateLimitPerMinute: 1 } });
    const status = (headers: Record<string, string>) =>
      new Promise<number>((resolve) => {
        const client = new WebSocket(`${h?.url.replace("http", "ws")}/v1/realtime`, { headers });
        client.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        client.once("error", () => resolve(-1));
      });
    expect(await status({ Origin: "http://evil.test", Authorization: "Bearer x" })).toBe(403);
    expect(await status({ Authorization: "Bearer x" })).toBe(401);
    expect(await status({ Authorization: "Bearer x" })).toBe(429);
  });
});
