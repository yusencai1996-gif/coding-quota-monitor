import {IDS,SafeError,safeCode,type Provider,type ProviderState,type Snapshot,type Settings} from './model';
export class Scheduler {
 states=Object.fromEntries(IDS.map(id=>[id,{id,enabled:true,busy:false,status:'idle',failures:0}])) as Record<Provider,ProviderState>;
 private runs=new Map<Provider,{controller:AbortController;generation:number}>();private generations=new Map<Provider,number>();private timers=new Map<Provider,ReturnType<typeof setTimeout>>();private stopped=false;private interval=300000;
 constructor(private query:(id:Provider,signal:AbortSignal)=>Promise<Snapshot>,private publish:()=>void,private timeout=20000){}
 configure(s:Settings){this.interval=s.intervalMinutes*60000;for(const id of IDS){const state=this.states[id];if(state.enabled!==s.enabled[id]){this.cancel(id);state.enabled=s.enabled[id];state.status=state.enabled?'idle':'disabled';}if(state.enabled&&!state.busy)this.schedule(id,this.interval);}this.publish();}
 private cancel(id:Provider){this.generations.set(id,(this.generations.get(id)??0)+1);this.runs.get(id)?.controller.abort();this.runs.delete(id);clearTimeout(this.timers.get(id));this.timers.delete(id);this.states[id].busy=false;delete this.states[id].nextAt;}
 invalidate(id:Provider){this.cancel(id);delete this.states[id].data;this.states[id].failures=0;this.states[id].status=this.states[id].enabled?'idle':'disabled';this.publish();}
 private schedule(id:Provider,delay:number){clearTimeout(this.timers.get(id));if(this.stopped||!this.states[id].enabled)return;this.states[id].nextAt=Date.now()+delay;this.timers.set(id,setTimeout(()=>void this.refresh(id),delay));}
 async refresh(id:Provider){const s=this.states[id];if(this.stopped||!s.enabled||s.busy)return;clearTimeout(this.timers.get(id));const controller=new AbortController(),generation=this.generations.get(id)??0;this.runs.set(id,{controller,generation});s.busy=true;s.status='refreshing';delete s.nextAt;this.publish();let timer:ReturnType<typeof setTimeout>|undefined;
  try {const data=await Promise.race([this.query(id,controller.signal),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new SafeError('timeout'));},this.timeout);})]);if(generation!==(this.generations.get(id)??0)||this.stopped)return;s.data=data;s.status='ok';s.failures=0;
  }catch(e){if(generation!==(this.generations.get(id)??0)||this.stopped)return;s.status=safeCode(e);s.failures++;}
  finally{clearTimeout(timer);if(this.runs.get(id)?.generation===generation){this.runs.delete(id);s.busy=false;this.schedule(id,Math.min(3600000,this.interval*2**Math.min(s.failures,4)));this.publish();}}
 }
 all(){for(const id of IDS)void this.refresh(id);}
 stop(){this.stopped=true;for(const id of IDS)this.cancel(id);}
}
