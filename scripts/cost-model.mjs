// Estimates what a voice call costs, using the guard's own estimator and the
// price table in prices.json (or PRICES_FILE). Run: npm run cost-model
//
// Assumptions, from OpenAI's cost guide
// (https://developers.openai.com/api/docs/guides/voice-latency-cost?api=realtime):
//   - user audio is 1 token per 100 ms, assistant audio 1 token per 50 ms;
//   - every response re-reads the whole conversation as input;
//   - prompt caching is best-effort, so both ends are shown: every earlier
//     token cached, and nothing cached.
// Our own assumptions: turns of 10 s user speech then 10 s assistant speech,
// 1,000 tokens of instructions, 3 text tokens per second of assistant speech
// for the transcript, and history re-read as audio tokens at the rates above.
//
// It then shows what the guard reserves for one response, and the smallest cap
// a call can run under, at MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS and
// MAX_CALL_COST_USD (the defaults unless set).

import { readFileSync } from "node:fs";
import { minimumCapUsd, responseLimits, worstResponseUsd } from "../dist/budget.js";
import { buildSession } from "../dist/call.js";
import { estimateResponseCost, parsePriceTable } from "../dist/pricing.js";

// An empty PRICES_FILE (as in .env.example) means the default, as it does for the guard.
const pricesPath = process.env.PRICES_FILE?.trim() || new URL("../prices.json", import.meta.url);
const prices = parsePriceTable(JSON.parse(readFileSync(pricesPath, "utf8")));
const USER_SECONDS = 10;
const ASSISTANT_SECONDS = 10;
const INSTRUCTION_TOKENS = 1000;
const userAudio = USER_SECONDS * 10;
const assistantAudio = ASSISTANT_SECONDS * 20;
const assistantText = ASSISTANT_SECONDS * 3;

function callCost(model, minutes, cached) {
  const turns = Math.round((minutes * 60) / (USER_SECONDS + ASSISTANT_SECONDS));
  let usd = 0;
  for (let turn = 1; turn <= turns; turn++) {
    const history = (turn - 1) * (userAudio + assistantAudio);
    const audioIn = history + userAudio;
    const cachedAudio = cached ? history : 0;
    const cachedText = cached && turn > 1 ? INSTRUCTION_TOKENS : 0;
    const usage = {
      input_tokens: INSTRUCTION_TOKENS + audioIn,
      output_tokens: assistantAudio + assistantText,
      input_token_details: {
        text_tokens: INSTRUCTION_TOKENS,
        audio_tokens: audioIn,
        image_tokens: 0,
        cached_tokens: cachedText + cachedAudio,
        cached_tokens_details: { text_tokens: cachedText, audio_tokens: cachedAudio, image_tokens: 0 },
      },
      output_token_details: { text_tokens: assistantText, audio_tokens: assistantAudio },
    };
    usd += estimateResponseCost(prices, model, usage).usd;
  }
  return usd;
}

const fmt = (usd) => "$" + (usd < 1 ? usd.toFixed(3) : usd.toFixed(2));
const models = ["gpt-realtime-2.1", "gpt-realtime-2.1-mini"].filter((model) => prices.models[model]);
const header = models.map((m) => m + ", all cached | " + m + ", nothing cached").join(" | ");
console.log("Prices from " + prices.source + ", checked " + prices.checked + "\n");
console.log("| Call length | " + header + " |");
console.log("| --- | " + models.map(() => "--- | ---").join(" | ") + " |");
for (const minutes of [1, 5, 10, 30, 60]) {
  const cells = models.map((m) => fmt(callCost(m, minutes, true)) + " | " + fmt(callCost(m, minutes, false)));
  console.log("| " + minutes + " min | " + cells.join(" | ") + " |");
}
for (const model of models) {
  const p = prices.models[model];
  console.log(
    "\n" + model + ": a minute of user speech is 600 audio tokens = " + fmt((600 * p.audio.input) / 1e6) +
      "; a minute of assistant speech is 1,200 audio tokens = " + fmt((1200 * p.audio.output) / 1e6) + ".",
  );
}

const setting = (name, fallback) => Number(process.env[name]?.trim() || fallback);
const inputTokens = setting("MAX_INPUT_TOKENS", 4000);
const outputTokens = setting("MAX_OUTPUT_TOKENS", 1024);
const cap = setting("MAX_CALL_COST_USD", 1);
const usd = (value) => "$" + value.toFixed(6);
console.log(
  "\nWhat the guard reserves for one response at MAX_INPUT_TOKENS=" + inputTokens + " and MAX_OUTPUT_TOKENS=" + outputTokens +
    ", for a session without instructions (room is kept for OpenAI's defaults; the same as 1,024 bytes of your own):\n",
);
console.log("| Model | Input | Instructions | Output | One response | Smallest cap (two) | At a $" + cap.toFixed(2) + " cap, the call ends once spend passes |");
console.log("| --- | --- | --- | --- | --- | --- | --- |");
for (const model of models) {
  const p = prices.models[model];
  const limits = responseLimits(buildSession(undefined, model, outputTokens, inputTokens));
  const worst = worstResponseUsd(prices, model, limits);
  const inRate = Math.max(p.text.input, p.audio.input, p.image?.input ?? 0);
  const outRate = Math.max(p.text.output ?? 0, p.audio.output ?? 0);
  console.log(
    "| " + model +
      " | " + limits.conversationTokens.toLocaleString("en-US") + " × $" + inRate + " = " + usd((limits.conversationTokens * inRate) / 1e6) +
      " | " + limits.instructionTokens.toLocaleString("en-US") + " × $" + p.text.input + " = " + usd((limits.instructionTokens * p.text.input) / 1e6) +
      " | " + limits.outputTokens.toLocaleString("en-US") + " × $" + outRate + " = " + usd((limits.outputTokens * outRate) / 1e6) +
      " | " + usd(worst) + " | " + usd(minimumCapUsd(worst)) + " | " + usd(cap - minimumCapUsd(worst)) + " |",
  );
}
