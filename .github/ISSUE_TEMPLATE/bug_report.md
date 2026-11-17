---
name: Bug report
about: A call ran past a cap, was cut off when it should not have been, or the guard misbehaved
labels: bug
---

## What happened

<!-- What did the call do, and what did you expect? -->

## The settled record

<!-- Paste the output of GET /v1/admin/calls/:id with ids replaced. No keys, tickets, SDP or transcripts. -->

## Setup

- realtime-voice-guard version:
- Node version:
- Ledger: memory / Redis
- Transport: WebRTC / WebSocket relay
- Model and transcription model:
- Caps (max_seconds, max_cost_usd):

## Guard log lines

<!-- The JSON log lines for this call id. They contain no secrets by design. -->
