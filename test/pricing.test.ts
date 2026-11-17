import { describe, expect, it } from "vitest";
import { estimateResponseCost, estimateTranscriptionCost, parsePriceTable, reportsUsage } from "../src/pricing.js";
import { PRICES } from "./helpers.js";

const usage = (input: Record<string, number>, cached: Record<string, number>, output: Record<string, number>) => ({
  input_tokens: Object.values(input).reduce((a, b) => a + b, 0),
  output_tokens: Object.values(output).reduce((a, b) => a + b, 0),
  input_token_details: { ...input, cached_tokens: Object.values(cached).reduce((a, b) => a + b, 0), cached_tokens_details: cached },
  output_token_details: output,
});

describe("response cost", () => {
  it("prices each modality, cached and uncached", () => {
    // gpt-realtime-2.1: text 4 / 0.4 / 24, audio 32 / 0.4 / 64 (USD per 1M)
    const estimate = estimateResponseCost(PRICES, "gpt-realtime-2.1", usage({ text_tokens: 1000, audio_tokens: 600 }, { text_tokens: 800, audio_tokens: 0 }, { text_tokens: 50, audio_tokens: 1200 }));
    const expected = (200 * 4 + 800 * 0.4 + 600 * 32 + 50 * 24 + 1200 * 64) / 1e6;
    expect(estimate?.complete).toBe(true);
    expect(estimate?.usd).toBeCloseTo(expected, 12);
  });

  it("returns undefined for a model with no price entry", () => {
    expect(estimateResponseCost(PRICES, "gpt-unknown", usage({ text_tokens: 1 }, {}, { text_tokens: 1 }))).toBeUndefined();
  });

  it("charges unexplained tokens at the highest rate and marks the estimate incomplete", () => {
    const estimate = estimateResponseCost(PRICES, "gpt-realtime-2.1-mini", { input_tokens: 100, output_tokens: 10 });
    expect(estimate).toEqual({ usd: (100 * 10 + 10 * 20) / 1e6, complete: false });
  });

  it("treats cached tokens without a breakdown as uncached", () => {
    const estimate = estimateResponseCost(PRICES, "gpt-realtime-2.1-mini", {
      input_tokens: 100,
      output_tokens: 0,
      input_token_details: { audio_tokens: 100, cached_tokens: 100 },
      output_token_details: {},
    });
    expect(estimate?.usd).toBeCloseTo((100 * 10) / 1e6, 12);
  });

  it("marks missing or malformed usage as incomplete at zero, and reportsUsage tells it apart", () => {
    expect(estimateResponseCost(PRICES, "gpt-realtime-2.1-mini", undefined)).toEqual({ usd: 0, complete: false });
    expect(estimateResponseCost(PRICES, "gpt-realtime-2.1-mini", { input_tokens: -1, output_tokens: 2 })).toEqual({ usd: 0, complete: false });
    expect(reportsUsage(undefined)).toBe(false);
    expect(reportsUsage({ input_tokens: -1, output_tokens: 2 })).toBe(false);
    expect(reportsUsage({ input_tokens: 0, output_tokens: 0 })).toBe(true);
  });
});

describe("transcription cost", () => {
  it("prices token usage and duration usage", () => {
    expect(estimateTranscriptionCost(PRICES, "gpt-4o-mini-transcribe", { type: "tokens", input_tokens: 13, output_tokens: 9, total_tokens: 22 })?.usd).toBeCloseTo(
      (13 * 1.25 + 9 * 5) / 1e6,
      12,
    );
    expect(estimateTranscriptionCost(PRICES, "gpt-transcribe", { type: "duration", seconds: 30 })?.usd).toBeCloseTo(0.00225, 12);
  });

  it("returns undefined when the model or unit is not priced", () => {
    expect(estimateTranscriptionCost(PRICES, "mystery-asr", { type: "duration", seconds: 3 })).toBeUndefined();
    expect(estimateTranscriptionCost(PRICES, "gpt-transcribe", { type: "tokens", input_tokens: 1, output_tokens: 1 })).toBeUndefined();
  });
});

describe("price table", () => {
  it("accepts the shipped table", () => {
    expect(PRICES.models["gpt-realtime-2.1"]?.audio.output).toBe(64);
    expect(PRICES.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("rejects bad tables with the offending path", () => {
    expect(() => parsePriceTable({})).toThrow("source");
    expect(() => parsePriceTable({ source: "x", checked: "y", models: {} })).toThrow("at least one");
    expect(() => parsePriceTable({ source: "x", checked: "y", models: { m: { text: { input: 1, output: 1 }, audio: { input: -1, output: 1 } } } })).toThrow("models.m.audio.input");
    expect(() => parsePriceTable({ source: "x", checked: "y", models: { m: { text: { input: 1, output: 1 }, audio: { input: 1, output: 1 } } }, transcription: { t: { input: 1 } } })).toThrow(
      "transcription.t",
    );
  });
});
