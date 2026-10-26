import { StateManager } from '../state/StateManager';
import { FastProvider } from '../providers/FastProvider';
import { FlakyProvider } from '../providers/FlakyProvider';
import { ITelecomProvider } from '../providers/ITelecomProvider';
import { ProgressiveEngine } from '../engines/ProgressiveEngine';
import { PredictiveEngine } from '../engines/PredictiveEngine';
import { SafetyController } from '../engines/SafetyController';
import { DialMode, ProviderEvent } from '../types';

type DialedCall = { callId: string; agentId?: string; provider: string };

export class SmartDialer {
  readonly state = new StateManager();
  readonly progressive = new ProgressiveEngine(this.state);
  readonly predictive = new PredictiveEngine(this.state);
  readonly safety = new SafetyController(this.state);

  private readonly providers: ITelecomProvider[];
  private providerIndex = 0;
  private readonly circuitOpenUntil = new Map<string, number>();
  private readonly providerResults = new Map<string, boolean[]>();
  private mode: DialMode = 'PROGRESSIVE';
  private readonly circuitCooldownMs: number;

  constructor(
    providers: ITelecomProvider[] = [new FastProvider(), new FlakyProvider()],
    circuitCooldownMs = 15_000,
  ) {
    if (providers.length === 0) throw new Error('At least one telecom provider is required');
    if (!Number.isFinite(circuitCooldownMs) || circuitCooldownMs < 0) {
      throw new Error('circuitCooldownMs must be a non-negative number');
    }
    this.providers = [...providers];
    this.circuitCooldownMs = circuitCooldownMs;
  }

  get activeProvider(): ITelecomProvider {
    return this.providers[this.providerIndex];
  }

  get providerCircuitOpen(): boolean {
    return this.isCircuitOpen(this.activeProvider);
  }

  private isCircuitOpen(provider: ITelecomProvider): boolean {
    return Date.now() < (this.circuitOpenUntil.get(provider.name) ?? 0);
  }

  private chooseProvider(): ITelecomProvider | undefined {
    for (let offset = 0; offset < this.providers.length; offset++) {
      const index = (this.providerIndex + offset) % this.providers.length;
      const provider = this.providers[index];
      if (!this.isCircuitOpen(provider)) {
        this.providerIndex = index;
        return provider;
      }
    }
    return undefined;
  }

  async dial(campaignId: string, mode: DialMode, requestedCalls?: number, historicalAnswerRate = 0.5) {
    const pacingTarget = requestedCalls ?? (mode === 'PREDICTIVE'
      ? await this.predictive.targetCalls(campaignId, historicalAnswerRate)
      : await this.progressive.targetCalls(campaignId));
    const decision = await this.safety.evaluate(pacingTarget, mode, historicalAnswerRate);
    this.mode = decision.mode;

    const calls: DialedCall[] = [];
    let initiationFailures = 0;
    let providerUnavailable = false;

    for (let i = 0; i < decision.approved; i++) {
      const provider = this.chooseProvider();
      if (!provider) {
        providerUnavailable = true;
        break;
      }

      const call = await this.state.reserveCall(campaignId);
      if (!call) break;

      const marked = await this.state.markInitiated(call.id, provider.name);
      if (!marked) {
        await this.state.rollbackReservation(call.id, 'Unable to mark reserved call as initiated');
        continue;
      }

      try {
        await provider.initiate(call.id, async (event) => {
          await this.handleProviderEvent(event);
        });
        calls.push({ callId: call.id, agentId: call.agentId, provider: provider.name });
        this.noteProviderResult(provider, true);
      } catch (error) {
        initiationFailures++;
        await this.state.rollbackReservation(
          call.id,
          error instanceof Error ? error.message : 'Provider initiation failed',
        );
        this.noteProviderResult(provider, false);
      }
    }

    return {
      decision,
      initiated: calls.length,
      initiationFailures,
      providerUnavailable,
      calls,
      metrics: await this.metrics(),
    };
  }

  async handleProviderEvent(event: ProviderEvent) {
    const result = await this.state.processProviderEvent(event);
    if (result.accepted && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(event.type)) {
      const snapshot = await this.state.snapshot();
      const call = snapshot.calls.find((item) => item.id === event.callId);
      const agent = call?.agentId ? snapshot.agents.find((item) => item.id === call.agentId) : undefined;
      if (agent?.state === 'WRAP_UP') {
        setTimeout(() => { void this.state.finishWrapUp(agent.id); }, 100).unref?.();
      }
    }
    return result;
  }

  private noteProviderResult(provider: ITelecomProvider, ok: boolean): void {
    const results = this.providerResults.get(provider.name) ?? [];
    results.push(ok);
    if (results.length > 20) results.shift();
    this.providerResults.set(provider.name, results);

    const failures = results.filter((result) => !result).length;
    if (results.length >= 5 && failures / results.length >= 0.4) {
      this.circuitOpenUntil.set(provider.name, Date.now() + this.circuitCooldownMs);
      const failedIndex = this.providers.findIndex((item) => item.name === provider.name);
      this.providerIndex = (failedIndex + 1) % this.providers.length;
      this.safety.forceProgressive(30_000, 'provider-failure-forced-progressive');
    }
  }

  async metrics() {
    const provider = this.chooseProvider() ?? this.activeProvider;
    return this.state.metrics(this.mode, provider.name, this.isCircuitOpen(provider));
  }

  async seed(agents: number, borrowers: number, campaignId = 'default'): Promise<void> {
    await this.state.addAgents(agents);
    await this.state.addBorrowers(campaignId, borrowers);
  }
}
