// Spend estimates from the usage OpenAI reports on each response.
// Prices are never hard-coded here: they come from a JSON price table the
// operator supplies (see prices.json and PRICES_FILE).

/** Rates for one modality, in USD per 1M tokens. */
export interface TokenRates {
  input: number;
  cached_input?: number;
  output?: number;
}

/** Prices for one Realtime model. */
export interface RealtimeModelPrices {
  text: TokenRates;
  audio: TokenRates;
  image?: TokenRates;
}

/** Token rates are USD per 1M tokens; per_minute is USD per minute of audio. */
export interface TranscriptionPrices {
  input?: number;
  output?: number;
  per_minute?: number;
}

/** A validated price table, as loaded from prices.json. */
export interface PriceTable {
  /** Where the prices were copied from. */
  source: string;
  /** When they were copied (YYYY-MM-DD). */
  checked: string;
  models: Record<string, RealtimeModelPrices>;
  transcription: Record<string, TranscriptionPrices>;
}

/** `complete` is false when usage was missing or had to be priced conservatively. */
export interface CostEstimate {
  usd: number;
  complete: boolean;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** True when a `response.done` usage object reports both input and output token counts. */
export function reportsUsage(usage: unknown): boolean {
  return isObject(usage) && count(usage.input_tokens) !== undefined && count(usage.output_tokens) !== undefined;
}

function rate(value: unknown, path: string, required: boolean): number | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Price table: ${path} must be a non-negative number`);
  }
  return value;
}

function tokenRates(value: unknown, path: string, needsOutput: boolean): TokenRates {
  if (!isObject(value)) throw new Error(`Price table: ${path} must be an object`);
  const rates: TokenRates = { input: rate(value.input, `${path}.input`, true) as number };
  const cached = rate(value.cached_input, `${path}.cached_input`, false);
  const output = rate(value.output, `${path}.output`, needsOutput);
  if (cached !== undefined) rates.cached_input = cached;
  if (output !== undefined) rates.output = output;
  return rates;
}

/** Validates a parsed price table. Throws with the offending path. */
export function parsePriceTable(raw: unknown): PriceTable {
  if (!isObject(raw)) throw new Error("Price table must be a JSON object");
  if (typeof raw.source !== "string" || typeof raw.checked !== "string") {
    throw new Error("Price table needs `source` (URL) and `checked` (YYYY-MM-DD)");
  }
  if (!isObject(raw.models) || Object.keys(raw.models).length === 0) {
    throw new Error("Price table needs at least one entry in `models`");
  }
  const models: Record<string, RealtimeModelPrices> = {};
  for (const [name, value] of Object.entries(raw.models)) {
    if (!isObject(value)) throw new Error(`Price table: models.${name} must be an object`);
    const prices: RealtimeModelPrices = {
      text: tokenRates(value.text, `models.${name}.text`, true),
      audio: tokenRates(value.audio, `models.${name}.audio`, true),
    };
    if (value.image !== undefined) prices.image = tokenRates(value.image, `models.${name}.image`, false);
    models[name] = prices;
  }
  const transcription: Record<string, TranscriptionPrices> = {};
  for (const [name, value] of Object.entries(isObject(raw.transcription) ? raw.transcription : {})) {
    if (!isObject(value)) throw new Error(`Price table: transcription.${name} must be an object`);
    const entry: TranscriptionPrices = {};
    for (const key of ["input", "output", "per_minute"] as const) {
      const parsed = rate(value[key], `transcription.${name}.${key}`, false);
      if (parsed !== undefined) entry[key] = parsed;
    }
    if (entry.per_minute === undefined && (entry.input === undefined || entry.output === undefined)) {
      throw new Error(`Price table: transcription.${name} needs per_minute, or both input and output`);
    }
    transcription[name] = entry;
  }
  return { source: raw.source, checked: raw.checked, models, transcription };
}

/**
 * Estimates one `response.done` usage object. Returns undefined only when the
 * model has no price entry. Token counts that the details do not explain are
 * charged at the highest rate in that direction, so the estimate errs high.
 * Usage without token counts comes back as $0 and incomplete; the guard checks
 * {@link reportsUsage} first and charges the response's full reservation instead.
 */
export function estimateResponseCost(table: PriceTable, model: string, usage: unknown): CostEstimate | undefined {
  const prices = table.models[model];
  if (!prices) return undefined;
  if (!isObject(usage)) return { usd: 0, complete: false };
  const inputTokens = count(usage.input_tokens);
  const outputTokens = count(usage.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return { usd: 0, complete: false };

  const inDetails = isObject(usage.input_token_details) ? usage.input_token_details : {};
  const cachedDetails = isObject(inDetails.cached_tokens_details) ? inDetails.cached_tokens_details : {};
  const outDetails = isObject(usage.output_token_details) ? usage.output_token_details : {};
  let complete = isObject(usage.input_token_details) && isObject(usage.output_token_details);

  const maxInput = Math.max(prices.text.input, prices.audio.input, prices.image?.input ?? 0);
  const maxOutput = Math.max(prices.text.output ?? 0, prices.audio.output ?? 0);
  let micro = 0; // USD per 1M tokens, summed
  let explainedInput = 0;
  const modalities: Array<["text_tokens" | "audio_tokens" | "image_tokens", TokenRates | undefined]> = [
    ["text_tokens", prices.text],
    ["audio_tokens", prices.audio],
    ["image_tokens", prices.image],
  ];
  for (const [key, rates] of modalities) {
    const tokens = count(inDetails[key]) ?? 0;
    const cached = Math.min(count(cachedDetails[key]) ?? 0, tokens);
    if (tokens > 0 && !rates) complete = false;
    const fresh = rates?.input ?? maxInput;
    const reuse = rates?.cached_input ?? fresh;
    micro += (tokens - cached) * fresh + cached * reuse;
    explainedInput += tokens;
  }
  if (explainedInput !== inputTokens) complete = false;
  micro += Math.max(0, inputTokens - explainedInput) * maxInput;

  const outText = count(outDetails.text_tokens) ?? 0;
  const outAudio = count(outDetails.audio_tokens) ?? 0;
  micro += outText * (prices.text.output ?? maxOutput) + outAudio * (prices.audio.output ?? maxOutput);
  if (outText + outAudio !== outputTokens) complete = false;
  // Output the details don't explain (OpenAI doesn't break out reasoning tokens) is priced at the dearest output rate.
  micro += Math.max(0, outputTokens - outText - outAudio) * maxOutput;

  return { usd: micro / 1_000_000, complete };
}

/**
 * Estimates one `conversation.item.input_audio_transcription.completed` usage
 * object, which OpenAI reports either as tokens or as audio duration.
 * Returns undefined when the model or the reported unit has no price.
 */
export function estimateTranscriptionCost(table: PriceTable, model: string, usage: unknown): CostEstimate | undefined {
  const prices = table.transcription[model];
  if (!prices) return undefined;
  const estimate = (usd: number, complete: boolean): CostEstimate => ({ usd, complete });
  if (!isObject(usage)) return estimate(0, false);
  if (usage.type === "duration") {
    const seconds = count(usage.seconds);
    if (prices.per_minute === undefined) return undefined;
    return seconds === undefined ? estimate(0, false) : estimate((seconds / 60) * prices.per_minute, true);
  }
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  if (prices.input === undefined || prices.output === undefined) return undefined;
  if (input === undefined || output === undefined) return estimate(0, false);
  return estimate((input * prices.input + output * prices.output) / 1_000_000, true);
}
