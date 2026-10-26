import { StateManager } from '../state/StateManager';

export class ProgressiveEngine {
  constructor(private readonly state: StateManager) {}

  async targetCalls(campaignId: string): Promise<number> {
    const [availableAgents, queuedBorrowers] = await Promise.all([
      this.state.countAvailableAgents(),
      this.state.queuedBorrowerCount(campaignId),
    ]);
    return Math.min(availableAgents, queuedBorrowers);
  }
}
