// Packs the library, installs the tarball into an empty temp project, and
// imports it four ways: ESM, CommonJS require(), TypeScript (ESM) and
// TypeScript (CommonJS, compiled and run). Run: npm run test:pack
// Needs network access to install typescript and @types/node into the temp project.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "rvg-pack-"));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const step = (name, fn) => {
  fn();
  console.log(`ok  ${name}`);
};

try {
  const tarball = join(work, run("npm", ["pack", "--silent", "--pack-destination", work], repo).split("\n").pop());
  const app = join(work, "app");
  mkdirSync(app);
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "smoke", private: true }));
  run("npm", ["install", "--silent", "--no-audit", "--no-fund", tarball, "typescript@~5.9.3", "@types/node@^22"], app);

  const env = `{ OPENAI_API_KEY: "fake", GUARD_SIGNING_SECRET: "s".repeat(40), GUARD_API_KEY: "k".repeat(40), PORT: "0", HOST: "127.0.0.1" }`;

  step("ESM import, sign and verify a ticket, start a guard", () => {
    writeFileSync(
      join(app, "esm.mjs"),
      `import { createGuard, loadConfig, signTicket, verifyTicket, silentLogger } from "realtime-voice-guard";
const t = signTicket({ id: "call_smoke_esm1", exp: Date.now() + 60000, model: "gpt-realtime-2.1-mini", maxSeconds: 60, maxCostUsd: 0.1 }, "s".repeat(40));
if (verifyTicket(t, "s".repeat(40), { now: Date.now(), maxTtlMs: 120000, maxSeconds: 600, maxCostUsd: 1 }).id !== "call_smoke_esm1") throw new Error("verify");
const guard = await createGuard(loadConfig(${env}), { log: silentLogger });
const port = await guard.listen(0, "127.0.0.1");
const health = await (await fetch("http://127.0.0.1:" + port + "/health")).json();
await guard.close();
if (health.status !== "ok") throw new Error("health");
`,
    );
    run("node", ["esm.mjs"], app);
  });

  step("CommonJS require()", () => {
    writeFileSync(
      join(app, "cjs.cjs"),
      `const lib = require("realtime-voice-guard");
for (const name of ["createGuard", "loadConfig", "signTicket", "Secret", "MemoryLedger", "RedisLedger"]) if (typeof lib[name] !== "function") throw new Error(name);
if (String(new lib.Secret("x")) !== "[redacted]") throw new Error("Secret");
`,
    );
    run("node", ["cjs.cjs"], app);
  });

  step("TypeScript, ESM project, strict NodeNext", () => {
    const dir = join(app, "ts-esm");
    mkdirSync(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: false, types: ["node"] } }));
    writeFileSync(
      join(dir, "index.ts"),
      `import { createGuard, loadConfig, type CallRecord, type GuardConfig, type TicketClaims } from "realtime-voice-guard";
const claims: TicketClaims = { id: "call_smoke_ts01", exp: Date.now() + 60000, model: "m", maxSeconds: 60, maxCostUsd: 0.1 };
export const start = async (env: Record<string, string>) => createGuard(loadConfig(env) satisfies GuardConfig);
export const cost = (record: CallRecord): number => record.costUsd;
export { claims };
`,
    );
    run("npx", ["tsc", "-p", "."], dir);
  });

  step("TypeScript, CommonJS project, compiled and run", () => {
    const dir = join(app, "ts-cjs");
    mkdirSync(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "commonjs" }));
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, outDir: "out", skipLibCheck: false, types: ["node"] } }));
    writeFileSync(
      join(dir, "index.ts"),
      `import { signTicket, Secret } from "realtime-voice-guard";
const ticket: string = signTicket({ id: "call_smoke_cjs1", exp: Date.now() + 60000, model: "m", maxSeconds: 60, maxCostUsd: 0.1 }, "s".repeat(40));
if (!ticket.startsWith("rvg1.") || String(new Secret("x")) !== "[redacted]") throw new Error("cjs");
`,
    );
    run("npx", ["tsc", "-p", "."], dir);
    run("node", [join("out", "index.js")], dir);
  });

  console.log(`\nPack smoke test passed on Node ${process.version}.`);
} catch (error) {
  console.error(`Pack smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
  if (error && typeof error === "object" && "stderr" in error) console.error(String(error.stderr));
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
