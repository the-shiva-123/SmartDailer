import { ProviderEvent, ProviderEventType } from '../types';
export type ProviderListener = (event: ProviderEvent) => Promise<void> | void;
export interface ITelecomProvider { readonly name: string; initiate(callId: string, listener: ProviderListener): Promise<void>; health(): { failures:number; attempts:number; errorRate:number }; }
export abstract class BaseMockProvider implements ITelecomProvider {
  abstract readonly name: string; protected attempts=0; protected failures=0;
  abstract initiate(callId:string,listener:ProviderListener):Promise<void>;
  health(){return {attempts:this.attempts,failures:this.failures,errorRate:this.attempts?this.failures/this.attempts:0};}
  protected async emit(callId:string,type:ProviderEventType,listener:ProviderListener,delayMs:number){await new Promise(r=>setTimeout(r,delayMs));await listener({eventId:`${this.name}-${callId}-${type}-${Math.random().toString(36).slice(2,9)}`,callId,type,occurredAt:Date.now(),provider:this.name});}
}
