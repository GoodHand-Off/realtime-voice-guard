// Writes .env from .env.example with two fresh random secrets, and your OpenAI
// key if OPENAI_API_KEY is set in the shell. Never overwrites an existing .env.
// Run: npm run setup   (or: OPENAI_API_KEY=sk-... npm run setup)

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const target = new URL("../.env", import.meta.url);
if (existsSync(target)) {
  console.error(".env already exists. Edit it, or delete it and run npm run setup again.");
  process.exit(1);
}

const fill = {
  GUARD_SIGNING_SECRET: randomBytes(32).toString("hex"),
  GUARD_API_KEY: randomBytes(32).toString("hex"),
  OPENAI_API_KEY: process.env.OPENAI_API_KEY?.trim() ?? "",
};
const lines = readFileSync(new URL("../.env.example", import.meta.url), "utf8")
  .split("\n")
  .map((line) => {
    const name = line.split("=")[0];
    return name in fill && line === `${name}=` ? `${name}=${fill[name]}` : line;
  });
writeFileSync(target, lines.join("\n"), { mode: 0o600 });

console.log("Wrote .env with a new GUARD_SIGNING_SECRET and GUARD_API_KEY.");
if (!fill.OPENAI_API_KEY) {
  console.log("Add your OpenAI key to the OPENAI_API_KEY line in .env (https://platform.openai.com/api-keys).");
}
console.log("Then run: npm start");
