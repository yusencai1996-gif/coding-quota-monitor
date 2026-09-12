import {IDS,SafeError,safeCode,type Provider,type Settings}from'./model';
import type{AuxiliaryPublic,ActivityProvider,ActivityKind,TokenHistory,ResetCards}from'./activity-model';
import type{Credentials}from'./activity-requests';import type{HistoryStore}from'./history-store';
type Run={controller:AbortController;scope?:string};
export class Auxiliary {
 states:AuxiliaryPublic=Object.fromEntries(IDS.map(id=>[id,{history:{status:['glm','codex'].includes(id)?'idle':'unsupported',busy:false},cards:{status:['glm','codex'].includes(id)?'idle':'unsupported',busy:false}}])) as AuxiliaryPublic;
 private scopes=new Map<ActivityProvider,string>();private noticeScopes=new Map<ActivityProvider,string>();private runs=new Map<string,Run>();private timers=new Map<string,ReturnType<typeof setTimeout>>();private lastStart=new Map<string,number>();private enabled=new Map<Provider,boolean>();private stopped=false;
 constructor(private readCredentials:(id:ActivityProvider)=>Promise<Credentials>,private query:(id:ActivityProvider,kind:ActivityKind,c:Credentials,signal:AbortSignal)=>Promise<TokenHistory|ResetCards>,private store:HistoryStore,private publish:()=>void,private timeoutMs=20000,private minIntervalMs=60000) {for(const id of IDS)this.enabled.set(id,true);}
 private supported(id:Provider):id is ActivityProvider{return id==='glm'||id==='codex';}
 scopeFor(id:ActivityProvider){return this.noticeScopes.get(id)??this.scopes.get(id);}
 setNoticeScope(id:ActivityProvider,scope?:string){if(scope)this.noticeScopes.set(id,scope);}
 private schedule(id:ActivityProvider,kind:ActivityKind,delay:number){const key=id+':'+kind;clearTimeout(this.timers.get(key));if(this.stopped||!this.enabled.get(id))return;this.states[id][kind].nextAt=Date.now()+delay;this.timers.set(key,setTimeout(()=>void this.one(id,kind),delay));}
 private cancel(id:ActivityProvider,except?:Run){for(const kind of ['history','cards']as const){const key=id+':'+kind,run=this.runs.get(key);if(run&&run!==except){run.controller.abort();this.runs.delete(key);this.states[id][kind].busy=false;}clearTimeout(this.timers.get(key));this.timers.delete(key);}}
 invalidate(id:Provider){if(!this.supported(id))return;this.cancel(id);this.scopes.delete(id);this.noticeScopes.delete(id);for(const kind of ['history','cards']as const){this.states[id][kind]={status:'idle',busy:false};this.lastStart.delete(id+':'+kind);}this.publish();}
 observeScope(id:ActivityProvider,scope:string,except?:Run){if(this.scopes.get(id)===scope)return;if(!this.scopes.has(id)){this.scopes.set(id,scope);return;}this.cancel(id,except);this.scopes.set(id,scope);for(const kind of ['history','cards']as const){this.states[id][kind]={status:'idle',busy:this.runs.get(id+':'+kind)===except&&!!except};this.lastStart.delete(id+':'+kind);if(!this.states[id][kind].busy)this.schedule(id,kind,0);}this.publish();}
 configure(s:Settings){for(const id of ['glm','codex']as const){const changed=this.enabled.get(id)!==s.enabled[id];this.enabled.set(id,s.enabled[id]);if(!s.enabled[id]){this.cancel(id);for(const k of ['history','cards']as const)this.states[id][k].status='disabled';}else if(changed){for(const k of ['history','cards']as const)this.states[id][k].status='idle';void this.refresh(id);}}this.publish();}
 async refresh(id:Provider){if(!this.supported(id))return;await Promise.allSettled((['history','cards']as const).map(kind=>this.one(id,kind)));}
 all(){for(const id of ['glm','codex']as const)void this.refresh(id);}
 async one(id:ActivityProvider,kind:ActivityKind){const key=id+':'+kind;if(this.stopped||!this.enabled.get(id)||this.runs.has(key))return;const remaining=this.minIntervalMs-(Date.now()-(this.lastStart.get(key)??0));if(remaining>0){this.schedule(id,kind,remaining);this.publish();return;}
 const run:Run={controller:new AbortController()};this.runs.set(key,run);clearTimeout(this.timers.get(key));this.lastStart.set(key,Date.now());this.states[id][kind].busy=true;this.states[id][kind].status='refreshing';this.publish();let timer:ReturnType<typeof setTimeout>|undefined;
 const current=()=>this.runs.get(key)===run&&!run.controller.signal.aborted&&!this.stopped;
 const task=async()=>{const c=await this.readCredentials(id);if(!current())return;this.setNoticeScope(id,c.noticeScope);this.observeScope(id,c.scope,run);run.scope=c.scope;
  if(kind==='history'&&!this.states[id].history.data){const cached=await this.store.read(id,c.scope);if(current()&&this.scopes.get(id)===c.scope&&cached){this.states[id].history.data=cached;this.publish();}}
  const result=await this.query(id,kind,c,run.controller.signal);if(!current())return;const latest=await this.readCredentials(id);if(!current())return;if(latest.scope!==c.scope){this.observeScope(id,latest.scope);return;}if(this.scopes.get(id)!==c.scope)return;
  if(kind==='history'){const merged=await this.store.merge(id,c.scope,result as TokenHistory);if(current()&&this.scopes.get(id)===c.scope)this.states[id].history.data=merged;}else this.states[id].cards.data=result as ResetCards;
  if(current())this.states[id][kind].status='ok';};
 try{await Promise.race([task(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{run.controller.abort();reject(new SafeError('timeout'));},this.timeoutMs);})]);}
 catch(e){if(this.runs.get(key)===run)this.states[id][kind].status=safeCode(e);}
 finally{clearTimeout(timer);if(this.runs.get(key)===run){this.runs.delete(key);this.states[id][kind].busy=false;const delay=this.states[id][kind].status==='ok'?(kind==='history'?1800000:900000):1800000;this.schedule(id,kind,delay);this.publish();}}
 }
 stop(){this.stopped=true;for(const id of ['glm','codex']as const)this.cancel(id);}
}
