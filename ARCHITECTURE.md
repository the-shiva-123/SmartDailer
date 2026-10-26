# Architecture Decision Record

## Decision
Use TypeScript, Express, a modular in-process state engine protected by a FIFO async mutex, two provider adapters, and explicit pacing/safety/allocator layers. This matches the assignment's preference for a practical local prototype rather than adding infrastructure for its own sake.

## Why this design
- **Safety boundary:** pacing engines return numeric targets only. `SmartDialer.dial()` routes every request through `SafetyController.evaluate()` before reservation and provider initiation.
- **Progressive correctness:** progressive pacing asks for at most the available-agent count; the hard cap independently checks available agents minus ringing calls.
- **Predictive pacing:** uses a bounded historical answer-rate estimate with a 10% floor, preventing an unbounded division and producing a transparent rule-based decision.
- **Atomic reservation:** one mutex-protected transaction reserves both agent and borrower and creates a call. Versions make mutations visible and provide a migration path to CAS/SQL conditional updates.
- **Provider abstraction:** providers implement one interface; Provider A is fast with a small simulated initiation-failure chance; Provider B is slower and can timeout, duplicate, or emit delayed events.
- **Fault handling:** initiation errors release resources and requeue the borrower; provider initiation outcomes drive a per-provider circuit-breaker/failover, and abrupt availability drops trigger a progressive cooldown.

## Trade-offs
The mutex is easy to reason about and test, but serializes state mutations and is not shared across Node processes. The in-memory store is fast and dependency-light, but state and idempotency keys disappear on restart. The prototype uses mock events and compressed simulation timing rather than a realistic telecom protocol. These are deliberate scope choices for a local assignment prototype, not claims of production readiness.

## What breaks first at scale
1. **Single-process mutex contention:** all reservations/events serialize; measure lock wait and transaction duration, then partition by campaign or move reservation invariants into a transactional database.
2. **Hot campaign/borrower queues:** repeated scans over Maps become O(N); use indexed SQL queries/queues and claim batches with `SKIP LOCKED` or conditional updates.
3. **Provider event ingestion:** webhook bursts and retry storms can outpace synchronous processing; use durable event inbox/outbox and bounded workers while preserving per-call ordering/idempotency.
4. **Provider rate limits and ambiguous timeouts:** use per-provider concurrency limits, backoff with jitter, request IDs, circuit breakers, and status reconciliation before retrying.
5. **Metrics cardinality/storage:** keep bounded aggregates and export counters/histograms to an observability system rather than retaining all event history in memory.

## Cross-process correctness plan
For multiple workers, use a durable database as the source of truth. Reserve with one transaction: conditionally update one AVAILABLE agent and one QUEUED borrower using version predicates; create the call and an outbox record in that transaction; commit only if both claims succeed. Unique active-reservation constraints provide a second guard. Persist provider event IDs with a unique constraint and update the call state plus cleanup in the same transaction. Leases and a reconciliation worker recover abandoned reservations after crashes. A cache may accelerate reads, but it never overrides the committed database state.

## Final question
I would combine predictive pacing with a strict interlocking safety gateway. Predictive pacing estimates demand from a smoothed answer rate, setup latency and recent campaign behaviour, but it only proposes a batch size. The current prototype gateway independently recomputes current available-agent capacity and ringing calls, then clamps the requested batch. A sudden availability drop forces progressive pacing, while provider initiation failures open that provider’s circuit and temporarily force progressive mode. Provider health is not yet part of the safety formula, and abandonment is measured but not yet used as a pacing input; those are explicit follow-up improvements before production use. I would optimize for zero abandoned connected calls first, then increase utilization through measured, reversible changes. The exact buffer must be justified by simulation and compliance requirements, not assumed safe.
