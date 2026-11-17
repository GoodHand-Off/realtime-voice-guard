# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's private vulnerability
reporting: open this repository's **Security** tab and choose **Report a
vulnerability**
(https://github.com/nussbeck-labs/realtime-voice-guard/security/advisories/new).
Do not open a public issue.

Include the affected version, a description and, if you can, a test against the
mocked OpenAI in `test/helpers.ts`. Never include a real API key, ticket or call
transcript.

We aim to acknowledge reports within five business days.

## Supported versions

Only the latest minor version receives fixes.

## What the guard protects, and what it does not

It does:

- keep your OpenAI key on the server. Browsers and apps only ever hold a ticket
  that is signed, expires within minutes, works once, and carries its own caps;
- end a call at its duration cap, before its estimated spend can pass its cap,
  after a stop request, or when the guard loses sight of the call's usage, by
  first stopping automatic turns and running responses and then calling OpenAI's
  hang-up endpoint (WebRTC) or closing the upstream socket (relay);
- refuse a spend cap too small to hold two worst-case responses, at startup and
  when a ticket is minted or used;
- end calls whose session switches model, changes its instructions, tools or
  stored prompt, lifts the input limit, or raises the output-token cap, for the
  session or for a single response that `response.created` shows. In relay
  mode it also refuses a `response.create` that brings its own input,
  instructions or tools. Stored prompts and MCP tools are refused at ticket
  time, since the guard can't count them;
- rate-limit the public routes per client address, count failed API-key attempts
  against the same limit, and refuse browser origins you haven't allowed.

It does not:

- replace OpenAI's own usage limits. Set a monthly budget and alerts in your
  OpenAI organization as well;
- bill exactly. Spend is an estimate from the usage OpenAI reports and your
  price table. The guard bounds that estimate ("observed + reserved spend",
  see "The bound" in the README). In relay mode it stays at or under the cap.
  In WebRTC mode, where the browser talks to OpenAI directly, it can pass the
  cap by what the extra responses the browser starts while the hang-up lands
  are charged, and by what a response the browser creates itself (in the
  conversation or out of band) is charged for its own input, instructions,
  tools or output cap before the guard's cancel lands. The guard ends the call
  when `response.created` shows such settings, but can't see a response's own
  input. In both modes, input transcription isn't reserved, so the
  transcription of the user's last turn can land on top (the README has the
  exact terms). Whether OpenAI bills the input of cancelled responses is not
  verified;
- survive a crash with the in-memory ledger. Use Redis (`REDIS_URL`) so another
  instance's watchdog can hang up calls the crashed instance owned, about a
  minute later; nothing meters those calls in that minute;
- authenticate your users. Your backend decides who gets a ticket.

## Handling secrets

- `OPENAI_API_KEY` is sent only to `OPENAI_BASE_URL` as an `Authorization: Bearer`
  header.
- `GUARD_SIGNING_SECRET`, `GUARD_API_KEY` and `SETTLE_WEBHOOK_SECRET` must each be
  at least 32 characters, and the guard refuses to start if any two are equal.
- In memory, keys are held in `Secret` objects (an ES `#private` field) that print
  `[redacted]` in logs, JSON and `util.inspect`. A `.env` file is read into a
  private object, never into `process.env`.
- Logs carry call ids, reasons, durations and cost estimates. They never carry
  keys, tickets, SDP, transcripts or provider payloads.
