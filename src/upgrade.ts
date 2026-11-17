// WS /v1/realtime: checks the upgrade, claims the ticket, then hands the
// socket to the relay. Every refusal is a bare HTTP status before the 101.

import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { Admission } from "./admission.js";
import type { GuardContext } from "./call.js";
import { HttpError, describeError, refuse } from "./http.js";
import type { SocketLike } from "./openai.js";
import { relayWebSocket } from "./relay.js";

const WEBSOCKET_KEY = /^[+/0-9A-Za-z]{22}==$/;

export function attachRelay(server: Server, ctx: GuardContext, admission: Admission): { close(): void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 262_144 });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Node removes its own error handler before 'upgrade'; without one, a client reset crashes the process.
    socket.on("error", () => socket.destroy());
    if (req.url?.split("?")[0] !== "/v1/realtime") {
      refuse(socket, 404);
      return;
    }
    const release = admission.enter();
    let upgraded = false;
    Promise.resolve()
      .then(async () => {
        if (!admission.cors(req)) throw new HttpError(403, "origin_not_allowed", "Origin not allowed");
        admission.limit(req);
        const key = req.headers["sec-websocket-key"];
        const version = req.headers["sec-websocket-version"];
        // Check the handshake before claiming, so a malformed upgrade cannot burn a ticket.
        if (req.headers.upgrade?.toLowerCase() !== "websocket" || typeof key !== "string" || !WEBSOCKET_KEY.test(key) || (version !== "13" && version !== "8")) {
          throw new HttpError(400, "bad_upgrade", "Not a valid WebSocket upgrade");
        }
        const claims = admission.precheck(req);
        const session = await admission.claim(claims);
        if (socket.destroyed) {
          // The client left while the ticket was being claimed.
          release();
          await admission.settleUnconnected(claims.id);
          return;
        }
        socket.once("close", () => {
          release();
          if (!upgraded) void admission.settleUnconnected(claims.id);
        });
        wss.handleUpgrade(req, socket, head, (client) => {
          upgraded = true;
          release();
          // relayWebSocket never throws: a failed upstream connect ends the call itself.
          relayWebSocket(ctx, claims, session, client as unknown as SocketLike);
        });
      })
      .catch((error: unknown) => {
        release();
        if (upgraded) return; // the 101 has gone out; the relay owns the socket now
        if (error instanceof HttpError) refuse(socket, error.status, error.headers);
        else {
          ctx.log.error("upgrade.failed", { error: describeError(error) });
          refuse(socket, 500);
        }
      });
  });

  return { close: () => wss.close() };
}
