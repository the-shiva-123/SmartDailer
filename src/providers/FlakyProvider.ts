import { BaseMockProvider, ProviderListener } from './ITelecomProvider';
export class FlakyProvider extends BaseMockProvider {
  readonly name='ProviderB';
  async initiate(callId:string,listener:ProviderListener):Promise<void>{this.attempts++;await new Promise(r=>setTimeout(r,120+Math.floor(Math.random()*180)));if(Math.random()<0.15){this.failures++;throw new Error('Provider B simulated timeout');}void (async()=>{const answered=Math.random()<0.45;const events: Array<['RINGING'|'ANSWERED'|'CONNECTED'|'COMPLETED',number]>=answered?[['RINGING',60],['ANSWERED',90],['CONNECTED',25],['COMPLETED',220]]:[['RINGING',60],['COMPLETED',180]];for(const [type,delay] of events){await this.emit(callId,type,listener,delay);if(Math.random()<0.12)await this.emit(callId,type,listener,15);}if(Math.random()<0.2)await this.emit(callId,'ANSWERED',listener,20);})().catch(()=>{});}
}
