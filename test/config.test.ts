import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { API_KEY, SIGNING_SECRET } from "./helpers.js";

const prices = readFileSync(new URL("../prices.json", import.meta.url), "utf8");
const read = () => prices;
const base = { OPENAI_API_KEY: "fake", GUARD_SIGNING_SECRET: SIGNING_SECRET, GUARD_API_KEY: API_KEY };

describe("config", () => {
  it("applies defaults", () => {
    const config = loadConfig(base, read);
    expect(config).toMatchObject({
      openaiBaseUrl: "https://api.openai.com",
      port: 8080,
      maxCallSeconds: 600,
      maxCallCostUsd: 1,
      maxOutputTokens: 1024,
      maxInputTokens: 4000,
      allowedOrigins: [],
    });
    expect(config.redisUrl).toBeUndefined();
  });

  it("reads every cap from the environment", () => {
    const config = loadConfig(
      { ...base, MAX_CALL_SECONDS: "120", MAX_CALL_COST_USD: "0.25", MAX_INPUT_TOKENS: "1000", MAX_OUTPUT_TOKENS: "512", MAX_CONCURRENT_CALLS: "3", ALLOWED_ORIGINS: "https://a.example, https://b.example/", REDIS_URL: "redis://localhost:6379" },
      read,
    );
    expect(config).toMatchObject({ maxCallSeconds: 120, maxCallCostUsd: 0.25, maxInputTokens: 1000, maxOutputTokens: 512, maxConcurrentCalls: 3, allowedOrigins: ["https://a.example", "https://b.example"] });
    expect(config.redisUrl?.reveal()).toBe("redis://localhost:6379");
  });

  it("fails fast on missing or weak settings", () => {
    expect(() => loadConfig({ ...base, OPENAI_API_KEY: "" }, read)).toThrow("OPENAI_API_KEY");
    expect(() => loadConfig({ ...base, GUARD_SIGNING_SECRET: "short" }, read)).toThrow("GUARD_SIGNING_SECRET");
    expect(() => loadConfig({ ...base, GUARD_API_KEY: SIGNING_SECRET }, read)).toThrow("must be different");
    expect(() => loadConfig({ ...base, MAX_CALL_SECONDS: "7200" }, read)).toThrow("MAX_CALL_SECONDS");
    expect(() => loadConfig({ ...base, MAX_OUTPUT_TOKENS: "abc" }, read)).toThrow("MAX_OUTPUT_TOKENS");
    expect(() => loadConfig({ ...base, OPENAI_BASE_URL: "http://example.com" }, read)).toThrow("https");
    expect(() => loadConfig({ ...base, SETTLE_WEBHOOK_URL: "https://hooks.example.com/settled" }, read)).toThrow("SETTLE_WEBHOOK_SECRET");
    expect(() => loadConfig(base, () => "{")).toThrow("PRICES_FILE");
  });

  it("refuses a default spend cap that can't cover two worst-case responses on every priced model", () => {
    // At the default 4,000 input and 1,024 output tokens, two worst cases on gpt-realtime-2.1 come to about $0.40.
    let error: unknown;
    try {
      loadConfig({ ...base, MAX_CALL_COST_USD: "0.25" }, read);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).variable).toBe("MAX_CALL_COST_USD");
    expect((error as ConfigError).message).toMatch(/must be at least \$0\.39\d\d for gpt-realtime-2\.1/);
    for (const name of ["MAX_INPUT_TOKENS", "MAX_OUTPUT_TOKENS", "PRICES_FILE"]) expect((error as ConfigError).message).toContain(name);
    // The defaults themselves fit.
    expect(loadConfig(base, read).maxCallCostUsd).toBe(1);
  });
});
