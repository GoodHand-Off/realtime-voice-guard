// Every setting comes from the environment. See .env.example for the list.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { capShortfall, responseLimits } from "./budget.js";
import { buildSession } from "./call.js";
import { parsePriceTable, type PriceTable } from "./pricing.js";
import { Secret } from "./secret.js";
import { MIN_SECRET_LENGTH } from "./ticket.js";

/** Runtime settings, normally built by {@link loadConfig} from environment variables. */
export interface GuardConfig {
  /** `OPENAI_API_KEY`. Used only by the guard, never sent to clients. */
  openaiApiKey: Secret;
  /** `OPENAI_BASE_URL`. Override only to point the guard at a mock. */
  openaiBaseUrl: string;
  /** `GUARD_SIGNING_SECRET`. Signs and verifies tickets. */
  signingSecret: Secret;
  /** `GUARD_API_KEY`. Authenticates `/v1/tickets` and the admin routes. */
  apiKey: Secret;
  /** `HOST`. Listen address. */
  host: string;
  /** `PORT`. Listen port; 0 picks a free one. */
  port: number;
  /** Parsed from `PRICES_FILE`, or the bundled prices.json. */
  prices: PriceTable;
  /** `MAX_CALL_SECONDS`. Ceiling for any ticket's duration cap. */
  maxCallSeconds: number;
  /** `MAX_CALL_COST_USD`. Ceiling for any ticket's spend cap, and its default. Must cover two worst-case responses on every priced model. */
  maxCallCostUsd: number;
  /** `MAX_CONCURRENT_CALLS`. Live calls per instance. */
  maxConcurrentCalls: number;
  /** `MAX_OUTPUT_TOKENS`. Forced onto every session and relayed `response.create`. */
  maxOutputTokens: number;
  /** `MAX_INPUT_TOKENS`. Conversation tokens each response may re-read after the instructions (OpenAI's truncation limit). */
  maxInputTokens: number;
  /** `MAX_RESPONSES_PER_CALL`. Ends runaway response loops. */
  maxResponsesPerCall: number;
  /** `HEARTBEAT_SECONDS`. Liveness interval; four missed beats mark an owner dead. */
  heartbeatSeconds: number;
  /** `TICKET_TTL_SECONDS`. How long a ticket stays valid. */
  ticketTtlSeconds: number;
  /** `ALLOWED_ORIGINS`. Browser origins allowed to post offers; `*` allows any. */
  allowedOrigins: string[];
  /** `RATE_LIMIT_PER_MINUTE`. Call attempts per client address per minute on public routes; 0 turns it off. */
  rateLimitPerMinute: number;
  /** `TRUSTED_PROXIES`. How many proxies you run in front of the guard; 0 ignores `X-Forwarded-For`. */
  trustedProxies: number;
  /** `SHUTDOWN_GRACE_SECONDS`. How long shutdown waits for hang-ups before exiting. */
  shutdownGraceSeconds: number;
  /** `REDIS_URL`. When set, the Redis ledger is used. A secret, since it may hold a password. */
  redisUrl?: Secret;
  /** `REDIS_PREFIX`. Key prefix for the Redis ledger. */
  redisPrefix: string;
  /** `SETTLE_WEBHOOK_URL`. Receives each settled call. */
  settleWebhookUrl?: string;
  /** `SETTLE_WEBHOOK_SECRET`. Signs the settlement webhook. */
  settleWebhookSecret?: Secret;
}

/** A missing or invalid setting. `variable` names the environment variable to fix. */
export class ConfigError extends Error {
  constructor(
    readonly variable: string,
    problem: string,
    hint = "",
    options?: { cause?: unknown },
  ) {
    super(`${variable} ${problem}.${hint ? ` ${hint}` : ""}`, options);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

const SECRET_HINT = "Generate one with `openssl rand -hex 32`, or run `npm run setup` to write a .env with fresh values.";
const HINTS: Record<string, string> = {
  OPENAI_API_KEY: "Create one at https://platform.openai.com/api-keys; it needs access to the Realtime API.",
  GUARD_SIGNING_SECRET: SECRET_HINT,
  GUARD_API_KEY: SECRET_HINT,
  SETTLE_WEBHOOK_SECRET: `It signs the settlement webhook and is required with SETTLE_WEBHOOK_URL. ${SECRET_HINT}`,
};

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(name, "is not set", HINTS[name]);
  return value;
}

function secret(env: Env, name: string): Secret {
  const value = required(env, name);
  if (value.length < MIN_SECRET_LENGTH) throw new ConfigError(name, `must be at least ${MIN_SECRET_LENGTH} characters`, HINTS[name]);
  return new Secret(value);
}

type NumericKey =
  | "port"
  | "maxCallSeconds"
  | "maxCallCostUsd"
  | "maxConcurrentCalls"
  | "maxOutputTokens"
  | "maxInputTokens"
  | "maxResponsesPerCall"
  | "heartbeatSeconds"
  | "ticketTtlSeconds"
  | "rateLimitPerMinute"
  | "trustedProxies"
  | "shutdownGraceSeconds";

/** Every numeric setting: its variable, default and allowed range. */
const NUMBERS: Record<NumericKey, { variable: string; fallback: number; min: number; max: number; integer: boolean }> = {
  port: { variable: "PORT", fallback: 8080, min: 0, max: 65535, integer: true },
  // OpenAI ends any Realtime session at 60 minutes, so a longer cap means nothing.
  maxCallSeconds: { variable: "MAX_CALL_SECONDS", fallback: 600, min: 1, max: 3600, integer: true },
  maxCallCostUsd: { variable: "MAX_CALL_COST_USD", fallback: 1, min: 0.01, max: 1000, integer: false },
  maxConcurrentCalls: { variable: "MAX_CONCURRENT_CALLS", fallback: 100, min: 1, max: 10000, integer: true },
  // OpenAI accepts 1 to 4096 (or "inf"); the guard always sends a number.
  maxOutputTokens: { variable: "MAX_OUTPUT_TOKENS", fallback: 1024, min: 1, max: 4096, integer: true },
  // OpenAI's limit is the context window (128k) minus the output cap. The default keeps two
  // worst-case responses on the dearest model in prices.json under the default $1 cap (see README).
  maxInputTokens: { variable: "MAX_INPUT_TOKENS", fallback: 4000, min: 1000, max: 120000, integer: true },
  maxResponsesPerCall: { variable: "MAX_RESPONSES_PER_CALL", fallback: 300, min: 1, max: 100000, integer: true },
  heartbeatSeconds: { variable: "HEARTBEAT_SECONDS", fallback: 15, min: 1, max: 60, integer: true },
  ticketTtlSeconds: { variable: "TICKET_TTL_SECONDS", fallback: 120, min: 10, max: 900, integer: true },
  rateLimitPerMinute: { variable: "RATE_LIMIT_PER_MINUTE", fallback: 60, min: 0, max: 100000, integer: true },
  trustedProxies: { variable: "TRUSTED_PROXIES", fallback: 0, min: 0, max: 10, integer: true },
  // Below Kubernetes' default 30 s grace period; give Docker `stop -t 30`.
  shutdownGraceSeconds: { variable: "SHUTDOWN_GRACE_SECONDS", fallback: 25, min: 1, max: 600, integer: true },
};

function checkNumber(key: NumericKey, value: number, shown: string): number {
  const { variable, fallback, min, max, integer } = NUMBERS[key];
  // Number.isFinite rejects NaN and Infinity, which would otherwise slip past every comparison.
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new ConfigError(variable, `must be ${integer ? "an integer" : "a number"} from ${min} to ${max} (got "${shown}")`, `Unset it to use the default, ${fallback}.`);
  }
  return value;
}

function number(env: Env, key: NumericKey): number {
  const raw = env[NUMBERS[key].variable]?.trim();
  return raw ? checkNumber(key, Number(raw), raw) : NUMBERS[key].fallback;
}

function checkSecret(variable: string, value: Secret): void {
  if (!(value instanceof Secret) || value.reveal().trim().length < (variable === "OPENAI_API_KEY" ? 1 : MIN_SECRET_LENGTH)) {
    throw new ConfigError(variable, variable === "OPENAI_API_KEY" ? "is not set" : `must be at least ${MIN_SECRET_LENGTH} characters`, HINTS[variable]);
  }
}

/**
 * Checks a {@link GuardConfig} built in code rather than by {@link loadConfig}:
 * every number finite and in range, every secret present and long enough.
 * {@link createGuard} calls it. Throws a {@link ConfigError} naming the variable.
 */
export function assertConfig(config: GuardConfig): void {
  checkSecret("OPENAI_API_KEY", config.openaiApiKey);
  checkSecret("GUARD_SIGNING_SECRET", config.signingSecret);
  checkSecret("GUARD_API_KEY", config.apiKey);
  if (config.signingSecret.reveal() === config.apiKey.reveal()) throw new ConfigError("GUARD_API_KEY", "must be different from GUARD_SIGNING_SECRET", SECRET_HINT);
  if (config.trustedProxies === undefined) throw new ConfigError("TRUSTED_PROXIES", "is missing from the config");
  for (const key of Object.keys(NUMBERS) as NumericKey[]) checkNumber(key, config[key], String(config[key]));
  httpUrl("OPENAI_BASE_URL", config.openaiBaseUrl, true);
  if (!config.prices || typeof config.prices.models !== "object") throw new ConfigError("PRICES_FILE", "did not produce a price table");
  // A ticket that asks for no cap gets MAX_CALL_COST_USD, so it must be a cap a call can run under on every priced model.
  for (const model of Object.keys(config.prices.models)) {
    const shortfall = capShortfall(config.prices, model, responseLimits(buildSession(undefined, model, config.maxOutputTokens, config.maxInputTokens)), config.maxCallCostUsd);
    if (shortfall) {
      throw new ConfigError("MAX_CALL_COST_USD", shortfall, `Raise MAX_CALL_COST_USD, lower MAX_INPUT_TOKENS or MAX_OUTPUT_TOKENS, or remove ${model} from PRICES_FILE.`);
    }
  }
  if (config.settleWebhookUrl !== undefined) {
    httpUrl("SETTLE_WEBHOOK_URL", config.settleWebhookUrl, true);
    if (!config.settleWebhookSecret) throw new ConfigError("SETTLE_WEBHOOK_SECRET", "is not set", HINTS.SETTLE_WEBHOOK_SECRET);
    checkSecret("SETTLE_WEBHOOK_SECRET", config.settleWebhookSecret);
    const webhook = config.settleWebhookSecret.reveal();
    if (webhook === config.signingSecret.reveal() || webhook === config.apiKey.reveal()) {
      throw new ConfigError("SETTLE_WEBHOOK_SECRET", "must be different from GUARD_SIGNING_SECRET and GUARD_API_KEY", SECRET_HINT);
    }
  }
}

function httpUrl(name: string, raw: string, allowLocalHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(name, `must be a URL (got "${raw}")`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(allowLocalHttp && local && url.protocol === "http:")) {
    throw new ConfigError(name, "must use https", "http is allowed only for localhost.");
  }
  return raw.replace(/\/+$/, "");
}

function origins(env: Env): string[] {
  const list = (env.ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim().replace(/\/+$/, "")).filter(Boolean);
  for (const origin of list) {
    if (origin === "*") continue;
    let parsed: URL | undefined;
    try {
      parsed = new URL(origin);
    } catch {
      parsed = undefined;
    }
    if (!parsed || parsed.origin !== origin) {
      throw new ConfigError("ALLOWED_ORIGINS", `has "${origin}", which is not an origin`, "Use scheme://host[:port] with no path, for example https://app.example.com, separated by commas.");
    }
  }
  return list;
}

/**
 * Builds a {@link GuardConfig} from environment variables and the price table.
 * Throws a {@link ConfigError} naming the first variable that is missing or invalid.
 */
export function loadConfig(env: Env = process.env, readFile: (path: string) => string = (path) => readFileSync(path, "utf8")): GuardConfig {
  const openaiApiKey = new Secret(required(env, "OPENAI_API_KEY"));
  const signingSecret = secret(env, "GUARD_SIGNING_SECRET");
  const apiKey = secret(env, "GUARD_API_KEY");
  if (signingSecret.reveal() === apiKey.reveal()) throw new ConfigError("GUARD_API_KEY", "must be different from GUARD_SIGNING_SECRET", SECRET_HINT);

  // Default: the prices.json shipped next to dist/ (in the repo, the package and the Docker image).
  const pricesPath = env.PRICES_FILE?.trim() ? resolve(env.PRICES_FILE.trim()) : fileURLToPath(new URL("../prices.json", import.meta.url));
  let prices: PriceTable;
  try {
    prices = parsePriceTable(JSON.parse(readFile(pricesPath)));
  } catch (error) {
    throw new ConfigError("PRICES_FILE", `could not be loaded from ${pricesPath}: ${(error as Error).message}`, "Point it at a JSON price table; the repo ships prices.json.", { cause: error });
  }

  const redisPrefix = env.REDIS_PREFIX?.trim() || "rvg:";
  if (!/^[A-Za-z0-9:_-]{1,64}$/.test(redisPrefix)) throw new ConfigError("REDIS_PREFIX", "may use only letters, digits, colon, underscore and hyphen (up to 64)");

  const config: GuardConfig = {
    openaiApiKey,
    openaiBaseUrl: httpUrl("OPENAI_BASE_URL", env.OPENAI_BASE_URL?.trim() || "https://api.openai.com", true),
    signingSecret,
    apiKey,
    host: env.HOST?.trim() || "0.0.0.0",
    port: number(env, "port"),
    prices,
    maxCallSeconds: number(env, "maxCallSeconds"),
    maxCallCostUsd: number(env, "maxCallCostUsd"),
    maxConcurrentCalls: number(env, "maxConcurrentCalls"),
    maxOutputTokens: number(env, "maxOutputTokens"),
    maxInputTokens: number(env, "maxInputTokens"),
    maxResponsesPerCall: number(env, "maxResponsesPerCall"),
    heartbeatSeconds: number(env, "heartbeatSeconds"),
    ticketTtlSeconds: number(env, "ticketTtlSeconds"),
    allowedOrigins: origins(env),
    rateLimitPerMinute: number(env, "rateLimitPerMinute"),
    trustedProxies: number(env, "trustedProxies"),
    shutdownGraceSeconds: number(env, "shutdownGraceSeconds"),
    redisPrefix,
  };
  const redisUrl = env.REDIS_URL?.trim();
  if (redisUrl) {
    if (!/^rediss?:\/\//.test(redisUrl)) throw new ConfigError("REDIS_URL", "must start with redis:// or rediss://", "Unset it to use the in-memory ledger.");
    config.redisUrl = new Secret(redisUrl);
  }
  const webhook = env.SETTLE_WEBHOOK_URL?.trim();
  if (webhook) {
    config.settleWebhookUrl = httpUrl("SETTLE_WEBHOOK_URL", webhook, true);
    config.settleWebhookSecret = secret(env, "SETTLE_WEBHOOK_SECRET");
  }
  if (env.TRUST_PROXY?.trim()) throw new ConfigError("TRUST_PROXY", "was replaced by TRUSTED_PROXIES", "Set TRUSTED_PROXIES to the number of proxies in front of the guard (for example 1 behind a single load balancer).");
  assertConfig(config);
  return config;
}
