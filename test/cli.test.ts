import type { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main, run } from "../src/cli.js";
import { ConfigError } from "../src/config.js";
import type { Guard } from "../src/server.js";
import { API_KEY, SIGNING_SECRET, captureLogger } from "./helpers.js";

const dirs: string[] = [];
const guards: Guard[] = [];
afterEach(async () => {
  for (const guard of guards.splice(0)) await guard.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rvg-cli-"));
  dirs.push(dir);
  return dir;
}

const pricesFile = new URL("../prices.json", import.meta.url).pathname;
const baseEnv = () => ({ OPENAI_API_KEY: "fake", GUARD_SIGNING_SECRET: SIGNING_SECRET, GUARD_API_KEY: API_KEY, PRICES_FILE: pricesFile, PORT: "0", HOST: "127.0.0.1" });

describe("run", () => {
  it("fills missing settings from the env file, keeps real environment variables, and serves", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".env"), `GUARD_API_KEY=${API_KEY}\nMAX_CALL_SECONDS=120\nHOST=0.0.0.0\n`);
    const env: Record<string, string | undefined> = { ...baseEnv(), GUARD_API_KEY: undefined };
    const { logger, lines } = captureLogger();
    const guard = await run({ env, envFile: join(dir, ".env"), log: logger, now: () => Date.parse("2026-11-20") });
    guards.push(guard);
    expect(guard.context.config.maxCallSeconds).toBe(120);
    expect(guard.context.config.host).toBe("127.0.0.1"); // the real value won over the file
    const port = (guard.server.address() as { port: number }).port;
    expect(((await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { status: string }).status).toBe("ok");
    expect(lines.map((line) => line.message)).toEqual(["guard.listening"]);
  });

  it("warns when the price table is stale", async () => {
    const { logger, lines } = captureLogger();
    guards.push(await run({ env: baseEnv(), envFile: join(tempDir(), "missing.env"), log: logger, now: () => Date.parse("2027-06-01") }));
    expect(lines.some((line) => line.message === "prices.stale" && line.level === "warn")).toBe(true);
  });

  it("names the variable when config is missing", async () => {
    const error = await run({ env: { ...baseEnv(), OPENAI_API_KEY: "" }, envFile: join(tempDir(), "none") }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).variable).toBe("OPENAI_API_KEY");
    expect((error as ConfigError).message).toContain("platform.openai.com/api-keys");
  });

  it("names PORT when the port is taken", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = (blocker.address() as { port: number }).port;
    try {
      const error = await run({ env: { ...baseEnv(), PORT: String(port) }, envFile: join(tempDir(), "none"), log: captureLogger().logger }).catch((e: unknown) => e);
      expect((error as ConfigError).variable).toBe("PORT");
      expect((error as ConfigError).message).toContain("EADDRINUSE");
    } finally {
      blocker.close();
    }
  });
});

describe("main", () => {
  it("logs the failing variable and sets exit code 1 on bad config", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    await main({ env: {}, envFile: join(tempDir(), "none") });
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    expect(JSON.parse(writes[0] ?? "{}")).toMatchObject({ level: "error", msg: "guard.start_failed", variable: "OPENAI_API_KEY" });
  });

  it("hangs up and exits 0 on SIGTERM", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const emitter = process as EventEmitter;
    const events = ["SIGTERM", "SIGINT", "uncaughtException", "unhandledRejection"];
    const before = new Map(events.map((event) => [event, emitter.listeners(event).length]));
    await main({ env: baseEnv(), envFile: join(tempDir(), "none") });
    const added = new Map(events.map((event) => [event, emitter.listeners(event).slice(before.get(event))]));
    expect(added.get("SIGTERM")).toHaveLength(1);
    expect(added.get("uncaughtException")).toHaveLength(1);
    process.emit("SIGTERM");
    process.emit("SIGTERM"); // a second signal is ignored
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(exit).toHaveBeenCalledTimes(1);
    for (const [event, handlers] of added) for (const handler of handlers) emitter.off(event, handler as (...args: unknown[]) => void);
  });

  it("hangs up and exits 1 on an unexpected error", async () => {
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => lines.push(String(chunk)) > 0);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const emitter = process as EventEmitter;
    const events = ["SIGTERM", "SIGINT", "uncaughtException", "unhandledRejection"];
    const before = new Map(events.map((event) => [event, emitter.listeners(event).length]));
    await main({ env: baseEnv(), envFile: join(tempDir(), "none") });
    const added = new Map(events.map((event) => [event, emitter.listeners(event).slice(before.get(event))]));
    // Call the handler directly rather than emitting, so the test runner's own handlers stay out of it.
    (added.get("uncaughtException")?.[0] as (error: Error) => void)(new Error("boom"));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(lines.some((line) => line.includes("guard.crashed") && line.includes("boom"))).toBe(true);
    for (const [event, handlers] of added) for (const handler of handlers) emitter.off(event, handler as (...args: unknown[]) => void);
  });
});
