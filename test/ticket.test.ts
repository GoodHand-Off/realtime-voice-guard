import { describe, expect, it } from "vitest";
import { TicketError, signTicket, verifyTicket, type TicketClaims } from "../src/ticket.js";
import { SIGNING_SECRET } from "./helpers.js";

const now = 1_800_000_000_000;
const limits = { now, maxTtlMs: 120_000, maxSeconds: 600, maxCostUsd: 1 };
const claims = (extra: Partial<TicketClaims> = {}): TicketClaims => ({
  id: "call_ticket_1",
  exp: now + 60_000,
  model: "gpt-realtime-2.1-mini",
  maxSeconds: 300,
  maxCostUsd: 0.5,
  ...extra,
});

describe("tickets", () => {
  it("round-trips signed claims", () => {
    const ticket = signTicket(claims({ sid: "user-hash", session: { instructions: "Be brief." } }), SIGNING_SECRET);
    expect(ticket.startsWith("rvg1.")).toBe(true);
    expect(verifyTicket(ticket, SIGNING_SECRET, limits)).toMatchObject({ id: "call_ticket_1", maxSeconds: 300, sid: "user-hash" });
  });

  it("rejects a wrong key, a tampered payload, a wrong version and junk", () => {
    const ticket = signTicket(claims(), SIGNING_SECRET);
    const [, payload, signature] = ticket.split(".");
    const forged = Buffer.from(JSON.stringify(claims({ maxCostUsd: 1 }))).toString("base64url");
    expect(() => verifyTicket(ticket, `${SIGNING_SECRET}x`, limits)).toThrow(TicketError);
    expect(() => verifyTicket(`rvg1.${forged}.${signature}`, SIGNING_SECRET, limits)).toThrow(TicketError);
    expect(() => verifyTicket(`rvg2.${payload}.${signature}`, SIGNING_SECRET, limits)).toThrow(TicketError);
    expect(() => verifyTicket(`${ticket}.extra`, SIGNING_SECRET, limits)).toThrow(TicketError);
    expect(() => verifyTicket("", SIGNING_SECRET, limits)).toThrow(TicketError);
    expect(() => verifyTicket("x".repeat(9000), SIGNING_SECRET, limits)).toThrow(TicketError);
  });

  it("rejects a signed payload that is not JSON", () => {
    const payload = Buffer.from("not json").toString("base64url");
    const good = signTicket(claims(), SIGNING_SECRET).split(".")[2] as string;
    expect(() => verifyTicket(`rvg1.${payload}.${good}`, SIGNING_SECRET, limits)).toThrow(TicketError);
  });

  it("enforces expiry and maximum lifetime", () => {
    expect(() => verifyTicket(signTicket(claims({ exp: now - 1 }), SIGNING_SECRET), SIGNING_SECRET, limits)).toThrow("expired");
    expect(() => verifyTicket(signTicket(claims({ exp: now + 10 * 60_000 }), SIGNING_SECRET), SIGNING_SECRET, limits)).toThrow("lifetime");
  });

  it("enforces the server's duration and spend ceilings", () => {
    const check = (extra: Partial<TicketClaims>) => () => verifyTicket(signTicket(claims(extra), SIGNING_SECRET), SIGNING_SECRET, limits);
    expect(check({ maxSeconds: 601 })).toThrow("duration");
    expect(check({ maxSeconds: 0 })).toThrow("duration");
    expect(check({ maxSeconds: 1.5 })).toThrow("duration");
    expect(check({ maxCostUsd: 1.01 })).toThrow("spend");
    expect(check({ maxCostUsd: 0 })).toThrow("spend");
    expect(check({ id: "short" })).toThrow(TicketError);
    expect(check({ model: "bad model" })).toThrow(TicketError);
  });

  it("refuses short secrets", () => {
    expect(() => signTicket(claims(), "short")).toThrow("at least 32");
    expect(() => verifyTicket("rvg1.a.b", "short", limits)).toThrow("at least 32");
  });
});
