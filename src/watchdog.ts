// Backstop for calls whose owning instance died or stalled. With a shared
// ledger (Redis), any instance hangs up a WebRTC call that is past its
// deadline or has gone quiet, so a crash cannot leave a call running.

import type { GuardContext } from "./call.js";
import { describeError } from "./http.js";
import type { OverdueCall } from "./ledger.js";
import { SESSION_LIMIT_MS, assertFinite } from "./util.js";

/**
 * The owner's own timer normally fires first. The watchdog waits this much
 * longer, which covers the owner's hang-up attempts (about 32 s) and drain.
 */
export const DEADLINE_GRACE_MS = 60_000;

/** Starts the periodic sweep. `tick()` runs one pass now (used by tests and shutdown-free checks). */
export function startWatchdog(ctx: GuardContext, intervalMs = 5000): { stop(): void; tick(): Promise<void> } {
  assertFinite("intervalMs", intervalMs, 1);
  const attempts = new Map<string, number>();
  let running = false;

  async function handle({ record, why }: OverdueCall): Promise<void> {
    const local = ctx.active.get(record.id);
    if (local) {
      // Our own call: its timers handle it, unless the deadline was missed. Don't wait on its hang-up.
      if (why === "deadline") void local.finish("max_duration");
      return;
    }
    if (record.transport === "webrtc" && record.providerCallId) {
      try {
        await ctx.openai.hangup(record.providerCallId);
      } catch (error) {
        const attempt = (attempts.get(record.id) ?? 0) + 1;
        attempts.set(record.id, attempt);
        ctx.log.error("watchdog.hangup_unconfirmed", { call: record.id, attempt, error: describeError(error) });
        // Keep trying on later ticks until the call cannot still be running at OpenAI.
        // A NaN clock makes this false, so the watchdog gives up rather than retrying forever.
        if (ctx.now() < (record.boundAt ?? record.claimedAt) + SESSION_LIMIT_MS) return;
      }
    }
    // A relay call dies with its owner's sockets, so settling is all that is left.
    attempts.delete(record.id);
    const result = await ctx.ledger.settle(record.id, {
      reason: why === "deadline" ? "watchdog_deadline" : "watchdog_stale",
      monitoringComplete: false,
      now: ctx.now(),
    });
    if (result?.first) {
      ctx.log.warn("watchdog.settled", { call: record.id, reason: result.record.endReason, owner: record.owner });
      await ctx.notify(result.record);
    }
  }

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const overdue = await ctx.ledger.overdue({
        now: ctx.now(),
        deadlineGraceMs: DEADLINE_GRACE_MS,
        staleAfterMs: ctx.config.heartbeatSeconds * 4000,
      });
      for (const item of overdue) {
        try {
          await handle(item);
        } catch (error) {
          ctx.log.error("watchdog.failed", { call: item.record.id, error: describeError(error) });
        }
      }
    } catch (error) {
      ctx.log.error("watchdog.ledger_unavailable", { error: describeError(error) });
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer), tick };
}
