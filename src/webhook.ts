// Optional: POST each settled call to your backend so it can bill or log it.
// Signature: x-guard-signature: v1=<hex HMAC-SHA256(secret, `${timestamp}.${body}`)>

import { createHmac, timingSafeEqual } from "node:crypto";
import { describeError } from "./http.js";
import type { CallRecord } from "./ledger.js";
import type { Logger } from "./log.js";
import { assertFinite } from "./util.js";

/** Delivers a settled call record. Never throws. */
export type Notifier = (record: CallRecord) => Promise<void>;

/** The `x-guard-signature` value for a body and timestamp. */
export function signWebhook(body: string, timestamp: string, secret: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** For your receiver: checks the signature and rejects timestamps older than toleranceMs. */
export function verifyWebhookSignature(body: string, timestamp: string, signature: string, secret: string, toleranceMs = 300_000, now = Date.now()): boolean {
  const sent = Number(timestamp);
  if (!Number.isFinite(sent) || Math.abs(now - sent) > toleranceMs) return false;
  const expected = Buffer.from(signWebhook(body, timestamp, secret));
  const actual = Buffer.from(signature);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Posts each settled call to `url`, signed with `secret`, with three attempts. A no-op when either is unset. */
export function createNotifier(options: { url?: string; secret?: string; log: Logger; fetch?: typeof fetch; retryDelayMs?: number }): Notifier {
  const { url, secret, log } = options;
  if (!url || !secret) return async () => {};
  const fetchImpl = options.fetch ?? fetch;
  const retryDelayMs = assertFinite("retryDelayMs", options.retryDelayMs ?? 1000);
  return async (record) => {
    const body = JSON.stringify({ type: "call.settled", call: record });
    for (let attempt = 0; attempt < 3; attempt++) {
      const timestamp = String(Date.now());
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-guard-timestamp": timestamp, "x-guard-signature": signWebhook(body, timestamp, secret) },
          body,
          signal: AbortSignal.timeout(5000),
        });
        await response.body?.cancel();
        if (response.ok) return;
        log.warn("webhook.rejected", { call: record.id, status: response.status, attempt });
      } catch (error) {
        log.warn("webhook.failed", { call: record.id, attempt, error: describeError(error) });
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
    }
    log.error("webhook.gave_up", { call: record.id });
  };
}
