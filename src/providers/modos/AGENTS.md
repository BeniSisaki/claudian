# Modos Provider

`src/providers/modos/` adapts MODOS through a shared `modos serve` child
process, driven over its local HTTP + SSE API.

## Ownership

- Serve process lifecycle (`ModosServeManager`), HTTP/SSE transport
  (`ModosHttpClient`), event normalization, thread/session mapping, model
  discovery, settings UI, and Modos-specific settings reconciliation live
  here.
- Shared code should consume Modos behavior through `ChatRuntime`, provider
  capabilities, and workspace-service contracts.

## Protocol Rules

- One `modos serve` process per plugin instance, launched with a random
  `MODOS_RUNTIME_TOKEN` via the environment (never in argv). The launch key
  covers CLI path, data dir, env text, approval policy, and sandbox mode;
  changing any of these restarts the process.
- Turns: `POST /v1/threads/:id/turns`, then stream
  `GET /v1/threads/:id/events?since_seq=N`. Reconnect with the last cursor
  on EOF; on replay overflow, rebuild the cursor from
  `GET /v1/threads/:id` (`latestSeq`) and resume. Heartbeats never advance
  the cursor.
- Approvals round-trip via `POST /v1/approvals/:id/consent` followed by the
  decision POST with the `x-modos-approval-consent` header. User input uses
  `POST /v1/user-inputs/:id` (`answers` or `cancelled`).
- `providerState.threadId` is the resume handle. Do not infer it in feature
  code.

## Gotchas

- `ModosAuxQueryRunner` owns one-shot `modos run` processes and is
  independent from the chat runtime's serve process.
- History hydration must go through the HTTP API; never touch files inside
  the MODOS data dir directly.
- The rewind/fork ids exposed to shared code are MODOS turn ids
  (`assistantMessageId`) and user-message item ids (`userMessageId`).
