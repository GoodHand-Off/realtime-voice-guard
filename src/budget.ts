// The spend bound. Every response reserves the most it can cost; a call ends
// while one more response would still fit under its cap; and a cap too small
// for that is refused before the call starts.

import type { SessionConfig } from "./ledger.js";
import type { PriceTable } from "./pricing.js";

/**
 * Tokens counted on top of the instructions and tool definitions for OpenAI's
 * own framing of them. A safety margin, not a measured value.
 */
export const FRAMING_TOKENS = 256;

/**
 * Bytes counted for OpenAI's default instructions when a session sets none.
 * Instructions longer than this in a later `session.updated` end the call.
 */
export const DEFAULT_INSTRUCTIONS_BYTES = 1024;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** What one response may read and write under a session, in tokens. */
export interface ResponseLimits {
  /** Conversation tokens after the instructions: the session's truncation limit. */
  conversationTokens: number;
  /** Instructions and tool definitions, counted as one token per UTF-8 byte, plus {@link FRAMING_TOKENS}. */
  instructionTokens: number;
  /** The session's output cap. */
  outputTokens: number;
}

/**
 * Tool definitions as the guard compares and counts them: keys sorted, and
 * credentials (`authorization`, `headers`) left out, since OpenAI need not echo them.
 */
export function canonicalTools(tools: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (!isObject(value)) return value;
    const keys = Object.keys(value).filter((key) => key !== "authorization" && key !== "headers").sort();
    return Object.fromEntries(keys.map((key) => [key, canonical(value[key])]));
  };
  return Array.isArray(tools) && tools.length > 0 ? JSON.stringify(canonical(tools)) : "";
}

/**
 * The limits of a session built by `buildSession`. A token is never shorter
 * than a byte, so counting bytes never undercounts the instructions.
 */
export function responseLimits(session: SessionConfig): ResponseLimits {
  const truncation = isObject(session.truncation) && isObject(session.truncation.token_limits) ? session.truncation.token_limits.post_instructions : undefined;
  const instructions = typeof session.instructions === "string" ? Buffer.byteLength(session.instructions) : DEFAULT_INSTRUCTIONS_BYTES;
  return {
    conversationTokens: typeof truncation === "number" ? truncation : 0,
    instructionTokens: instructions + Buffer.byteLength(canonicalTools(session.tools)) + FRAMING_TOKENS,
    outputTokens: typeof session.max_output_tokens === "number" ? session.max_output_tokens : 0,
  };
}

/**
 * The most one response can cost on `model`: the conversation limit at the
 * model's dearest uncached input rate, the instructions at its text input rate,
 * and the output cap at its dearest output rate. Undefined if the model has no price.
 */
export function worstResponseUsd(table: PriceTable, model: string, limits: ResponseLimits): number | undefined {
  const prices = table.models[model];
  if (!prices) return undefined;
  const input = Math.max(prices.text.input, prices.audio.input, prices.image?.input ?? 0);
  const output = Math.max(prices.text.output ?? 0, prices.audio.output ?? 0);
  return (limits.conversationTokens * input + limits.instructionTokens * prices.text.input + limits.outputTokens * output) / 1_000_000;
}

/**
 * The smallest spend cap a call can run under: two worst-case responses, one
 * running and one more that may start before the guard sees it. Below this, a
 * call could not run even one response.
 */
export const minimumCapUsd = (worstUsd: number): number => 2 * worstUsd;

/** A dollar amount rounded up to four decimal places, for messages. */
export const formatUsd = (usd: number): string => `$${(Math.ceil(usd * 10_000) / 10_000).toFixed(4)}`;

/** Why `capUsd` is too small for `model` under `limits`, naming every input; undefined if it fits or the model is unpriced. */
export function capShortfall(table: PriceTable, model: string, limits: ResponseLimits, capUsd: number): string | undefined {
  const worst = worstResponseUsd(table, model, limits);
  if (worst === undefined || capUsd >= minimumCapUsd(worst)) return undefined;
  return (
    `must be at least ${formatUsd(minimumCapUsd(worst))} for ${model} (got $${capUsd}): two worst-case responses of ${formatUsd(worst)}, ` +
    `each reading ${limits.conversationTokens} conversation tokens (MAX_INPUT_TOKENS) and ${limits.instructionTokens} tokens of instructions and tools, ` +
    `and writing ${limits.outputTokens} tokens (MAX_OUTPUT_TOKENS)`
  );
}
