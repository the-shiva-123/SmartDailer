import { CallState, ProviderEventType } from '../types';

export const EVENT_TO_STATE: Record<ProviderEventType, CallState> = {
  RINGING: 'RINGING',
  ANSWERED: 'ANSWERED',
  CONNECTED: 'CONNECTED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
};

const TERMINAL_STATES = new Set<CallState>(['COMPLETED', 'FAILED', 'CANCELLED']);

export function isTerminal(state: CallState): boolean {
  return TERMINAL_STATES.has(state);
}

/** Explicit call-state transition rules; terminal states never transition again. */
export function isBackwardOrDuplicate(current: CallState, next: CallState): boolean {
  if (current === next || isTerminal(current)) return true;

  const allowed: Record<CallState, CallState[]> = {
    QUEUED: ['RESERVED', 'FAILED', 'CANCELLED'],
    RESERVED: ['INITIATED', 'FAILED', 'CANCELLED'],
    INITIATED: ['RINGING', 'ANSWERED', 'CONNECTED', 'COMPLETED', 'FAILED', 'CANCELLED'],
    RINGING: ['ANSWERED', 'CONNECTED', 'COMPLETED', 'FAILED', 'CANCELLED'],
    ANSWERED: ['CONNECTED', 'COMPLETED', 'FAILED', 'CANCELLED'],
    CONNECTED: ['COMPLETED', 'FAILED', 'CANCELLED'],
    COMPLETED: [],
    FAILED: [],
    CANCELLED: [],
  };

  return !allowed[current].includes(next);
}
