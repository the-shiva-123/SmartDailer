import { StateManager } from '../state/StateManager';
import { DialMode, SafetyDecision } from '../types';

export class SafetyController {
  private lastAvailable?: number;
  private forcedProgressiveUntil = 0;
  private forcedReason = 'progressive-cooldown';
  private readonly cooldownMs = 180_000;

  constructor(private readonly state: StateManager) {}

  forceProgressive(ms = this.cooldownMs, reason = 'progressive-cooldown'): void {
    this.forcedProgressiveUntil = Math.max(this.forcedProgressiveUntil, Date.now() + ms);
    this.forcedReason = reason;
  }

  async evaluate(
    requested: number,
    mode: DialMode,
    historicalAnswerRate = 0.5,
  ): Promise<SafetyDecision> {
    const availableAgents = await this.state.countAvailableAgents();
    const ringingCalls = await this.state.countRingingCalls();
    const dropThreshold = Math.max(2, Math.ceil((this.lastAvailable ?? 0) * 0.2));
    const abruptDrop = this.lastAvailable !== undefined
      && this.lastAvailable > 0
      && availableAgents <= this.lastAvailable - dropThreshold;
    this.lastAvailable = availableAgents;

    if (abruptDrop) {
      this.forceProgressive(this.cooldownMs, 'abrupt-agent-drop-forced-progressive');
      await this.state.incrementSafetyIntervention();
    }

    const forced = Date.now() < this.forcedProgressiveUntil;
    const effectiveMode: DialMode = forced ? 'PROGRESSIVE' : mode;
    const maxAllowedCalls = Math.max(0, availableAgents - ringingCalls);
    const safeRate = Number.isFinite(historicalAnswerRate)
      ? Math.max(0.1, Math.min(1, historicalAnswerRate))
      : 0.5;
    const targetCalls = effectiveMode === 'PREDICTIVE'
      ? Math.ceil(availableAgents / safeRate)
      : availableAgents;
    const safeRequested = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 0;
    const approved = Math.max(0, Math.min(safeRequested, targetCalls, maxAllowedCalls));

    let reason = 'within-hard-cap';
    if (forced) reason = this.forcedReason;
    else if (approved < safeRequested) reason = 'reduced-to-safety-cap';

    if (approved < safeRequested && !abruptDrop) {
      await this.state.incrementSafetyIntervention();
    }

    return {
      requested: safeRequested,
      approved,
      mode: effectiveMode,
      fallback: effectiveMode !== mode,
      reason,
      availableAgents,
      ringingCalls,
      maxAllowedCalls,
      targetCalls,
    };
  }
}
