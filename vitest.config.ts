import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // main.ts is the two-line process entry; cli.ts holds its logic and is tested.
      exclude: ["src/main.ts"],
      reporter: ["text", "json-summary"],
      thresholds: { lines: 90 },
    },
  },
});
