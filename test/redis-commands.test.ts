// The node-redis adapter, checked against a stand-in with node-redis v5's
// call signatures and reply types. The real-server contract runs in
// ledger.test.ts when REDIS_URL is set.

import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config.js";
import { connectRedisLedger, nodeRedisCommands, type NodeRedisClient } from "../src/redis-ledger.js";
import { captureLogger } from "./helpers.js";

function fakeClient(replies: Partial<Record<keyof NodeRedisClient, unknown>> = {}) {
  const calls: Array<[string, unknown[]]> = [];
  const handler = (name: keyof NodeRedisClient) => async (...args: unknown[]) => {
    calls.push([name, args]);
    return replies[name];
  };
  const names: Array<keyof NodeRedisClient> = ["set", "getDel", "exists", "hSet", "hSetNX", "hGetAll", "hIncrByFloat", "hIncrBy", "sAdd", "pExpire", "zAdd", "zRem", "zRangeByScore", "time", "ping", "close"];
  const client = Object.fromEntries(names.map((name) => [name, handler(name)])) as unknown as NodeRedisClient;
  return { client, calls };
}

describe("nodeRedisCommands", () => {
  it("sends node-redis v5 argument shapes and maps replies", async () => {
    const { client, calls } = fakeClient({
      set: "OK",
      getDel: "value",
      exists: 1,
      hSetNX: 1,
      hGetAll: { id: "x" },
      hIncrByFloat: "0.25",
      hIncrBy: 3,
      sAdd: 1,
      zRangeByScore: ["a", "b"],
    });
    const redis = nodeRedisCommands(client);
    expect(await redis.setIfAbsent("k", "v", 500)).toBe(true);
    expect(await redis.getDel("k")).toBe("value");
    expect(await redis.exists("k")).toBe(true);
    await redis.hSet("h", { a: "1" });
    expect(await redis.hSetIfAbsent("h", "f", "v")).toBe(true);
    expect(await redis.hGetAll("h")).toEqual({ id: "x" });
    expect(await redis.hIncrByFloat("h", "f", 0.25)).toBe(0.25);
    expect(await redis.hIncrBy("h", "f", 1)).toBe(3);
    expect(await redis.sAdd("s", "m")).toBe(true);
    await redis.pExpire("k", 1000);
    await redis.zAdd("z", 5, "m");
    await redis.zRem("z", "m");
    expect(await redis.zRangeByScore("z", 10)).toEqual(["a", "b"]);
    await redis.quit();
    expect(calls).toEqual([
      ["set", ["k", "v", { condition: "NX", expiration: { type: "PX", value: 500 } }]],
      ["getDel", ["k"]],
      ["exists", ["k"]],
      ["hSet", ["h", { a: "1" }]],
      ["hSetNX", ["h", "f", "v"]],
      ["hGetAll", ["h"]],
      ["hIncrByFloat", ["h", "f", 0.25]],
      ["hIncrBy", ["h", "f", 1]],
      ["sAdd", ["s", "m"]],
      ["pExpire", ["k", 1000]],
      ["zAdd", ["z", { score: 5, value: "m" }]],
      ["zRem", ["z", "m"]],
      ["zRangeByScore", ["z", "-inf", 10]],
      ["close", []],
    ]);
  });

  it("maps empty and negative replies", async () => {
    const { client } = fakeClient({ set: null, getDel: null, exists: 0, hSetNX: 0, hGetAll: null, sAdd: 0, zRangeByScore: null });
    const redis = nodeRedisCommands(client);
    expect(await redis.setIfAbsent("k", "v", 1)).toBe(false);
    expect(await redis.getDel("k")).toBeNull();
    expect(await redis.exists("k")).toBe(false);
    expect(await redis.hSetIfAbsent("h", "f", "v")).toBe(false);
    expect(await redis.hGetAll("h")).toEqual({});
    expect(await redis.sAdd("s", "m")).toBe(false);
    expect(await redis.zRangeByScore("z", 1)).toEqual([]);
  });

  it("reads TIME as milliseconds and answers PING", async () => {
    const { client, calls } = fakeClient({ time: ["1700000000", "123456"], ping: "PONG" });
    const redis = nodeRedisCommands(client);
    expect(await redis.time()).toBe(1_700_000_000_123);
    await redis.ping();
    expect(calls.map(([name]) => name)).toEqual(["time", "ping"]);
    await expect(nodeRedisCommands(fakeClient({ time: "garbage" }).client).time()).rejects.toThrow("unexpected reply");
  });

  it("falls back to quit() on clients without close()", async () => {
    let quit = 0;
    const redis = nodeRedisCommands({ quit: async () => void quit++ } as unknown as NodeRedisClient);
    await redis.quit();
    expect(quit).toBe(1);
  });

  it("fails a command that hangs instead of waiting forever", async () => {
    const client = { hGetAll: () => new Promise(() => {}) } as unknown as NodeRedisClient;
    await expect(nodeRedisCommands(client, 20).hGetAll("h")).rejects.toThrow("HGETALL timed out");
  });
});

describe("connectRedisLedger", () => {
  it("names REDIS_URL when Redis does not answer", async () => {
    const { logger } = captureLogger();
    const error = await connectRedisLedger("redis://127.0.0.1:1", "rvg:", logger, 300).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).variable).toBe("REDIS_URL");
  });
});
