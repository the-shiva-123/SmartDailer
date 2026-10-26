import { AgentState } from '../types';

export class AgentModel {
  static canTransition(from: AgentState, to: AgentState): boolean {
    const allowed: Record<AgentState, AgentState[]> = {
      OFFLINE: ['AVAILABLE'],
      AVAILABLE: ['RESERVED', 'PAUSED', 'OFFLINE'],
      RESERVED: ['DIALING', 'AVAILABLE', 'PAUSED', 'OFFLINE'],
      DIALING: ['CONNECTED', 'WRAP_UP', 'AVAILABLE', 'PAUSED', 'OFFLINE'],
      CONNECTED: ['WRAP_UP', 'AVAILABLE', 'PAUSED', 'OFFLINE'],
      WRAP_UP: ['AVAILABLE', 'PAUSED', 'OFFLINE'],
      PAUSED: ['AVAILABLE', 'OFFLINE'],
    };
    return from === to || allowed[from].includes(to);
  }
}
