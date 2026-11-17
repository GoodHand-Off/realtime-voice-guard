# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-17

### Added

- WebRTC path: `POST /v1/realtime/calls` takes an SDP offer and a ticket, creates
  the call at OpenAI, attaches a sideband monitor, and returns the answer only
  once the monitor is connected.
- WebSocket relay at `/v1/realtime` for native and server clients, with a
  client-event allow-list, a forced output-token cap, and an inbound limit of
  100 frames a second and 2 MiB at once refilled at 256 KiB a second. A
  `response.create` that brings its own `input`, `instructions`, `tools`,
  `tool_choice` or `prompt`, or asks for an out-of-band response, is answered
  with `response_field_not_allowed` and not forwarded. A `response.create` that
  OpenAI neither starts nor refuses within 10 seconds ends the call.
- Per-call caps on duration, estimated spend and response count, plus a
  concurrency cap. Calls end server-side through OpenAI's hang-up endpoint.
- Signed, single-use, short-lived tickets (`rvg1`), minted by `POST /v1/tickets`
  or by your own backend with `signTicket`.
- Spend estimates from each `response.done` and transcription usage event, using
  a price table you supply (`prices.json`, checked 2026-11-17).
- Ledger interface with an in-memory ledger and a Redis ledger, a heartbeat, a
  watchdog that hangs up calls whose owning instance died, admin read and stop
  routes, and an optional signed settlement webhook.
- A call is settled only after OpenAI confirms the hang-up; until then the guard
  keeps metering and retrying, up to OpenAI's 60-minute session limit.
- Graceful shutdown that stops admissions and hangs up every live call, and a
  last-resort handler that does the same on an unexpected error.
- Per-address rate limits and origin checks on the public routes.
- `npm run setup` writes a `.env` with fresh secrets; the guard reads `.env` on
  start without copying it into `process.env`, and every bad setting fails fast
  with a `ConfigError` naming the variable and where to get a value.
- Spend control is "observed + reserved spend". Each running response reserves
  its true worst case: the input limit (`MAX_INPUT_TOKENS`, default 4,000,
  forced as OpenAI's truncation limit) at the model's dearest input rate, the
  instructions and tools at the text rate, and the output cap at the dearest
  output rate. The call ends while one more worst-case response would still
  fit, one response runs at a time (extras are cancelled or refused), and a
  response that reports no usage, or never reports, is charged its reservation.
- The bound on estimated spend: in relay mode, at or under the cap; in WebRTC
  mode, the cap plus what extra responses the browser starts while the hang-up
  lands are charged, plus what a response the browser creates itself is
  charged for its own input, instructions, tools or output cap before the
  cancel lands. A response that `response.created` shows with a raised cap,
  other instructions or a stored prompt is cancelled and ends the call; one
  whose cap it doesn't show is reserved at 4,096 tokens. In both, input transcription is metered, not
  reserved, so the transcription of the user's last turn can land on top
  (README, "The bound", has the exact terms). Not verified without a live call: whether OpenAI bills the input of cancelled
  responses, whether those report usage, and how a response's own input interacts
  with truncation.
- A spend cap below two worst-case responses is refused: `MAX_CALL_COST_USD`
  at startup (against every priced model), `max_cost_usd` at mint, and a
  self-signed ticket's cap at the offer, including one that claims a stored
  session. Stored prompts (`session.prompt`) and MCP tools are refused because
  their instructions or tool definitions can't be counted.
- In WebRTC mode, a `session.updated` that changes the instructions, tools or
  stored prompt ends the call, as one that switches model, lifts the input
  limit or raises the output cap already did.
- When a call starts to end, the guard turns off automatic turns and
  transcription and cancels running responses first, before the hang-up, and
  cancels new responses as they start.
- `GET /ready`; admin stop answers 202 at once; shutdown honours
  `SHUTDOWN_GRACE_SECONDS`; one missed heartbeat is tolerated.
- `TRUSTED_PROXIES` (a hop count) replaces `TRUST_PROXY`, and the client
  address is taken from the right of `X-Forwarded-For`. IPv6 clients are
  rate-limited per /64, and a flood of new addresses can't evict a limited
  client's window.
- Relay backpressure (`slow_client`), a printable-ASCII `safety_identifier`,
  30 seconds of clock-skew allowance, ticket issue times, and Redis `TIME` for
  every timestamp in the Redis ledger. The in-memory ledger refuses tickets
  issued before the instance started, with no skew allowance.
- The package works with `require()` on Node 22.12+, builds on `git` installs,
  and ships without source maps.
- Keys are held in `Secret` objects (an ES `#private` field) that print
  `[redacted]` in logs, JSON and `util.inspect`. Configs built in code are
  checked by `assertConfig`, and every numeric option must be finite.
