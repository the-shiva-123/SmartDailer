import { SmartDialer } from '../src/core/SmartDialer';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function runScenario(name:string,answerRate:number,talkTimeSeconds:number,dynamic=false){
  const dialer=new SmartDialer();const campaignId=name;await dialer.seed(20,300,campaignId);console.log(`\n=== Scenario ${name}: answerRate=${Math.round(answerRate*100)}%, avgTalk=${talkTimeSeconds}s${dynamic?' (dynamic volatility)':''} ===`);
  for(let tick=0;tick<12;tick++){
    const rate=dynamic?(tick<4?0.7:tick<8?0.15:0.5):answerRate;
    if(dynamic&&tick===5)await dialer.state.dropAvailableAgents(8);
    const mode: 'PROGRESSIVE'|'PREDICTIVE'='PREDICTIVE';const requested=Math.ceil((await dialer.state.countAvailableAgents())/Math.max(rate,0.1));
    const result=await dialer.dial(campaignId,mode,requested,rate);
    await sleep(Math.min(180,Math.max(60,talkTimeSeconds/2)));
    const m=await dialer.metrics();console.log(`[${String(tick+1).padStart(2,'0')}] avail=${m.availableAgents} util=${m.agentUtilizationPct.toFixed(1)}% initiated=${m.callsInitiated} connected=${m.callsConnected} abandon=${m.abandonmentRatePct.toFixed(1)}% safety=${m.safetyInterventions} approved=${result.decision.approved} mode=${result.decision.mode} provider=${m.activeProvider}${m.providerCircuitOpen?'(circuit-open)':''}`);
    // Simulated talk-time completion is shortened for a fast local demo; provider mock events also complete calls.
    if(tick%3===2){const snap=await dialer.state.snapshot();for(const a of snap.agents)if(a.state==='WRAP_UP')await dialer.state.finishWrapUp(a.id);}
  }
}
(async()=>{await runScenario('A',0.2,120);await runScenario('B',0.5,90);await runScenario('C',0.7,180);await runScenario('D',0.5,90,true);console.log('\nSimulation complete. Provider timing and answer outcomes are stochastic.');})().catch(e=>{console.error(e);process.exitCode=1;});
