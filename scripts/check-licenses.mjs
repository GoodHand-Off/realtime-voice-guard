// Fails if any installed package (per package-lock.json) is GPL- or AGPL-only,
// or declares no licence at all. Prints a summary by licence.
import { readFileSync } from "node:fs";

const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const counts = new Map();
const problems = [];

for (const [path, meta] of Object.entries(lock.packages ?? {})) {
  if (path === "") continue;
  const name = path.replace(/^.*node_modules\//, "");
  const license = typeof meta.license === "string" ? meta.license.trim() : "";
  counts.set(license || "(none)", (counts.get(license || "(none)") ?? 0) + 1);
  if (!license) {
    problems.push(`${name}@${meta.version}: no licence declared`);
    continue;
  }
  // An SPDX expression is acceptable if at least one OR-branch is not GPL/AGPL.
  const branches = license.replace(/[()]/g, "").split(/\s+OR\s+/i);
  const permissive = branches.some((branch) => !/\b(A?GPL|LGPL)\b/i.test(branch));
  if (!permissive) problems.push(`${name}@${meta.version}: ${license}`);
}

for (const [license, n] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(n).padStart(4)}  ${license}`);
}
if (problems.length > 0) {
  console.error(`\nLicence check failed:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`\nLicence check passed: ${[...counts.values()].reduce((a, b) => a + b, 0)} packages, none GPL- or AGPL-only.`);
