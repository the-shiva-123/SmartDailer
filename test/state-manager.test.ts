import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StateManager } from '../src/state/StateManager';
import { SmartDialer } from '../src/core/SmartDialer';
import { SafetyController } from '../src/engines/SafetyController';
import { isBackwardOrDuplicate } from '../src/models/Call';
import type { ProviderEvent, ProviderEventType } from '../src/types';
import type { ITelecomProvider, ProviderListener } from '../src/providers/ITelecomProvider';

const event = (eventId: string, callId: string, type: 'RINGING' | 'ANSWERED' | 'CONNECTED' | 'COMPLETED' | 'FAILED' | 'CANCELLED', provider = 'test', occurredAt = Date.now()) => ({ eventId, callId, type, provider, occurredAt });

test('concurrent reservation never allocates the same agent or borrower twice', async () => {
  const state = new StateManager();
  await state.addAgents(1);
  await state.addBorrowers('c', 5);
  const calls = await Promise.all(Array.from({ length: 10 }, () => state.reserveCall('c')));
  assert.equal(calls.filter(Boolean).length, 1);
  const snapshot = await state.snapshot();
  assert.equal(new Set(snapshot.calls.map((call) => call.agentId)).size, 1);
  assert.equal(new Set(snapshot.calls.map((call) => call.borrowerId)).size, 1);
});

test('duplicate event ID is idempotent and late event cannot change terminal call', async () => {
  const state = new StateManager();
  await state.addAgents(1);
  await state.addBorrowers('c', 1);
  const call = await state.reserveCall('c');
  assert.ok(call);
  await state.markInitiated(call.id, 'test');
  assert.equal((await state.processProviderEvent(event('e1', call.id, 'COMPLETED'))).accepted, true);
  assert.equal((await state.processProviderEvent(event('e1', call.id, 'COMPLETED'))).reason, 'duplicate-event');
  assert.equal((await state.processProviderEvent(event('e2', call.id, 'ANSWERED', 'test', 1))).accepted, false);
  assert.equal((await state.snapshot()).calls[0].state, 'COMPLETED');
});

test('unknown call event does not consume the event ID', async () => {
  const state = new StateManager();
  assert.equal((await state.processProviderEvent(event('reusable', 'missing', 'RINGING'))).reason, 'unknown-call');
  await state.addAgents(1);
  await state.addBorrowers('c', 1);
  const call = await state.reserveCall('c');
  assert.ok(call);
  await state.markInitiated(call.id, 'test');
  assert.equal((await state.processProviderEvent(event('reusable', call.id, 'RINGING'))).accepted, true);
});

test('invalid provider event payload is rejected', async () => {
  const state = new StateManager();
  const result = await state.processProviderEvent({
    eventId: 'bad-event', callId: 'missing', type: 'NOT_A_REAL_EVENT' as never,
    provider: 'test', occurredAt: Number.NaN,
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'invalid-event');
});

test('provider mismatch is rejected without mutating call state', async () => {
  const state = new StateManager();
  await state.addAgents(1);
  await state.addBorrowers('c', 1);
  const call = await state.reserveCall('c');
  assert.ok(call);
  await state.markInitiated(call.id, 'provider-a');
  const result = await state.processProviderEvent(event('evt', call.id, 'RINGING', 'provider-b'));
  assert.equal(result.reason, 'provider-mismatch');
  assert.equal((await state.snapshot()).calls[0].state, 'INITIATED');
});

test('failed/cancelled call requeues borrower and releases agent', async () => {
  const state = new StateManager();
  await state.addAgents(1);
  await state.addBorrowers('c', 1);
  const call = await state.reserveCall('c');
  assert.ok(call);
  await state.markInitiated(call.id, 'test');
  assert.equal((await state.processProviderEvent(event('fail', call.id, 'FAILED'))).accepted, true);
  const snapshot = await state.snapshot();
  assert.equal(snapshot.borrowers[0].status, 'QUEUED');
  assert.equal(snapshot.agents[0].state, 'AVAILABLE');
  assert.equal(await state.queuedBorrowerCount('c'), 1);
});

test('agent operational state cannot be fabricated without a matching call', async () => {
  const state = new StateManager();
  await state.addAgents(1);
  const agent = (await state.snapshot()).agents[0];
  assert.equal(await state.setAgentState(agent.id, 'RESERVED'), false);
  assert.equal(await state.setAgentState(agent.id, 'DIALING'), false);
  assert.equal(await state.setAgentState(agent.id, 'CONNECTED'), false);
});

test('agent cannot be manually made available while an active call owns it', async () => {
  const state = new StateManager();
  await state.addAgents(1);
  await state.addBorrowers('c', 1);
  const call = await state.reserveCall('c');
  assert.ok(call);
  assert.equal(await state.setAgentState(call.agentId!, 'AVAILABLE'), false);
  assert.equal(await state.countAvailableAgents(), 0);
});

test('call state machine rejects terminal regression and invalid jumps', () => {
  assert.equal(isBackwardOrDuplicate('COMPLETED', 'ANSWERED'), true);
  assert.equal(isBackwardOrDuplicate('RESERVED', 'COMPLETED'), true);
  assert.equal(isBackwardOrDuplicate('INITIATED', 'CONNECTED'), false);
  assert.equal(isBackwardOrDuplicate('RINGING', 'FAILED'), false);
});

test('safety gateway caps requested calls at available-agent hard limit', async () => {
  const state = new StateManager();
  await state.addAgents(3);
  await state.addBorrowers('c', 20);
  const safety = new SafetyController(state);
  const result = await safety.evaluate(30, 'PREDICTIVE', 0.1);
  assert.equal(result.approved, 3);
  assert.equal(result.maxAllowedCalls, 3);
});

test('predictive safety fallback flag only means mode actually changed', async () => {
  const state = new StateManager();
  await state.addAgents(3);
  await state.addBorrowers('c', 20);
  const safety = new SafetyController(state);
  const result = await safety.evaluate(30, 'PREDICTIVE', 0.5);
  assert.equal(result.mode, 'PREDICTIVE');
  assert.equal(result.fallback, false);
  assert.equal(result.approved, 3);
});

test('concurrent dial requests never initiate more calls than unique agents', async () => {
  const dialer = new SmartDialer();
  await dialer.seed(2, 10, 'c');
  const [first, second] = await Promise.all([
    dialer.dial('c', 'PROGRESSIVE', 2),
    dialer.dial('c', 'PROGRESSIVE', 2),
  ]);
  assert.ok(first.initiated + second.initiated <= 2);
  const snapshot = await dialer.state.snapshot();
  const active = snapshot.calls.filter((call) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(call.state));
  assert.ok(active.length <= 2);
});

test('provider circuit opens after repeated initiation failures and dialing fails over to a healthy provider', async () => {
  class AlwaysFailProvider implements ITelecomProvider {
    readonly name = 'ProviderFail';
    attempts = 0;
    async initiate(_callId: string, _listener: ProviderListener): Promise<void> {
      this.attempts++;
      throw new Error('deterministic provider failure');
    }
    health() { return { attempts: this.attempts, failures: this.attempts, errorRate: this.attempts ? 1 : 0 }; }
  }

  class HealthyProvider implements ITelecomProvider {
    readonly name = 'ProviderHealthy';
    attempts = 0;
    async initiate(callId: string, listener: ProviderListener): Promise<void> {
      this.attempts++;
      const emit = async (type: ProviderEventType) => listener({
        eventId: `${this.name}-${callId}-${type}`,
        callId,
        type,
        occurredAt: Date.now(),
        provider: this.name,
      } satisfies ProviderEvent);
      await emit('RINGING');
      await emit('COMPLETED');
    }
    health() { return { attempts: this.attempts, failures: 0, errorRate: 0 }; }
  }

  const failing = new AlwaysFailProvider();
  const healthy = new HealthyProvider();
  const dialer = new SmartDialer([failing, healthy], 60_000);
  await dialer.seed(6, 6, 'failover-test');

  const result = await dialer.dial('failover-test', 'PROGRESSIVE', 6);

  assert.equal(failing.attempts, 5, 'the failing provider should be attempted five times before its circuit opens');
  assert.equal(healthy.attempts, 1, 'the sixth call should use the healthy provider');
  assert.equal(result.initiationFailures, 5);
  assert.equal(result.initiated, 1);
  assert.equal(result.providerUnavailable, false);
  assert.equal(result.calls[0]?.provider, 'ProviderHealthy');

  const snapshot = await dialer.state.snapshot();
  assert.equal(snapshot.agents.filter((agent) => agent.state === 'AVAILABLE').length, 5,
    'all five failed reservations should release their agents');
  assert.equal(snapshot.borrowers.filter((borrower) => borrower.status === 'QUEUED').length, 5,
    'borrowers from failed initiation attempts should be requeued');
  assert.equal(snapshot.calls.filter((call) => call.state === 'FAILED').length, 5);
  assert.equal(snapshot.calls.filter((call) => call.state === 'COMPLETED').length, 1);
  assert.equal((await dialer.metrics()).activeProvider, 'ProviderHealthy');
});
