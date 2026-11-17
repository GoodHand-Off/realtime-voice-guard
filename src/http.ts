// Small HTTP helpers shared by the routes and the WebSocket upgrade.

import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

/** An error with an HTTP status, a stable code and a message safe to show clients. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  410: "Gone",
  429: "Too Many Requests",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

/** A short, log-safe description of an unexpected error. */
export const describeError = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : "unknown error");

export function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

export async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "too_large", "Request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Answers a refused WebSocket upgrade with a bare HTTP status and closes the socket. */
export function refuse(socket: Duplex, status: number, headers: Record<string, string> = {}): void {
  const extra = Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("");
  socket.end(`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Bad Request"}\r\n${extra}Connection: close\r\nContent-Length: 0\r\n\r\n`);
}
