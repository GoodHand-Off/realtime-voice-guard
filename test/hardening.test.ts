// Keys stay out of logs and serialization; numeric settings and options are
// finite; a broken clock cannot make a retry loop spin forever.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { ConfigError, assertConfig, loadConfig, type GuardConfig } from "../src/config.js";
import { MemoryLedger } from "../src/ledger.js";
import { createOpenAIRealtime } from "../src/openai.js";
import { RateLimiter } from "../src/rate-limit.js";
import { nodeRedisCommands, type NodeRedisClient } from "../src/redis-ledger.js";
import { Secret } from "../src/secret.js";
import { createGuard, type Guard } from "../src/server.js";
import { createNotifier } from "../src/webhook.js";
import { API_KEY, SIGNING_SECRET, WEBHOOK_SECRET, captureLogger, startGuard, testConfig, waitFor } from "./helpers.js";

const guards: Guard[] = [];
const dirs: string[] = [];
let h: Awaited<ReturnType<typeof startGuard>> | undefined;
afterEach(async () => {
  for (const guard of guards.splice(0)) await guard.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  await h?.close();
  h = undefined;
});

const prices = readFileSync(new URL("../prices.json", import.meta.url), "utf8");
const OPENAI = "sk-proj-" + "o".repeat(30);

describe("Secret", () => {
  it("prints [redacted] everywhere but reveal()", () => {
    const secret = new Secret("hunter2-hunter2");
    expect(secret.reveal()).toBe("hunter2-hunter2");
    expect(String(secret)).toBe("[redacted]");
    expect(`${secret}`).toBe("[redacted]");
    expect(JSON.stringify({ secret })).toBe('{"secret":"[redacted]"}');
    expect(inspect({ secret })).not.toContain("hunter2");
    expect(Object.keys(secret)).toEqual([]);
  });

  it("keeps every key out of a loaded config's JSON and inspect output", () => {
    const config = loadConfig(
      { OPENAI_API_KEY: OPENAI, GUARD_SIGNING_SECRET: SIGNING_SECRET, GUARD_API_KEY: API_KEY, REDIS_URL: "redis://:pa55word-pa55word@example.com:6379", SETTLE_WEBHOOK_URL: "https://hooks.example.com/x", SETTLE_WEBHOOK_SECRET: WEBHOOK_SECRET },
      () => prices,
    );
    for (const text of [JSON.stringify(config), inspect(config, { depth: 10, showHidden: true })]) {
      for (const value of [OPENAI, SIGNING_SECRET, API_KEY, WEBHOOK_SECRET, "pa55word"]) expect(text).not.toContain(value);
    }
  });

  it("keeps the keys out of a running guard's context", async () => {
    h = await startGuard();
    const text = inspect(h.guard.context, { depth: 6, showHidden: true });
    expect(text).not.toContain(SIGNING_SECRET);
    expect(text).not.toContain(API_KEY);
  });
});

describe("configs built in code", () => {
  const bad = async (overrides: Partial<GuardConfig>) => {
    const error = await createGuard(testConfig(overrides), { ledger: new MemoryLedger(), log: captureLogger().logger }).catch((e: unknown) => e);
    return error instanceof ConfigError ? error.variable : String(error);
  };

  it("are checked by createGuard, NaN and Infinity included", async () => {
    expect(await bad({ maxCallSeconds: Number.NaN })).toBe("MAX_CALL_SECONDS");
    expect(await bad({ heartbeatSeconds: Number.POSITIVE_INFINITY })).toBe("HEARTBEAT_SECONDS");
    expect(await bad({ maxCallCostUsd: -1 })).toBe("MAX_CALL_COST_USD");
    expect(await bad({ rateLimitPerMinute: 1.5 })).toBe("RATE_LIMIT_PER_MINUTE");
    expect(await bad({ apiKey: API_KEY as unknown as Secret })).toBe("GUARD_API_KEY");
    expect(await bad({ signingSecret: new Secret("short") })).toBe("GUARD_SIGNING_SECRET");
    expect(await bad({ apiKey: new Secret(SIGNING_SECRET) })).toBe("GUARD_API_KEY");
    expect(await bad({ openaiApiKey: new Secret(" ") })).toBe("OPENAI_API_KEY");
    expect(await bad({ openaiBaseUrl: "http://example.com" })).toBe("OPENAI_BASE_URL");
    expect(await bad({ settleWebhookUrl: "https://hooks.example.com/x" })).toBe("SETTLE_WEBHOOK_SECRET");
    expect(await bad({ prices: undefined as unknown as GuardConfig["prices"] })).toBe("PRICES_FILE");
    expect(() => assertConfig(testConfig({ settleWebhookUrl: "https://hooks.example.com/x", settleWebhookSecret: new Secret(WEBHOOK_SECRET) }))).not.toThrow();
  });
});

describe("numeric options", () => {
  it("must be finite, or construction fails with the option's name", async () => {
    await expect(createGuard(testConfig(), { ledger: new MemoryLedger(), retryDelayMs: Number.NaN })).rejects.toThrow("retryDelayMs");
    await expect(createGuard(testConfig(), { ledger: new MemoryLedger(), watchdogIntervalMs: 0 })).rejects.toThrow("watchdogIntervalMs");
    expect(() => new RateLimiter(Number.NaN)).toThrow(RangeError);
    expect(() => nodeRedisCommands({} as NodeRedisClient, Number.NaN)).toThrow("timeoutMs");
    expect(() => createNotifier({ url: "https://hooks.example.com/x", secret: WEBHOOK_SECRET, log: captureLogger().logger, retryDelayMs: Number.NaN })).toThrow("retryDelayMs");
    expect(() => createOpenAIRealtime({ apiKey: "fake", baseUrl: "https://openai.test", retryDelayMs: -1 })).toThrow("retryDelayMs");
  });

  it("a clock that breaks mid-call ends the hang-up retries instead of spinning", async () => {
    let broken = false;
    h = await startGuard({ now: () => (broken ? Number.NaN : Date.now()), openai: { hangup: Array(60).fill(500) } });
    const ticket = await h.mint();
    expect((await h.offer(ticket.value)).status).toBe(201);
    broken = true;
    await fetch(`${h.url}/v1/admin/calls/${ticket.call_id}/stop`, { method: "POST", headers: { Authorization: `Bearer ${API_KEY}` } });
    await waitFor(() => !h?.guard.context.active.has(ticket.call_id));
    expect(h.openai.hangups()).toHaveLength(3); // one round of three attempts, then it gives up
  });

  it("a clock that is broken from the start refuses every ticket", async () => {
    h = await startGuard({ now: () => Number.NaN });
    const ticket = await h.mint();
    expect((await h.offer(ticket.value)).status).toBe(401);
    expect(h.openai.requests).toHaveLength(0);
  });
});

describe("env file", () => {
  it("is read into the guard's config but never into process.env", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rvg-env-"));
    dirs.push(dir);
    writeFileSync(join(dir, ".env"), `OPENAI_API_KEY=${OPENAI}\nGUARD_SIGNING_SECRET=${SIGNING_SECRET}\nGUARD_API_KEY=${API_KEY}\nPORT=0\nHOST=127.0.0.1\nRVG_PRIVATE_MARKER=1\n`);
    const guard = await run({ envFile: join(dir, ".env"), log: captureLogger().logger });
    guards.push(guard);
    expect(guard.context.config.openaiApiKey.reveal()).toBe(OPENAI);
    expect(process.env.RVG_PRIVATE_MARKER).toBeUndefined();
    expect(Object.values(process.env)).not.toContain(OPENAI);
  });
});
