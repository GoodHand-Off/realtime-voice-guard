// Minimal "your backend": serves the page, asks the guard for a ticket, and
// reads the settled call back. No dependencies. Run from the repo root:
//   node examples/browser/server.mjs
// It needs only GUARD_API_KEY, which it takes from the environment or, failing
// that, from that one line of ./.env. The OpenAI key never enters this process.
// In a real app, check who the user is in POST /session before minting.

import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { parseEnv } from "node:util";

const GUARD_URL = (process.env.GUARD_URL ?? "http://localhost:8080").replace(/\/+$/, "");
const GUARD_API_KEY = process.env.GUARD_API_KEY || (existsSync(".env") ? parseEnv(readFileSync(".env", "utf8")).GUARD_API_KEY : undefined);
const PORT = Number(process.env.EXAMPLE_PORT ?? 3000);
if (!GUARD_API_KEY) {
  console.error("No GUARD_API_KEY: run npm run setup first, or set GUARD_API_KEY to the value the guard uses.");
  process.exit(1);
}
const page = readFileSync(new URL("./index.html", import.meta.url));
const guard = (path, init = {}) =>
  fetch(`${GUARD_URL}${path}`, { ...init, signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${GUARD_API_KEY}`, "Content-Type": "application/json", ...init.headers } });

createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page);
      return;
    }
    if (req.method === "POST" && req.url === "/session") {
      const response = await guard("/v1/tickets", {
        method: "POST",
        body: JSON.stringify({
          session: { model: "gpt-realtime-2.1-mini", instructions: "You are a friendly practice partner. Keep answers short." },
          max_seconds: 120,
          max_cost_usd: 0.25,
        }),
      });
      const ticket = await response.json();
      res.writeHead(response.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...ticket, guard_url: GUARD_URL }));
      return;
    }
    const match = /^\/calls\/([A-Za-z0-9_-]{8,64})$/.exec(req.url ?? "");
    if (req.method === "GET" && match) {
      const response = await guard(`/v1/admin/calls/${match[1]}`);
      res.writeHead(response.status, { "Content-Type": "application/json" });
      res.end(await response.text());
      return;
    }
    res.writeHead(404);
    res.end();
  } catch {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "guard_unreachable", message: `Could not reach the guard at ${GUARD_URL}` } }));
  }
}).listen(PORT, () => console.log(`Example app on http://localhost:${PORT} (guard: ${GUARD_URL})`));
