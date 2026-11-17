// The two ways a call reaches OpenAI through the guard.
//   WebRTC: the guard creates the call, attaches a sideband socket, and only
//           then returns the SDP answer. Media flows browser <-> OpenAI.
//   WebSocket relay: for native or server clients. Every event passes through
//           the guard, which filters what the client may send.

import { randomUUID } from "node:crypto";
import { Call, buildSession, dataToString, parseEvent, type GuardContext } from "./call.js";
import { describeError } from "./http.js";
import type { SessionConfig } from "./ledger.js";
import { ProviderError, type SocketLike } from "./openai.js";
import type { TicketClaims } from "./ticket.js";

type MessageData = Buffer | ArrayBuffer | Buffer[];

const OPEN = 1;
const MAX_FRAMES_PER_SECOND = 100;
const MAX_QUEUED_BYTES = 262_144;
/**
 * Client bytes the relay accepts: a burst of 2 MiB, refilled at 256 KiB a second.
 * That is about four times real-time 24 kHz PCM16 audio in base64, with room to
 * send a recorded clip at once. More ends the call with `policy`.
 */
const MAX_INBOUND_BURST_BYTES = 2 * 1024 * 1024;
const MAX_INBOUND_BYTES_PER_SECOND = 256 * 1024;
/** A side that stops reading may not make the guard hold more than this for it. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
/**
 * A response.create OpenAI neither starts nor rejects (by event_id) within this
 * long ends the call as `monitor_lost`: the relay can no longer tell how many
 * responses OpenAI may start, so it stops rather than forward another.
 */
const RESPONSE_START_TIMEOUT_MS = 10_000;
/**
 * The `response` fields a client may set. Others (input, instructions, tools,
 * tool_choice, prompt, or a conversation other than "auto") would let one
 * response read more than the guard reserved for it.
 */
const RESPONSE_FIELDS: ReadonlySet<string> = new Set(["audio", "conversation", "max_output_tokens", "metadata", "output_modalities"]);
const clientError = (code: string, message: string) => JSON.stringify({ type: "error", error: { type: "invalid_request_error", code, message } });
const RESPONSE_IN_PROGRESS = clientError("response_in_progress", "realtime-voice-guard runs one response at a time; wait for response.done before sending response.create");
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const byteLength = (data: MessageData): number => (Array.isArray(data) ? data.reduce((sum, part) => sum + part.length, 0) : data.byteLength);
/** Client events the relay forwards. session.update is not one: the session is fixed by the ticket. */
const CLIENT_EVENTS: ReadonlySet<string> = new Set([
  "input_audio_buffer.append",
  "input_audio_buffer.commit",
  "input_audio_buffer.clear",
  "conversation.item.create",
  "conversation.item.retrieve",
  "conversation.item.truncate",
  "conversation.item.delete",
  "response.create",
  "response.cancel",
]);

function waitForOpen(socket: SocketLike, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Sideband connection timed out")), timeoutMs);
    const fail = () => {
      clearTimeout(timer);
      reject(new Error("Sideband connection failed"));
    };
    socket.on("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.on("error", fail);
    socket.on("close", fail);
  });
}

/** Returns the SDP answer only once the sideband monitor is connected. */
export async function openWebRTCCall(ctx: GuardContext, claims: TicketClaims, base: SessionConfig | undefined, sdp: string): Promise<string> {
  const call = new Call(ctx, claims, buildSession(base, claims.model, ctx.config.maxOutputTokens, ctx.config.maxInputTokens), "webrtc");
  try {
    const { callId, answer } = await ctx.openai.createCall(sdp, call.session, claims.sid);
    if (call.ended) {
      // Stopped while OpenAI was creating the call: end it there too.
      await ctx.openai.hangup(callId).catch((error: unknown) => ctx.log.error("call.hangup_unconfirmed", { call: call.id, providerCall: callId, attempt: 1, error: describeError(error) }));
      throw new Error("Call stopped during setup");
    }
    await call.bind(callId);
    const sideband = ctx.openai.sideband(callId, claims.sid);
    call.attach(sideband);
    await waitForOpen(sideband, 10_000);
    if (call.ended) throw new Error("Monitor closed during setup");
    call.start();
    ctx.log.info("call.started", { call: call.id, transport: "webrtc", model: claims.model, maxSeconds: claims.maxSeconds, maxCostUsd: claims.maxCostUsd });
    return answer;
  } catch (error) {
    await call.finish(error instanceof ProviderError ? "provider_error" : "monitor_lost");
    throw error;
  }
}

export function relayWebSocket(ctx: GuardContext, claims: TicketClaims, base: SessionConfig | undefined, client: SocketLike): Call {
  const session = buildSession(base, claims.model, ctx.config.maxOutputTokens, ctx.config.maxInputTokens);
  const call = new Call(ctx, claims, session, "websocket");
  let upstream: SocketLike;
  try {
    upstream = ctx.openai.connect(claims.model, claims.sid);
  } catch (error) {
    ctx.log.error("call.upstream_failed", { call: call.id, error: describeError(error) });
    client.close(1011, "upstream unavailable");
    void call.finish("provider_error");
    return call;
  }
  // The response.create forwarded and not yet started or rejected by OpenAI: its event_id, and the timer that gives up on it.
  let pendingCreate: { eventId: string; timer: NodeJS.Timeout } | undefined;
  const settleCreate = () => {
    clearTimeout(pendingCreate?.timer);
    pendingCreate = undefined;
  };
  let ready = false; // session.updated seen
  let flowing = false; // bound and timers running: client events go straight upstream
  let queue: string[] = [];
  let queuedBytes = 0;
  let frames = 0;
  let windowStart = Date.now();
  let inbound = MAX_INBOUND_BURST_BYTES;
  let inboundAt = Date.now();
  const policy = (event: string) => {
    ctx.log.warn("call.policy", { call: call.id, event });
    void call.finish("policy");
  };
  const readyTimer = setTimeout(() => {
    if (!ready) void call.finish("provider_error");
  }, 15_000);
  readyTimer.unref();

  call.attach(upstream, client, (event, data) => {
    // Only the start of a response, or an error OpenAI ties to our response.create, clears the wait.
    if (event.type === "response.created" || (event.type === "error" && isObject(event.error) && event.error.event_id === pendingCreate?.eventId)) settleCreate();
    if (event.type === "session.updated" && !ready && !call.ended) {
      ready = true;
      clearTimeout(readyTimer);
      call
        .bind(`ws:${call.id}`)
        .then(() => {
          if (call.ended) return;
          call.start();
          flowing = true;
          for (const item of queue) upstream.send(item);
          queue = [];
          ctx.log.info("call.started", { call: call.id, transport: "websocket", model: claims.model, maxSeconds: claims.maxSeconds, maxCostUsd: claims.maxCostUsd });
        })
        .catch(() => void call.finish("monitor_lost"));
    }
    if (client.readyState !== OPEN) return;
    if (client.bufferedAmount > MAX_BUFFERED_BYTES) {
      ctx.log.warn("call.slow_client", { call: call.id, buffered: client.bufferedAmount });
      void call.finish("slow_client");
      return;
    }
    client.send(dataToString(data));
  });

  upstream.on("open", () => {
    // The model is fixed by the connection URL; everything else comes from the ticket.
    const update: SessionConfig = { ...session };
    delete update.model;
    upstream.send(JSON.stringify({ type: "session.update", session: update }));
  });

  client.on("message", (data) => {
    if (call.ended) return;
    const now = Date.now();
    if (now - windowStart > 1000) {
      frames = 0;
      windowStart = now;
    }
    inbound = Math.min(MAX_INBOUND_BURST_BYTES, inbound + ((now - inboundAt) * MAX_INBOUND_BYTES_PER_SECOND) / 1000) - byteLength(data);
    inboundAt = now;
    if (inbound < 0) {
      policy("inbound_rate");
      return;
    }
    const event = ++frames > MAX_FRAMES_PER_SECOND ? undefined : parseEvent(data);
    if (!event || typeof event.type !== "string" || !CLIENT_EVENTS.has(event.type)) {
      policy(typeof event?.type === "string" ? event.type : "invalid");
      return;
    }
    if (event.type === "response.create") {
      if (call.responding || pendingCreate) {
        // One response at a time, so concurrent responses can't outrun the spend cap.
        if (client.readyState === OPEN) client.send(RESPONSE_IN_PROGRESS);
        return;
      }
      const response = isObject(event.response) ? event.response : {};
      const refused = Object.keys(response).filter((key) => !RESPONSE_FIELDS.has(key) || (key === "conversation" && response.conversation !== "auto"));
      if (refused.length > 0) {
        if (client.readyState === OPEN) {
          client.send(clientError("response_field_not_allowed", `realtime-voice-guard does not forward response.${refused.join(", response.")}: a response may use only the session's instructions, tools and conversation`));
        }
        return;
      }
      const asked = response.max_output_tokens;
      const cap = typeof asked === "number" && Number.isInteger(asked) && asked >= 1 ? Math.min(asked, call.outputCap) : call.outputCap;
      // Our own event_id, so an error OpenAI ties to this response.create can be told apart from any other.
      const eventId = `rvg_${randomUUID()}`;
      const timer = setTimeout(() => {
        if (call.ended) return;
        ctx.log.warn("call.response_start_lost", { call: call.id, afterMs: RESPONSE_START_TIMEOUT_MS });
        void call.finish("monitor_lost");
      }, RESPONSE_START_TIMEOUT_MS);
      timer.unref();
      pendingCreate = { eventId, timer };
      event.event_id = eventId;
      event.response = { ...response, max_output_tokens: cap };
    }
    const text = JSON.stringify(event);
    if (flowing && upstream.readyState === OPEN) {
      if (upstream.bufferedAmount > MAX_BUFFERED_BYTES) {
        ctx.log.warn("call.upstream_backlog", { call: call.id, buffered: upstream.bufferedAmount });
        void call.finish("provider_error");
        return;
      }
      upstream.send(text);
      return;
    }
    queuedBytes += Buffer.byteLength(text);
    if (queuedBytes > MAX_QUEUED_BYTES) {
      policy("queue_full");
      return;
    }
    queue.push(text);
  });
  client.on("close", () => void call.finish("ended"));
  client.on("error", () => void call.finish("monitor_lost"));
  return call;
}
