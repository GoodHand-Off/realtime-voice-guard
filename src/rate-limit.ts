// A fixed one-minute window per client address, for the public routes.

import type { IncomingMessage } from "node:http";
import { isIPv6 } from "node:net";
import { assertFinite } from "./util.js";

const WINDOW_MS = 60_000;
const MAX_TRACKED = 50_000;

/** Counts attempts per key in one-minute windows. A limit of 0 turns it off. */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
    private readonly maxTracked = MAX_TRACKED,
  ) {
    assertFinite("perMinute", perMinute);
    assertFinite("maxTracked", maxTracked, 1);
  }

  /** Records one attempt. Returns 0 if allowed, otherwise the seconds until the window resets. */
  take(key: string): number {
    if (this.perMinute <= 0) return 0;
    const now = this.now();
    let window = this.windows.get(key);
    if (!window || now - window.start >= WINDOW_MS) {
      // Re-insert so the map stays ordered by window start, oldest first.
      this.windows.delete(key);
      if (this.windows.size >= this.maxTracked) this.evict(now);
      window = { start: now, count: 0 };
      this.windows.set(key, window);
    }
    window.count += 1;
    return window.count > this.perMinute ? Math.max(1, Math.ceil((window.start + WINDOW_MS - now) / 1000)) : 0;
  }

  /**
   * Drops expired windows, then the oldest tenth if still full, sparing
   * clients that are over their limit: a flood of new addresses can't reset
   * a limited client's window. Only if every window is limited do the oldest go.
   */
  private evict(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.start < WINDOW_MS) break;
      this.windows.delete(key);
    }
    if (this.windows.size < this.maxTracked) return;
    const target = this.maxTracked - Math.ceil(this.maxTracked / 10);
    for (const [key, window] of this.windows) {
      if (this.windows.size <= target) return;
      if (window.count <= this.perMinute) this.windows.delete(key);
    }
    for (const key of this.windows.keys()) {
      if (this.windows.size <= target) return;
      this.windows.delete(key);
    }
  }
}

/**
 * The key an address is limited under. IPv6 clients usually hold a whole /64,
 * so they are counted per /64; IPv4-mapped IPv6 addresses count as IPv4.
 */
export function limitKey(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped?.[1]) return mapped[1];
  if (!isIPv6(address)) return address;
  const [head = "", tail = ""] = address.split("%")[0]?.split("::") ?? [];
  const groups = (part: string) => (part ? part.split(":") : []);
  const width = (parts: string[]) => parts.reduce((sum, part) => sum + (part.includes(".") ? 2 : 1), 0);
  const left = groups(head);
  const right = groups(tail);
  const full = address.includes("::") ? [...left, ...Array<string>(8 - width(left) - width(right)).fill("0"), ...right] : left;
  return `${full
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(":")}::/64`;
}

/**
 * The client's address. Each proxy appends the address it received the request
 * from to X-Forwarded-For, so with `trustedProxies` proxies in front of the guard
 * the client is that many entries from the right. Entries further left were
 * written by the client and are ignored.
 */
export function clientAddress(req: IncomingMessage, trustedProxies: number): string {
  if (trustedProxies > 0) {
    const header = req.headers["x-forwarded-for"];
    const hops = (Array.isArray(header) ? header.join(",") : (header ?? ""))
      .split(",")
      .map((hop) => hop.trim())
      .filter(Boolean);
    const client = hops[hops.length - trustedProxies];
    if (client) return client;
  }
  return req.socket.remoteAddress ?? "unknown";
}
