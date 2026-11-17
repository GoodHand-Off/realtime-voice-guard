import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallRecord } from "../src/ledger.js";
import { jsonLogger, silentLogger } from "../src/log.js";
import { createNotifier, signWebhook, verifyWebhookSignature } from "../src/webhook.js";
import { WEBHOOK_SECRET, captureLogger } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

const record = { id: "call_webhook_1", costUsd: 0.1 } as CallRecord;

describe("settlement webhook", () => {
  it("is a no-op without a URL", async () => {
    const fetchImpl = vi.fn();
    await createNotifier({ log: silentLogger, fetch: fetchImpl })(record);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("retries a rejected or failed delivery, then gives up and logs it", async () => {
    const { logger, lines } = captureLogger();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    await createNotifier({ url: "https://hooks.example.com/x", secret: WEBHOOK_SECRET, log: logger, fetch: fetchImpl, retryDelayMs: 1 })(record);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(lines.map((line) => line.message)).toEqual(["webhook.rejected", "webhook.failed"]);

    const failing = vi.fn().mockRejectedValue(new Error("down"));
    await createNotifier({ url: "https://hooks.example.com/x", secret: WEBHOOK_SECRET, log: logger, fetch: failing, retryDelayMs: 1 })(record);
    expect(failing).toHaveBeenCalledTimes(3);
    expect(lines.at(-1)).toMatchObject({ level: "error", message: "webhook.gave_up" });
  });

  it("rejects stale, malformed and forged signatures", () => {
    const body = JSON.stringify({ type: "call.settled", call: record });
    const now = 1_800_000_000_000;
    const signature = signWebhook(body, String(now), WEBHOOK_SECRET);
    expect(verifyWebhookSignature(body, String(now), signature, WEBHOOK_SECRET, 300_000, now + 1000)).toBe(true);
    expect(verifyWebhookSignature(body, String(now), signature, WEBHOOK_SECRET, 300_000, now + 301_000)).toBe(false);
    expect(verifyWebhookSignature(body, "not-a-time", signature, WEBHOOK_SECRET, 300_000, now)).toBe(false);
    expect(verifyWebhookSignature(body, String(now), "v1=short", WEBHOOK_SECRET, 300_000, now)).toBe(false);
    expect(verifyWebhookSignature(body, String(now), signWebhook(body, String(now), "x".repeat(40)), WEBHOOK_SECRET, 300_000, now)).toBe(false);
  });
});

describe("logging", () => {
  it("writes one JSON object per line: info to stdout, warn and error to stderr", () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => out.push(String(chunk)) > 0);
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => err.push(String(chunk)) > 0);
    jsonLogger.info("a", { call: "x", n: 1 });
    jsonLogger.warn("b");
    jsonLogger.error("c");
    silentLogger.info("ignored");
    silentLogger.warn("ignored");
    silentLogger.error("ignored");
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0] as string)).toMatchObject({ level: "info", msg: "a", call: "x", n: 1 });
    expect(err.map((line) => (JSON.parse(line) as { level: string }).level)).toEqual(["warn", "error"]);
  });
});
