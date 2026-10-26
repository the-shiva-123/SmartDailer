# SmartDialer — safety-gated TypeScript prototype

A local Node.js + TypeScript API that demonstrates progressive/predictive outbound call pacing, a mandatory safety controller, atomic in-process call allocation, mock telecom providers, webhook event handling, and operational metrics. It does **not** connect to a real telecom provider.

## Requirements

- Node.js 20 or later
- npm

## Install and run (Windows PowerShell)

Open PowerShell in the extracted `smart-dialer` folder:

```powershell
npm ci
npm run build
npm test
npm start
```

The API listens on `http://localhost:3000` by default. Set a different port with `$env:PORT = "3187"` before `npm start` if needed. `npm start` builds the TypeScript first.

Other commands:

```powershell
npm run dev       # hot reload for development
npm run simulate  # runs simulation scenarios A–D
```

## Quick API tour

Seed 5 agents and 20 borrowers:

```powershell
$body = @{ agents = 5; borrowers = 20; campaignId = "demo" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/seed" -ContentType "application/json" -Body $body
```

Request a progressive dial batch:

```powershell
$body = @{ campaignId = "demo"; mode = "PROGRESSIVE"; requestedCalls = 3 } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/dial" -ContentType "application/json" -Body $body
```

Read health, metrics, and state:

```powershell
Invoke-RestMethod http://localhost:3000/health
Invoke-RestMethod http://localhost:3000/api/metrics
Invoke-RestMethod http://localhost:3000/api/state
```

Other endpoints:

- `GET /` — API information
- `POST /api/seed` — adds agents and borrowers to memory; it does not reset existing state
- `POST /api/dial` — requests a batch; `mode` is `PROGRESSIVE` or `PREDICTIVE`
- `GET /api/metrics` — aggregate counters and current capacity
- `GET /api/state` — in-memory agents, calls, borrowers, and counters
- `PATCH /api/agents/:id/state` — pause, offline, or change an agent where the transition is valid; operational states must match the current call lifecycle
- `POST /api/providers/:provider/events` — accepts a mock/provider event with `eventId`, `callId`, `type`, and optional numeric `occurredAt`

## Architecture

```text
Campaign / queued borrowers
          |
          v
ProgressiveEngine OR PredictiveEngine
          |
          v
SafetyController (hard cap + progressive fallback)
          |
          v
StateManager.reserveCall() (atomic agent + borrower reservation)
          |
          v
Provider interface -> Provider A / Provider B mocks
          |
          v
Event handler -> provider check + idempotency + state transitions + cleanup
```

## Pacing and safety rules

- Progressive target: `min(available agents, queued borrowers)`.
- Predictive target: `min(queued borrowers, ceil(available agents / max(historical answer rate, 0.10)))`.
- Hard cap: `max(0, available agents - ringing calls)`.
- Approved calls: the minimum of requested calls, the mode target, and the hard cap.
- A sudden drop of at least 20% and at least two agents triggers a progressive cooldown.
- Repeated provider initiation failures open that provider's circuit for 15 seconds and allow the other healthy mock provider to be selected. A provider failure also temporarily forces progressive mode.

## State and event safety

- A FIFO async mutex makes each state mutation atomic within this Node.js process.
- An agent and borrower are reserved in one transaction-like critical section; simultaneous requests cannot reserve the same agent or borrower twice in this process.
- Provider events must refer to a known call and match the provider assigned to it. Duplicate event IDs and invalid/backward transitions are rejected.
- A completed call marks the borrower called and moves the agent to wrap-up. Failed/cancelled calls release the agent and requeue the borrower for retry.
- Provider mock events are asynchronous and stochastic. A dial response reports successful provider initiation, not that the call has already completed.

## Tests

`npm test` builds the TypeScript and runs Node's built-in test runner against the compiled tests. Coverage includes concurrent reservations, duplicate/out-of-order events, unknown call IDs, provider mismatch, resource cleanup/retry, state integrity, safety caps, concurrent dial requests, and deterministic provider circuit-breaker failover.

## Important limitations before production use

- State is in-memory and disappears on restart. The mutex does not coordinate multiple processes or machines.
- The mock providers are not connected to a carrier. Production use requires authenticated/signed webhooks, durable event idempotency, database transactions, timeouts, retries/reconciliation, observability, and secrets management.
- Add consent and do-not-call checks, contact-time restrictions, attempt limits, opt-out handling, audit logs, access controls, and applicable legal/compliance reviews before making real calls.
