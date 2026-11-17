// The command-line entry: read .env if present, load config, start the guard,
// and hang up every live call on SIGTERM or SIGINT.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { ConfigError, loadConfig } from "./config.js";
import { jsonLogger, type Logger } from "./log.js";
import { createGuard, type Guard } from "./server.js";

/** The guard warns at startup when the price table is older than this. */
export const PRICE_AGE_WARNING_DAYS = 60;

/** Options for {@link run}. The defaults are what the `realtime-voice-guard` command uses. */
export interface RunOptions {
  /** Environment to read. Default `process.env`. */
  env?: Record<string, string | undefined>;
  /**
   * File read before config, if it exists. Its values are merged into a private copy of `env`
   * (real environment variables win) and never written to `process.env`, so child processes and
   * other modules can't see them. Default `.env`.
   */
  envFile?: string;
  log?: Logger;
  /** Clock for the price-age check. */
  now?: () => number;
}

/** Starts the guard as the CLI does. Throws ConfigError on bad settings. */
export async function run(options: RunOptions = {}): Promise<Guard> {
  const log = options.log ?? jsonLogger;
  const envFile = resolve(options.envFile ?? ".env");
  const fromFile = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};
  const env: Record<string, string | undefined> = { ...fromFile };
  for (const [key, value] of Object.entries(options.env ?? process.env)) if (value !== undefined) env[key] = value;
  const config = loadConfig(env);
  const guard = await createGuard(config, { log });
  let port: number;
  try {
    port = await guard.listen();
  } catch (error) {
    await guard.close();
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE" || code === "EACCES") {
      throw new ConfigError("PORT", `${config.port} on ${config.host} is not available (${code})`, "Stop whatever holds it, or set PORT to a free port.", { cause: error });
    }
    throw error;
  }
  log.info("guard.listening", { port, ledger: guard.context.ledger.kind, pricesChecked: config.prices.checked });
  const ageDays = ((options.now ?? Date.now)() - Date.parse(config.prices.checked)) / 86_400_000;
  if (!(ageDays <= PRICE_AGE_WARNING_DAYS)) {
    log.warn("prices.stale", { checked: config.prices.checked, source: config.prices.source });
  }
  return guard;
}

/** Runs the guard until SIGTERM or SIGINT, then hangs up live calls and exits. Exits 1 with the reason on bad config. */
export async function main(options: RunOptions = {}): Promise<void> {
  const log = options.log ?? jsonLogger;
  try {
    const guard = await run(options);
    // Last resort: an unexpected error must not leave calls running without a monitor.
    const crash = (error: unknown) => {
      log.error("guard.crashed", { message: error instanceof Error ? error.message : "unknown error", activeCalls: guard.context.active.size });
      void guard.close().finally(() => process.exit(1));
    };
    process.once("uncaughtException", crash);
    process.once("unhandledRejection", crash);
    let stopping = false;
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.on(signal, () => {
        if (stopping) return;
        stopping = true;
        log.info("guard.stopping", { signal, activeCalls: guard.context.active.size });
        void guard.close().finally(() => process.exit(0));
      });
    }
  } catch (error) {
    const fields = error instanceof ConfigError ? { variable: error.variable, message: error.message } : { message: error instanceof Error ? error.message : "unknown error" };
    log.error("guard.start_failed", fields);
    process.exitCode = 1;
  }
}
