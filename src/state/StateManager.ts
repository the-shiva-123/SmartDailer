import { Agent, AgentState, Borrower, Call, CallState, ProviderEvent } from '../types';
import { AgentModel } from '../models/Agent';
import { isBackwardOrDuplicate, isTerminal } from '../models/Call';

/** FIFO mutex for in-process transactions only; it is not a distributed lock. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.tail;
    this.tail = previous.then(() => next);
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export class StateManager {
  private readonly mutex = new Mutex();
  readonly agents = new Map<string, Agent>();
  readonly calls = new Map<string, Call>();
  readonly borrowers = new Map<string, Borrower>();
  private readonly processedEventIds = new Set<string>();
  private readonly processedEventOrder: string[] = [];
  private readonly counters = {
    initiated: 0,
    connected: 0,
    completed: 0,
    failed: 0,
    abandoned: 0,
    safetyInterventions: 0,
  };
  private nextId = 1;
  private readonly maxRememberedEventIds = 100_000;

  async addAgents(count: number): Promise<void> {
    if (!Number.isInteger(count) || count < 0) throw new Error('Agent count must be a non-negative integer');
    await this.mutex.runExclusive(() => {
      for (let i = 0; i < count; i++) {
        const id = `agent-${this.nextId++}`;
        this.agents.set(id, { id, state: 'AVAILABLE', version: 1, stateChangedAt: Date.now() });
      }
    });
  }

  async addBorrowers(campaignId: string, count: number): Promise<void> {
    if (!campaignId.trim()) throw new Error('campaignId cannot be empty');
    if (!Number.isInteger(count) || count < 0) throw new Error('Borrower count must be a non-negative integer');
    await this.mutex.runExclusive(() => {
      for (let i = 0; i < count; i++) {
        const id = `borrower-${this.nextId++}`;
        this.borrowers.set(id, { id, campaignId, status: 'QUEUED', version: 1 });
      }
    });
  }

  async setAgentState(agentId: string, state: AgentState): Promise<boolean> {
    return this.mutex.runExclusive(() => {
      const agent = this.agents.get(agentId);
      if (!agent || !AgentModel.canTransition(agent.state, state)) return false;

      const currentCall = agent.currentCallId ? this.calls.get(agent.currentCallId) : undefined;
      // Operational states are derived from the call lifecycle, not manually fabricated.
      if (state === 'RESERVED' && currentCall?.state !== 'RESERVED') return false;
      if (state === 'DIALING' && (!currentCall || !['INITIATED', 'RINGING'].includes(currentCall.state))) return false;
      if (state === 'CONNECTED' && (!currentCall || !['ANSWERED', 'CONNECTED'].includes(currentCall.state))) return false;
      if (state === 'WRAP_UP' && (!currentCall || currentCall.state !== 'COMPLETED')) return false;
      // Never make an agent AVAILABLE while an active call still owns it.
      if (state === 'AVAILABLE' && currentCall && !isTerminal(currentCall.state)) return false;

      agent.state = state;
      agent.version++;
      agent.stateChangedAt = Date.now();
      if (state === 'AVAILABLE' && (!agent.currentCallId || isTerminal(this.calls.get(agent.currentCallId)?.state ?? 'FAILED'))) {
        agent.currentCallId = undefined;
      }
      return true;
    });
  }

  async dropAvailableAgents(count: number): Promise<number> {
    if (!Number.isInteger(count) || count < 0) throw new Error('count must be a non-negative integer');
    return this.mutex.runExclusive(() => {
      let dropped = 0;
      for (const agent of this.agents.values()) {
        if (dropped >= count) break;
        if (agent.state === 'AVAILABLE') {
          agent.state = 'OFFLINE';
          agent.version++;
          agent.stateChangedAt = Date.now();
          dropped++;
        }
      }
      return dropped;
    });
  }

  async snapshot() {
    return this.mutex.runExclusive(() => ({
      agents: [...this.agents.values()].map((agent) => ({ ...agent })),
      calls: [...this.calls.values()].map((call) => ({ ...call })),
      borrowers: [...this.borrowers.values()].map((borrower) => ({ ...borrower })),
      counters: { ...this.counters },
      processedEventCount: this.processedEventIds.size,
    }));
  }

  async countAvailableAgents(): Promise<number> {
    return this.mutex.runExclusive(() => [...this.agents.values()].filter((a) => a.state === 'AVAILABLE').length);
  }

  async countRingingCalls(): Promise<number> {
    return this.mutex.runExclusive(() => [...this.calls.values()].filter((c) => c.state === 'RINGING').length);
  }

  async countActiveCalls(): Promise<number> {
    return this.mutex.runExclusive(() => [...this.calls.values()].filter((c) => !isTerminal(c.state)).length);
  }

  async queuedBorrowerCount(campaignId: string): Promise<number> {
    return this.mutex.runExclusive(() => [...this.borrowers.values()].filter((b) => b.campaignId === campaignId && b.status === 'QUEUED').length);
  }

  async incrementSafetyIntervention(): Promise<void> {
    await this.mutex.runExclusive(() => { this.counters.safetyInterventions++; });
  }

  /** Atomically reserve one unique available agent and one queued borrower. */
  async reserveCall(campaignId: string): Promise<Call | null> {
    return this.mutex.runExclusive(() => {
      const agent = [...this.agents.values()].find((a) => a.state === 'AVAILABLE');
      const borrower = [...this.borrowers.values()].find((b) => b.campaignId === campaignId && b.status === 'QUEUED');
      if (!agent || !borrower) return null;

      agent.state = 'RESERVED';
      agent.version++;
      agent.stateChangedAt = Date.now();
      borrower.status = 'RESERVED';
      borrower.version++;
      const now = Date.now();
      const call: Call = {
        id: `call-${this.nextId++}`,
        borrowerId: borrower.id,
        campaignId,
        state: 'RESERVED',
        version: 1,
        agentId: agent.id,
        createdAt: now,
        updatedAt: now,
      };
      agent.currentCallId = call.id;
      this.calls.set(call.id, call);
      return { ...call };
    });
  }

  async markInitiated(callId: string, provider: string): Promise<boolean> {
    return this.mutex.runExclusive(() => {
      const call = this.calls.get(callId);
      if (!call || call.state !== 'RESERVED') return false;
      call.state = 'INITIATED';
      call.provider = provider;
      call.version++;
      call.updatedAt = Date.now();
      const agent = call.agentId ? this.agents.get(call.agentId) : undefined;
      if (agent?.state === 'RESERVED') {
        agent.state = 'DIALING';
        agent.version++;
        agent.stateChangedAt = Date.now();
      }
      this.counters.initiated++;
      return true;
    });
  }

  /** Releases an unaccepted call and puts its borrower back in the queue for retry. */
  async rollbackReservation(callId: string, reason: string): Promise<void> {
    await this.mutex.runExclusive(() => {
      const call = this.calls.get(callId);
      if (!call || isTerminal(call.state)) return;
      call.state = 'FAILED';
      call.terminalReason = reason;
      call.version++;
      call.updatedAt = Date.now();
      this.counters.failed++;
      this.releaseResources(call, 'retry');
    });
  }

  async processProviderEvent(event: ProviderEvent): Promise<{ accepted: boolean; reason: string; state?: CallState }> {
    return this.mutex.runExclusive(() => {
      const validEventTypes = ['RINGING', 'ANSWERED', 'CONNECTED', 'COMPLETED', 'FAILED', 'CANCELLED'];
      if (!event.eventId?.trim() || !event.callId?.trim() || !validEventTypes.includes(event.type) || !Number.isFinite(event.occurredAt)) {
        return { accepted: false, reason: 'invalid-event' };
      }
      if (this.processedEventIds.has(event.eventId)) return { accepted: false, reason: 'duplicate-event' };
      const call = this.calls.get(event.callId);
      if (!call) return { accepted: false, reason: 'unknown-call' };
      if (call.provider && event.provider !== call.provider) return { accepted: false, reason: 'provider-mismatch', state: call.state };

      const next = event.type as CallState;
      if (isBackwardOrDuplicate(call.state, next)) {
        // Remember stale events so replaying the same webhook remains idempotent.
        this.rememberEventId(event.eventId);
        return { accepted: false, reason: 'stale-transition', state: call.state };
      }

      const previous = call.state;
      this.rememberEventId(event.eventId);
      call.state = next;
      call.version++;
      call.updatedAt = Date.now();
      if (next === 'CONNECTED' && previous !== 'CONNECTED') this.counters.connected++;

      const agent = call.agentId ? this.agents.get(call.agentId) : undefined;
      if (next === 'ANSWERED' || next === 'CONNECTED') {
        if (agent && agent.state !== 'OFFLINE' && agent.state !== 'PAUSED') {
          agent.state = 'CONNECTED';
          agent.version++;
          agent.stateChangedAt = Date.now();
        }
      }

      if (next === 'COMPLETED') {
        this.counters.completed++;
        this.releaseResources(call, 'completed');
      } else if (next === 'FAILED' || next === 'CANCELLED') {
        this.counters.failed++;
        this.releaseResources(call, 'retry');
      }
      return { accepted: true, reason: 'applied', state: call.state };
    });
  }

  private rememberEventId(eventId: string): void {
    this.processedEventIds.add(eventId);
    this.processedEventOrder.push(eventId);
    if (this.processedEventOrder.length > this.maxRememberedEventIds) {
      const oldest = this.processedEventOrder.shift();
      if (oldest) this.processedEventIds.delete(oldest);
    }
  }

  private releaseResources(call: Call, outcome: 'completed' | 'retry'): void {
    const borrower = this.borrowers.get(call.borrowerId);
    if (borrower) {
      borrower.status = outcome === 'completed' ? 'CALLED' : 'QUEUED';
      borrower.version++;
    }
    const agent = call.agentId ? this.agents.get(call.agentId) : undefined;
    if (agent && agent.currentCallId === call.id) {
      agent.currentCallId = undefined;
      agent.version++;
      agent.stateChangedAt = Date.now();
      if (agent.state !== 'OFFLINE' && agent.state !== 'PAUSED') {
        agent.state = outcome === 'completed' ? 'WRAP_UP' : 'AVAILABLE';
      }
    }
  }

  async finishWrapUp(agentId: string): Promise<boolean> {
    return this.setAgentState(agentId, 'AVAILABLE');
  }

  async recordAbandoned(): Promise<void> {
    await this.mutex.runExclusive(() => { this.counters.abandoned++; });
  }

  async metrics(mode: 'PROGRESSIVE' | 'PREDICTIVE', activeProvider: string, providerCircuitOpen: boolean) {
    return this.mutex.runExclusive(() => {
      const agents = [...this.agents.values()];
      const calls = [...this.calls.values()];
      const availableAgents = agents.filter((a) => a.state === 'AVAILABLE').length;
      const utilized = agents.filter((a) => ['RESERVED', 'DIALING', 'CONNECTED', 'WRAP_UP'].includes(a.state)).length;
      return {
        agents: agents.length,
        availableAgents,
        utilizedAgents: utilized,
        agentUtilizationPct: agents.length ? Math.round((utilized / agents.length) * 1000) / 10 : 0,
        callsInitiated: this.counters.initiated,
        callsConnected: this.counters.connected,
        callsCompleted: this.counters.completed,
        callsFailed: this.counters.failed,
        ringingCalls: calls.filter((c) => c.state === 'RINGING').length,
        abandonedCalls: this.counters.abandoned,
        abandonmentRatePct: this.counters.connected ? Math.round((this.counters.abandoned / this.counters.connected) * 1000) / 10 : 0,
        safetyInterventions: this.counters.safetyInterventions,
        mode,
        activeProvider,
        providerCircuitOpen,
      };
    });
  }
}
