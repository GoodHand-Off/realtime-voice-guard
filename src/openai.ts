// The four OpenAI Realtime operations the guard uses:
//   POST /v1/realtime/calls                 create a WebRTC call from an SDP offer
//   wss  /v1/realtime?call_id=...           sideband socket that sees the call's events
//   POST /v1/realtime/calls/{id}/hangup     end the call server-side
//   wss  /v1/realtime?model=...             plain WebSocket session (relay mode)

import WebSocket from "ws";
import { assertFinite, sleep } from "./util.js";

type MessageData = Buffer | ArrayBuffer | Buffer[];

/** The part of a `ws` WebSocket the guard uses. Tests inject a fake. */
export interface SocketLike {
  readonly readyState: number;
  /** Bytes queued for sending and not yet written to the network. */
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: "open", listener: () => void): unknown;
  on(event: "close", listener: (code: number) => void): unknown;
  on(event: "message", listener: (data: MessageData) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike;

export const defaultSocketFactory: SocketFactory = (url, headers) =>
  new WebSocket(url, { headers, handshakeTimeout: 10_000, maxPayload: 1_000_000 });

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface OpenAIRealtime {
  createCall(sdp: string, session: Record<string, unknown>, safetyId?: string): Promise<{ callId: string; answer: string }>;
  hangup(callId: string): Promise<void>;
  sideband(callId: string, safetyId?: string): SocketLike;
  connect(model: string, safetyId?: string): SocketLike;
}

export interface OpenAIOptions {
  apiKey: string;
  baseUrl: string;
  fetch?: typeof fetch;
  socketFactory?: SocketFactory;
  /** Delay between hang-up attempts, in milliseconds. */
  retryDelayMs?: number;
}

const PROVIDER_CALL_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function createOpenAIRealtime(options: OpenAIOptions): OpenAIRealtime {
  const fetchImpl = options.fetch ?? fetch;
  const socketFactory = options.socketFactory ?? defaultSocketFactory;
  const retryDelayMs = assertFinite("retryDelayMs", options.retryDelayMs ?? 500);
  const wsBase = options.baseUrl.replace(/^http/, "ws");
  const headers = (safetyId?: string): Record<string, string> => ({
    Authorization: `Bearer ${options.apiKey}`,
    ...(safetyId ? { "OpenAI-Safety-Identifier": safetyId } : {}),
  });

  return {
    async createCall(sdp, session, safetyId) {
      const form = new FormData();
      form.set("sdp", sdp);
      form.set("session", JSON.stringify(session));
      const response = await fetchImpl(`${options.baseUrl}/v1/realtime/calls`, {
        method: "POST",
        headers: headers(safetyId),
        body: form,
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProviderError(`OpenAI rejected the call (${response.status})`, response.status);
      }
      const callId = response.headers.get("location")?.split("/").pop();
      if (!callId || !PROVIDER_CALL_ID.test(callId)) throw new ProviderError("OpenAI response had no call id");
      return { callId, answer: await response.text() };
    },

    async hangup(callId) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetchImpl(`${options.baseUrl}/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`, {
            method: "POST",
            headers: headers(),
            signal: AbortSignal.timeout(10_000),
          });
          await response.body?.cancel();
          // 404 means the call is already gone, which is the goal.
          if (response.ok || response.status === 404) return;
        } catch {
          // Network error or timeout: retry.
        }
        if (attempt < 2) await sleep(retryDelayMs * (attempt + 1));
      }
      throw new ProviderError("Hang-up not confirmed after 3 attempts");
    },

    sideband(callId, safetyId) {
      return socketFactory(`${wsBase}/v1/realtime?call_id=${encodeURIComponent(callId)}`, headers(safetyId));
    },

    connect(model, safetyId) {
      return socketFactory(`${wsBase}/v1/realtime?model=${encodeURIComponent(model)}`, headers(safetyId));
    },
  };
}
