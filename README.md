# realtime-voice-guard

**Stop a voice AI call from running up your bill.** A small Node service that sits between your app and the OpenAI Realtime API, gives every call a time limit and a spend limit, and hangs up on OpenAI's side when either one is reached. Your OpenAI key never leaves the server.

A browser tab left open next to a TV can keep a Realtime session talking for up to OpenAI's 60-minute session limit. Under the assumptions below, that one call costs about $5 on `gpt-realtime-2.1` if prompt caching works, and about $158 if it doesn't. With the guard's default caps it ends at 10 minutes, and every response reserves the most it can cost, so the call hangs up while one more response would still fit. Through the WebSocket relay that keeps estimated spend at or under $1. In WebRTC mode the browser talks to OpenAI directly and can add to that; [The bound](#the-bound) says exactly what each mode covers.

## Quick start

Needs Node 22.12 or newer and an OpenAI API key with Realtime access ([create one](https://platform.openai.com/api-keys)).

```bash
git clone https://github.com/nussbeck-labs/realtime-voice-guard && cd realtime-voice-guard && npm ci && npm run build
OPENAI_API_KEY=sk-your-key npm run setup   # writes .env with your key and two fresh random secrets
npm start                                  # listens on http://localhost:8080
```

`npm run setup` never overwrites an existing `.env`; run it without the key if you'd rather paste the key into `.env` yourself. The guard reads `.env` from the folder it starts in, and real environment variables win over it. It keeps those values to itself: they never enter `process.env`, and the keys stay out of logs and serialized config. A missing or invalid setting stops it at startup with a message that names the variable and says where to get a value.

Then make a real call from your browser: run `node examples/browser/server.mjs` in a second terminal (it reads only `GUARD_API_KEY` from `.env`, never your OpenAI key) and open http://localhost:3000. The example caps the call at 120 seconds and $0.25 and shows the settled record when it ends.

Or run the container with the same `.env`, passed at run time (`.dockerignore` keeps it out of the image): `docker build -t realtime-voice-guard . && docker run --env-file .env -p 8080:8080 realtime-voice-guard`.

## How it works

```
 your backend ──POST /v1/tickets──────────────▶ ┌───────────┐
   (has GUARD_API_KEY)  ◀── signed ticket ───── │           │ ──POST /v1/realtime/calls──▶ ┌────────┐
                                                │   guard   │ ──sideband WebSocket───────▶ │ OpenAI │
 browser ──POST /v1/realtime/calls + ticket───▶ │           │ ──POST …/calls/{id}/hangup─▶ │        │
         ◀── SDP answer ─────────────────────── └───────────┘                              └────────┘
 browser ◀═══════════ audio over WebRTC, directly with OpenAI ═══════════════════════════▶
```

1. **Your backend asks for a ticket.** It sends the session config (model, instructions, voice, tools) and the caps for this call to `POST /v1/tickets`. The guard checks that every model in the session has a price and that the spend cap covers two worst-case responses ([Spend control](#spend-control-observed--reserved-spend)), stores the config, and returns a ticket: signed with HMAC-SHA256, valid for 120 seconds, usable once.
2. **The browser sends its SDP offer to the guard instead of to OpenAI.** The request has the same shape as OpenAI's own `POST /v1/realtime/calls`: an `application/sdp` body and a bearer token. Only the URL and the token change.
3. **The guard creates the call.** It verifies the ticket, claims it in the ledger so it can't be reused, forces the model, an output-token cap and an input limit onto the session, and creates the call at OpenAI. It attaches a sideband WebSocket to the call (`wss://api.openai.com/v1/realtime?call_id=…`) and returns the SDP answer only once that monitor is connected. No monitor, no call.
4. **It meters every response, and reserves for the ones still running.** Each `response.done` and each `conversation.item.input_audio_transcription.completed` event carries token or duration usage, which the guard prices with your price table. Each `response.created` reserves that response's worst case until it reports, and the call ends while one more response would still fit under the cap. See [Spend control](#spend-control-observed--reserved-spend).
5. **It hangs up from the server.** At the duration cap, the spend cap, the response cap, a stop request, a policy breach or a lost monitor, it first turns off automatic turns and transcription and cancels running responses on the sideband, then calls `POST /v1/realtime/calls/{call_id}/hangup`. Only once OpenAI confirms does it settle the call in the ledger and, if you set one, post a signed webhook to your backend. If OpenAI doesn't confirm, it keeps the sideband open, keeps metering, and retries every 5 seconds until OpenAI does, or until the 60-minute session limit has certainly passed.
6. **It watches for orphans.** Each live call writes a heartbeat. With the Redis ledger, a watchdog on every instance hangs up calls that are past their deadline or whose instance stopped sending heartbeats, so a crashed instance's calls are ended by another instance within about a minute. See the limits below for what happens in that minute, and without Redis.

The audio never passes through the guard. It sees the call's events, not the media, so one small instance handles many calls.

**Native and server clients** that can't do WebRTC (browsers can't set headers on a WebSocket, so they use WebRTC) connect a WebSocket to `/v1/realtime` with the ticket in the `Authorization` header. The guard opens the upstream socket, sends the session from the ticket, and relays events both ways. Clients may send audio, conversation items and `response.create`/`response.cancel`. A `session.update` from the client ends the call, and every `response.create` gets the output cap forced onto it. One response runs at a time: a `response.create` sent while one is running, or before OpenAI has started or refused the last one, gets back an `error` event with code `response_in_progress` instead of reaching OpenAI. If OpenAI does neither within 10 seconds, the relay can no longer tell how many responses may start, so it ends the call (`monitor_lost`). A `response.create` may set only `audio`, `output_modalities`, `metadata`, `max_output_tokens` and `conversation: "auto"`; one that brings its own `input`, `instructions`, `tools`, `tool_choice` or `prompt`, or asks for an out-of-band response, gets back `response_field_not_allowed`, because it could read more than the guard reserved. Clients may send up to 100 frames a second, and up to 2 MiB at once refilled at 256 KiB a second (about four times real-time 24 kHz PCM16 audio in base64); more ends the call.

### Try it with curl

```bash
set -a; . ./.env; set +a   # load GUARD_API_KEY into this shell
curl -s localhost:8080/health
# What your backend does for each call:
curl -s localhost:8080/v1/tickets -H "Authorization: Bearer $GUARD_API_KEY" -H "Content-Type: application/json" \
  -d '{"session":{"model":"gpt-realtime-2.1-mini","instructions":"Keep answers short."},"max_seconds":120,"max_cost_usd":0.25}'
# → {"value":"rvg1.…","expires_at":…,"call_id":"call_…","model":"gpt-realtime-2.1-mini","max_seconds":120,"max_cost_usd":0.25}
# After a browser has used that ticket:
curl -s localhost:8080/v1/admin/calls/$CALL_ID -H "Authorization: Bearer $GUARD_API_KEY"
curl -s -X POST localhost:8080/v1/admin/calls/$CALL_ID/stop -H "Authorization: Bearer $GUARD_API_KEY"
```

The settled record says how the call ended (`endReason`), how long it ran, what it cost by the guard's estimate, and whether every response was metered (`monitoringComplete`). `endReason` is one of:

- `ended`, `max_duration`, `max_cost`, `max_responses`, `stopped`;
- `policy`: the client tried to change what a response may cost. That is a `session.updated` that switches the model, lifts the input limit, raises the output cap, or changes the instructions, the tools or the stored prompt; or a response that raises its own output cap. In relay mode it is also a `session.update` or any other event the relay doesn't forward, invalid JSON, more than 100 frames a second, more than the inbound byte budget, or more than 256 KB sent before the session was ready;
- `unpriced_usage`, `heartbeat_lost`, `provider_error`, `shutdown`;
- `monitor_lost`: the guard lost sight of the call's usage, including a response that never reported within its timeout, or a relayed `response.create` OpenAI neither started nor refused within 10 seconds;
- `watchdog_deadline`, `watchdog_stale`: another instance hung up a call whose owner died;
- `slow_client`: a relay client stopped reading;
- `not_connected`: the ticket was used but no call was made.

### Endpoints

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | none | Liveness, live call count, ledger type, price table date |
| `GET /ready` | none | Readiness for a load balancer: 503 while the ledger isn't answering or the instance is shutting down |
| `POST /v1/tickets` | `GUARD_API_KEY` | Store a session, get a ticket. Body: `session` (required, with `model`), `max_seconds`, `max_cost_usd`, `call_id`, `safety_identifier` |
| `POST /v1/realtime/calls` | ticket | SDP offer in, SDP answer out (201). CORS for `ALLOWED_ORIGINS` |
| `WS /v1/realtime` | ticket | Event relay for native and server clients |
| `GET /v1/admin/calls/:id` | `GUARD_API_KEY` | The call's ledger record |
| `POST /v1/admin/calls/:id/stop` | `GUARD_API_KEY` | Hang up now, on any instance. Answers 202 at once; the hang-up continues in the background |

Errors come back as `{"error":{"code":"…","message":"…"}}` and never include internal details:

| Status | Codes |
| --- | --- |
| 400 | `invalid_json`, `invalid_request`, `invalid_sdp`, `invalid_max_seconds`, `invalid_max_cost_usd` (out of range, or below two worst-case responses; also for a self-signed ticket at the offer), `invalid_call_id`, `invalid_safety_identifier`, `model_not_priced`, `transcription_not_priced`, `prompt_not_supported` (a stored `prompt`, whose instructions the guard can't count), `mcp_not_supported` (an `mcp` tool, whose definitions come from the server at run time) |
| 401 | `invalid_ticket` (bad signature, expired, or caps above the server's ceilings), `unauthorized` (API key) |
| 403 | `origin_not_allowed` |
| 409 | `ticket_used`, `call_id_used` |
| 410 | `session_expired`: the stored session is gone, so the guard refuses rather than run the call without your instructions |
| 413 | `too_large` |
| 429 | `rate_limited`, with `Retry-After` |
| 502 | `provider_rejected` (OpenAI refused the call), `monitor_unavailable` (the sideband didn't attach, so the call was ended) |
| 503 | `at_capacity`, `shutting_down` (with `Retry-After`); `ledger_unavailable` from `/ready` |

### Configuration

Everything is an environment variable; `.env.example` lists them all.

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENAI_API_KEY` | required | Used only by the guard |
| `GUARD_SIGNING_SECRET` | required | Signs tickets. 32+ characters |
| `GUARD_API_KEY` | required | For `/v1/tickets` and the admin routes. 32+ characters, different from the signing secret |
| `MAX_INPUT_TOKENS` | `4000` | Conversation tokens each response may re-read after the instructions, forced as OpenAI's `truncation.token_limits.post_instructions` (1,000 to 120,000). Part of every response's reservation |
| `MAX_CALL_SECONDS` | `600` | Ceiling for any ticket (OpenAI ends sessions at 3600 anyway) |
| `MAX_CALL_COST_USD` | `1.00` | Ceiling on estimated spend per call, and the cap a ticket gets when it asks for none. It must cover two worst-case responses on every model in the price table, or the guard won't start (see [The bound](#the-bound)) |
| `MAX_CONCURRENT_CALLS` | `100` | Per instance |
| `MAX_OUTPUT_TOKENS` | `1024` | Forced onto every session and relayed `response.create` (OpenAI allows 1 to 4096). Part of every response's reservation |
| `MAX_RESPONSES_PER_CALL` | `300` | Stops runaway response loops |
| `ALLOWED_ORIGINS` | none | Browser origins allowed to post offers, comma separated; `*` allows any |
| `RATE_LIMIT_PER_MINUTE` | `60` | Call attempts per client address (per /64 for IPv6) per minute on the public routes; failed API-key attempts count too. `0` turns it off |
| `TRUSTED_PROXIES` | `0` | How many proxies you run in front of the guard. With 1 (a single load balancer), the client address is the last `X-Forwarded-For` entry; entries a client wrote itself are ignored. `0` ignores the header |
| `SHUTDOWN_GRACE_SECONDS` | `25` | How long shutdown waits for hang-ups. Give the process longer than this to stop |
| `PRICES_FILE` | bundled `prices.json` | Your price table |
| `HEARTBEAT_SECONDS` | `15` | The watchdog treats four missed beats as a dead owner |
| `TICKET_TTL_SECONDS` | `120` | Ticket lifetime |
| `REDIS_URL`, `REDIS_PREFIX` | unset, `rvg:` | Use the Redis ledger |
| `SETTLE_WEBHOOK_URL`, `SETTLE_WEBHOOK_SECRET` | unset | Post each settled call to your backend. The secret must differ from the other two |
| `PORT`, `HOST` | `8080`, `0.0.0.0` | Listener |

### Tickets you sign yourself

If your backend runs Node, it can skip the `/v1/tickets` round trip and sign tickets with the shared `GUARD_SIGNING_SECRET`. The package isn't on npm yet: install it with `npm install git+https://github.com/nussbeck-labs/realtime-voice-guard.git` (its `prepare` script builds it), or copy `src/ticket.ts`, which has no dependencies. It works with `import` and, on Node 22.12 or newer, `require`.

```ts
import { signTicket } from "realtime-voice-guard";

const ticket = signTicket(
  { id: "call_8f2c1e9a", exp: Date.now() + 60_000, model: "gpt-realtime-2.1-mini", maxSeconds: 120, maxCostUsd: 0.25,
    session: { instructions: "Keep answers short." } },
  process.env.GUARD_SIGNING_SECRET!,
);
```

The format is `rvg1.<base64url(JSON claims)>.<base64url(HMAC-SHA256(secret, payload))>`, so any language can produce it. `signTicket` adds the issue time (`iat`, milliseconds); set it yourself in other languages. The guard still enforces its own ceilings, the smallest cap the bound allows, the ticket lifetime (with 30 seconds of allowance for clock skew) and single use. The in-memory ledger forgets used tickets when it restarts, so it refuses tickets issued before the instance started, with no allowance for skew: for a few seconds after a restart, a backend whose clock runs behind the guard's gets `401`s and should retry. Keep inline sessions small; tickets are capped at 8 KB.

### The ledger: in memory, or Redis

The ledger records each call's claim, its OpenAI call id, its running cost and how it ended. The in-memory ledger is the default and is right for one instance. If that instance crashes, its records and timers go with it, and OpenAI's 60-minute session limit is the only backstop for calls it owned.

Set `REDIS_URL` for the durable ledger. We chose Redis over SQLite because:

- **Several instances need one view.** A ticket must work once across the whole fleet, and any instance's watchdog must be able to find and hang up a call whose owner died. SQLite is a file on one machine.
- **Each step is one atomic command.** Claims use `SET NX`, settlement uses `HSETNX`, response de-duplication uses `SADD`, and the running cost uses `HINCRBYFLOAT`. No Lua scripts and no locks.
- **Old records expire on their own.** Records keep a 24-hour TTL.
- **Nothing native to install.** The Redis client is plain JavaScript; SQLite needs a native module or Node's newer built-in `node:sqlite`.

To use another store, implement the `Ledger` interface in `src/ledger.ts` and pass it to `createGuard`. `test/ledger.test.ts` is the contract it must pass.

### Settlement webhook

With `SETTLE_WEBHOOK_URL` set, the guard posts `{"type":"call.settled","call":{…}}` when a call settles, with up to three attempts. If all three fail it logs `webhook.gave_up` and moves on; the record stays readable at `GET /v1/admin/calls/:id` for 24 hours, so reconcile from there. It signs the body with `x-guard-signature: v1=<hex HMAC-SHA256(secret, "<x-guard-timestamp>.<body>")>`, which you can check with `verifyWebhookSignature` from this package. Use it to bill users or flag calls with `monitoringComplete: false` for reconciliation.

## Spend control: observed + reserved spend

OpenAI reports what a response cost only when it finishes, and a response can start at any moment: when the user stops talking, or when the client asks for one. So for each call the guard keeps:

- **Observed spend:** the priced usage of every response and transcription that has reported.
- **Reserved spend:** for every response that has started (`response.created`) and not reported, the most it can cost:
  - **input:** the input limit (`MAX_INPUT_TOKENS`, sent as OpenAI's truncation limit) at the model's dearest uncached input rate, plus the session's instructions and tool definitions at its text input rate. Those are counted as one token per UTF-8 byte, since a token is never shorter than a byte, plus 256 tokens for OpenAI's framing. A session without instructions is counted as 1,024 bytes, for OpenAI's default instructions. In WebRTC mode that also lets the browser set instructions of its own once, up to 1,024 bytes; the reservation covers them, and any later change ends the call;
  - **output:** the output cap (`MAX_OUTPUT_TOKENS`) at the model's dearest output rate.

Three rules turn that into a bound:

1. **Hang up while one more response still fits.** After every `response.created`, `response.done` and transcription, the call ends (`max_cost`) as soon as observed spend, plus the running responses' reservations, plus one more worst-case response would pass the cap. The guard learns of a response only once it has started, so that last slot is for the response it can't see yet: a response that starts before the guard knows it should hang up still fits. With nothing running, the check still counts one response, so a call ends right after its last affordable response instead of starting one it would have to cancel.
2. **Refuse caps that can't hold that.** Below two worst-case responses, one running and one more, a call couldn't run even one response. The guard refuses such a cap at startup for `MAX_CALL_COST_USD`, checked against every model in the price table, and at ticket time for `max_cost_usd`. The error names the variables and the minimum.
3. **Count what it can't see as the worst case.** A response that reports no usage is charged its full reservation. A response that never reports ends the call as `monitor_lost` after 60 seconds plus 100 ms per output token (about 162 seconds at the defaults), and is charged its reservation. So is any response still running when a call ends. Those calls settle with `monitoringComplete: false`.

And three more keep the worst case true:

- **One response at a time.** A response that starts while another runs is cancelled at once (`response.cancel`) and stays reserved until it reports. The relay refuses a second `response.create` before it reaches OpenAI.
- **Bounded input.** Every session gets OpenAI's truncation limit. A client that lifts it, raises the output cap, switches model, or changes the instructions, tools or stored prompt ends the call (`policy`), and so does a response that `response.created` shows with a raised output cap, other instructions or a stored prompt. The relay doesn't forward a `response.create` that brings its own input, instructions or tools. Stored prompts and MCP tools are refused at ticket time, because the guard can't count them.
- **Stop at once.** The moment a call starts to end, the guard turns off automatic turns and transcription and cancels every running response. It does that before it waits on the hang-up.

`src/budget.ts` and `src/call.ts` implement it; `test/spend.test.ts` shows each rule.

### The bound

What the guard promises about its estimate:

- **Relay (WebSocket) mode: estimated spend ≤ the cap**, except for input transcription when the session turns it on. Transcription isn't reserved, because the guard can't know how long the user will talk; it is counted when OpenAI reports it. What is reported after the guard decides to hang up (in practice, the user's last turn) lands on top of the cap. So does any part of one turn's transcription that costs more than one worst-case response. Transcription is at most $0.017 a minute of speech in `prices.json`.
- **WebRTC mode: estimated spend ≤ the cap**, with the same transcription exception, plus two things the browser can add, because it talks to OpenAI directly:
  - each extra response the browser starts after the guard has decided to hang up, before the cancel or hang-up lands. Each one is charged what OpenAI reports for it (its input, and any output before the cancel), or its full reservation if it reports nothing.
  - what a response the browser creates itself, in the conversation or out of band, is charged beyond one ordinary reservation because of its own `input`, `instructions`, `tools` or output cap. The guard cancels such a response and ends the call as soon as `response.created` shows a raised output cap, other instructions or a stored prompt. A response whose cap that event doesn't show is reserved at OpenAI's highest, 4,096 tokens, which ends the call at once unless the cap has room for it; if it then never reports usage, it is charged that reservation. What the event doesn't show at all (a response's own input, and instructions or tools OpenAI doesn't report there) the guard can't cancel. In the re-check, an in-conversation response with 60,000 tokens of its own instructions reached $0.338 on a $0.21 cap, and a response with an unseen 4,096-token cap was charged $0.299 on $0.21.

At the defaults (`MAX_INPUT_TOKENS=4000`, `MAX_OUTPUT_TOKENS=1024`, `MAX_CALL_COST_USD=1.00`), with the prices in `prices.json` (from OpenAI's pricing page, checked 2026-11-17, USD per 1M tokens) and a session without instructions:

| Model | Input | Instructions | Output | One response | Smallest cap (two) | The call ends once spend passes |
| --- | --- | --- | --- | --- | --- | --- |
| `gpt-realtime-2.1` | 4,000 × $32 = $0.128000 | 1,280 × $4 = $0.005120 | 1,024 × $64 = $0.065536 | $0.198656 | $0.397312 | $0.602688 |
| `gpt-realtime-2.1-mini` | 4,000 × $10 = $0.040000 | 1,280 × $0.6 = $0.000768 | 1,024 × $20 = $0.020480 | $0.061248 | $0.122496 | $0.877504 |

`npm run cost-model` prints this table for your own settings. The last column is the cap minus two worst cases: past it, the next response couldn't be paid for in the worst case. The worst case assumes every input token is uncached audio, which real turns rarely are (a cached re-read costs $0.40 per 1M tokens instead of $32), so real responses cost far less than their reservation and a call gets many of them before it reaches that column.

Not verified without a live call, so the bound rests on these:

- whether OpenAI bills the input of a cancelled response, and whether a cancelled response reports usage. The guard counts what it reports, or the full reservation if it reports nothing;
- whether the truncation limit keeps one oversized conversation item within the limit;
- how a response's own `input`, `instructions` and `tools` interact with truncation, and which of them `response.created` reports. The guard relies on it showing `max_output_tokens`, and either no `instructions` or the session's;
- how OpenAI counts the tokens around the instructions and tools. The 256 tokens of framing are a margin, not a measurement.

## Limits and costs

### What a call costs

OpenAI's Realtime models bill per token, and voice is expensive tokens. OpenAI's cost guide gives the conversion: user audio is 1 token per 100 ms (600 tokens a minute), and assistant audio is 1 token per 50 ms (1,200 a minute). At the prices in `prices.json`:

| Model | A minute of user speech | A minute of assistant speech |
| --- | --- | --- |
| `gpt-realtime-2.1` ($32 in, $64 out per 1M audio tokens) | $0.019 | $0.077 |
| `gpt-realtime-2.1-mini` ($10 in, $20 out) | $0.006 | $0.024 |

That is the floor. The cost guide also says the whole conversation is sent to the model for every response, so each new turn re-reads every earlier turn as input. Caching makes that re-read cheap ($0.40 per 1M cached audio tokens instead of $32), but OpenAI calls caching best-effort, and truncating the conversation breaks it. So a call's cost grows faster than its length, and how much faster depends on the cache.

`npm run cost-model` runs the guard's own estimator over a simulated call: 10-second user turns, 10-second assistant replies, 1,000 tokens of instructions, the whole history re-read every turn. It shows both ends of the caching range:

| Call length | `gpt-realtime-2.1`, all cached | `gpt-realtime-2.1`, nothing cached | `gpt-realtime-2.1-mini`, all cached | `gpt-realtime-2.1-mini`, nothing cached |
| --- | --- | --- | --- | --- |
| 1 min | $0.055 | $0.091 | $0.016 | $0.026 |
| 5 min | $0.273 | $1.32 | $0.087 | $0.400 |
| 10 min | $0.569 | $4.80 | $0.194 | $1.48 |
| 30 min | $2.02 | $40.31 | $0.823 | $12.53 |
| 60 min | $5.02 | $158.39 | $2.37 | $49.35 |

These are model outputs, not OpenAI quotes. Real calls have silences, shorter turns and partial cache hits, so they land between the columns. Two things hold whatever the cache does: the long tail is where the money goes, and a duration cap alone doesn't bound spend, because a minute late in a call costs more than a minute early on. That is why the guard caps both.

Two settings cut cost further. Choose `gpt-realtime-2.1-mini` where it is good enough. And mind the input limit: the guard always sends `truncation` as `{"type": "retention_ratio", "retention_ratio": 0.8, "token_limits": {"post_instructions": 4000}}` (OpenAI's cost guide recommends this shape: it bounds what each response re-reads and truncates less often, which keeps the cache warm). 4,000 audio tokens is roughly four to six minutes of conversation. Raise `MAX_INPUT_TOKENS` for more model memory and raise the cap with it (the guard tells you the minimum), or send a lower `post_instructions` in your session to trade memory for cost.

### What the guard does not do

- **Its spend is an estimate.** It comes from the usage OpenAI reports and your price table, and [The bound](#the-bound) is a bound on that estimate, with the exceptions listed there. OpenAI doesn't break out reasoning tokens, so output the usage details don't explain is priced at the dearest output rate, which overstates spend and marks the call `monitoringComplete: false`. Your OpenAI invoice is the truth; keep a monthly budget and alerts on your OpenAI organization too.
- **Prices are your config.** `prices.json` is a snapshot of OpenAI's pricing page taken on 2026-11-17. The guard warns at startup when the snapshot is more than 60 days old. A model or transcription model with no price entry is refused at ticket time, and usage the guard can't price ends the call. Stored prompts (`session.prompt`) and MCP tools are refused too: their instructions or tool definitions live elsewhere, so the guard can't count them.
- **It fails closed.** If the ledger can't be reached, the monitor socket drops, a response never reports, or the client changes what a response may cost mid-call, the call ends. Redis commands time out after 5 seconds rather than queueing.
- **In WebRTC mode it can't filter what the browser sends** over the data channel; it watches the result on the sideband. When the browser changes the model, the instructions, the tools or the stored prompt, lifts the input limit, or raises the output cap, for the session or for one response, the guard ends the call. A second concurrent response is cancelled as it starts. It can't see a response's own input, or instructions and tools that OpenAI doesn't report on `response.created`, so those can carry a call past its cap ([The bound](#the-bound)). The WebSocket relay filters client events before they reach OpenAI.
- **Shutdown.** On SIGTERM or SIGINT the guard stops admitting calls, hangs up every live call within `SHUTDOWN_GRACE_SECONDS` (default 25), settles them and exits; give the process more time than that to stop (`docker stop -t 30`, or Kubernetes' default 30-second grace period). A call whose hang-up isn't confirmed in time stays unsettled in the ledger, so with Redis another instance's watchdog takes it over. With the in-memory ledger there is no other instance, so OpenAI's 60-minute session limit is the backstop.
- **Crashes.** With Redis, another instance's watchdog ends a crashed instance's WebRTC calls once four 15-second heartbeats are missed, so about a minute later; during that minute nothing meters them. Without Redis, or with no other instance running, nothing ends them, and OpenAI's 60-minute session limit is the backstop. A relay (WebSocket) call ends with its instance, because its upstream socket closes.
- **Public routes are rate-limited and origin-checked.** `POST /v1/realtime/calls` and the WebSocket relay allow `RATE_LIMIT_PER_MINUTE` attempts per client address (per /64 for IPv6) and refuse browser origins not in `ALLOWED_ORIGINS`. Behind a load balancer, set `TRUSTED_PROXIES=1` or every caller shares the balancer's address. A relay client that stops reading is cut off once 8 MB is queued for it.
- **It covers the token-billed Realtime API** (`/v1/realtime`, `gpt-realtime-*` models). OpenAI also documents a newer GPT-Live API (`/v1/live/sessions`, `gpt-live-1`), billed per second ($0.05 a minute on 2026-11-17). There, a duration cap is a spend cap. The guard doesn't proxy GPT-Live yet.
- **SIP calls** aren't handled; the guard creates WebRTC and WebSocket sessions only.

### Sources

Read on 2026-11-17:

- Pricing: https://developers.openai.com/api/docs/pricing
- Cost and tokenization guide: https://developers.openai.com/api/docs/guides/voice-latency-cost?api=realtime
- WebRTC calls: https://developers.openai.com/api/docs/guides/realtime-webrtc and https://developers.openai.com/api/reference/resources/realtime/subresources/calls/methods/create
- Sideband connections: https://developers.openai.com/api/docs/guides/realtime-server-controls
- Hang-up: https://developers.openai.com/api/reference/resources/realtime/subresources/calls/methods/hangup
- WebSocket sessions: https://developers.openai.com/api/docs/guides/voice-websockets?api=realtime
- Events: https://developers.openai.com/api/reference/resources/realtime/client-events and https://developers.openai.com/api/reference/resources/realtime/server-events
- 60-minute session limit: https://developers.openai.com/api/docs/guides/realtime-conversations
- Models: https://developers.openai.com/api/docs/models/gpt-realtime-2.1 and https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini
- Deprecations: https://developers.openai.com/api/docs/deprecations

## Development

```bash
npm run check       # lint, typecheck, tests against a mocked OpenAI with a 90% line-coverage floor, build, licence check, npm audit
npm run test:pack   # pack the library, install it into a temp project, import it as ESM, CommonJS and TypeScript
```

Set `REDIS_URL` to run the ledger tests against a real Redis too. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

**Built by GoodHandoff.** We build and run the automation that carries a home service company's jobs from the first call to the final payment, inside its own CRM, phone and texting tools. We wrote this guard so an AI voice call in that chain stays inside its time and spend limits. More at [goodhandoff.com](https://goodhandoff.com/?utm_source=github&utm_medium=readme&utm_campaign=realtime-voice-guard).

Apache-2.0. See [LICENSE](LICENSE), [NOTICE](NOTICE) and [TRADEMARKS.md](TRADEMARKS.md). Not affiliated with OpenAI.
