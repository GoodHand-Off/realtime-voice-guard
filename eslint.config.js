import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "coverage/"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      "no-console": "error",
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    files: ["scripts/**/*.mjs", "examples/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly", fetch: "readonly", Buffer: "readonly", AbortSignal: "readonly" } },
    rules: { "no-console": "off" },
  },
);
