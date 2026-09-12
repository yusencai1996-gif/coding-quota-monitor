import {createHash}from'node:crypto';import{readFile}from'node:fs/promises';
import{atomicWrite}from'./storage';import{NAMES,type ProviderState}from'./model';
import type{Notice}from'./notification-ledger';import type{DeliveryResult}from'./notification-delivery';
interface Entry{low:boolean;sent:boolean;cycle:number|null;seen:number}
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
// Persistent episodes are per account and window, never per calendar day.
export class LowQuotaNotices{
 private chain:Promise<unknown>=Promise.resolve();private entries:Record<string,Entry>={};private loaded=false;private attempts=new Map<string,number>();
 constructor(private path:string,private send:(n:Notice)=>Promise<DeliveryResult>){}
 private async load(){if(this.loaded)return;try{const raw=JSON.parse(await readFile(this.path,'utf8'));if(raw.schema!==1||!raw.entries||typeof raw.entries!=='object')throw Error('schema');for(const [key,value]of Object.entries(raw.entries)){const v=value as Entry;if(/^[a-f0-9]{64}$/.test(key)&&typeof v?.low==='boolean'&&typeof v.sent==='boolean'&&(v.cycle===null||Number.isFinite(v.cycle))&&Number.isFinite(v.seen))this.entries[key]={low:v.low,sent:v.sent,cycle:v.cycle,seen:v.seen};}}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw Error('notification-storage');}this.loaded=true;}
 private save(){return atomicWrite(this.path,JSON.stringify({schema:1,entries:this.entries}));}
 observe(state:ProviderState,scope:string,allowed:()=>boolean,now=Date.now()){
  if(state.status!=='ok'||!state.enabled||!state.data||!scope)return Promise.resolve();
  const id=state.id,windows=state.data.windows.map(w=>({...w}));
  const job=this.chain.then(async()=>{await this.load();let changed=false;
   for(const [key,v]of Object.entries(this.entries))if(v.seen<now-90*86400000){delete this.entries[key];changed=true;}
   const pending:{key:string;label:string;remaining:number}[]=[];
   for(const w of windows){if(w.remaining===null&&!w.unlimited)continue;const key=digest(id+'\0'+scope+'\0'+(w.id??w.label));const old=this.entries[key];const low=!w.unlimited&&w.remaining!==null&&w.remaining<=10;
    const newCycle=old?.cycle!==null&&old?.cycle!==undefined&&w.resetAt!==null&&w.resetAt>old.cycle&&now>=old.cycle;
    const sent=low&&old?.low&&!newCycle?old.sent:false;if(!low||newCycle)this.attempts.delete(key);
    // Missing reset metadata is unknown, not evidence that the previous cycle vanished.
    this.entries[key]={low,sent,cycle:w.resetAt??old?.cycle??null,seen:now};changed=true;
    if(low&&!sent)pending.push({key,label:w.label,remaining:w.remaining!});
   }
   if(changed)await this.save();
   for(const p of pending){if(!allowed())break;if(now-(this.attempts.get(p.key)??-Infinity)<60000)continue;this.attempts.set(p.key,now);
    const notice={key:p.key,expires:now+86400000,title:NAMES[id]+' 额度提醒',body:p.label+'剩余 '+Math.round(p.remaining)+'%，已不超过 10%。'};
    let result:DeliveryResult;try{result=await this.send(notice);}catch{result='failed';}
    if(result==='shown'){this.entries[p.key].sent=true;await this.save();}
   }
  });this.chain=job.catch(()=>{});return job;
 }
 settled(){return this.chain;}
}
