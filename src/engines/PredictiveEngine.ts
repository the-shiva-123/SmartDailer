import { StateManager } from '../state/StateManager';

export class PredictiveEngine {
  constructor(private readonly state: StateManager) {}

  async targetCalls(campaignId: string, historicalAnswerRate: number): Promise<number> {
    const availableAgents = await this.state.countAvailableAgents();
    const queuedBorrowers = await this.state.queuedBorrowerCount(campaignId);
    const answerRate = Number.isFinite(historicalAnswerRate)
      ? Math.max(0.1, Math.min(1, historicalAnswerRate))
      : 0.5;
    return Math.min(queuedBorrowers, Math.ceil(availableAgents / answerRate));
  }
}
