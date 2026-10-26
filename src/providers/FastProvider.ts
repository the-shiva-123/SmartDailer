import { BaseMockProvider, ProviderListener } from './ITelecomProvider';
export class FastProvider extends BaseMockProvider {
  readonly name='ProviderA';
  async initiate(callId:string,listener:ProviderListener):Promise<void>{this.attempts++;if(Math.random()<0.015){this.failures++;throw new Error('Provider A simulated initiation failure');}void (async()=>{await this.emit(callId,'RINGING',listener,15);if(Math.random()<0.5){await this.emit(callId,'ANSWERED',listener,25);await this.emit(callId,'CONNECTED',listener,5);await this.emit(callId,'COMPLETED',listener,100+Math.floor(Math.random()*100));}else{await this.emit(callId,'COMPLETED',listener,80);}})().catch(()=>{});}
}
