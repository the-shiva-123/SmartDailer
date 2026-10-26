export type AgentState = 'OFFLINE' | 'AVAILABLE' | 'RESERVED' | 'DIALING' | 'CONNECTED' | 'WRAP_UP' | 'PAUSED';
export type CallState = 'QUEUED' | 'RESERVED' | 'INITIATED' | 'RINGING' | 'ANSWERED' | 'CONNECTED' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type DialMode = 'PROGRESSIVE' | 'PREDICTIVE';
export type ProviderEventType = 'RINGING' | 'ANSWERED' | 'CONNECTED' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export interface Agent { id: string; state: AgentState; version: number; currentCallId?: string; stateChangedAt: number; }
export interface Call { id: string; borrowerId: string; campaignId: string; state: CallState; version: number; agentId?: string; provider?: string; createdAt: number; updatedAt: number; terminalReason?: string; }
export interface Borrower { id: string; campaignId: string; status: 'QUEUED' | 'RESERVED' | 'CALLED'; version: number; }
export interface ProviderEvent { eventId: string; callId: string; type: ProviderEventType; occurredAt: number; provider: string; }
export interface DialRequest { campaignId: string; mode: DialMode; requestedCalls: number; historicalAnswerRate?: number; }
export interface SafetyDecision { requested: number; approved: number; mode: DialMode; fallback: boolean; reason: string; availableAgents: number; ringingCalls: number; maxAllowedCalls: number; targetCalls: number; }
export interface Metrics { agents: number; availableAgents: number; utilizedAgents: number; agentUtilizationPct: number; callsInitiated: number; callsConnected: number; callsCompleted: number; callsFailed: number; ringingCalls: number; abandonedCalls: number; abandonmentRatePct: number; safetyInterventions: number; mode: DialMode; activeProvider: string; providerCircuitOpen: boolean; }
