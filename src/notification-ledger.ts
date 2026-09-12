import {createHash}from'node:crypto';import {mkdir,readFile}from'node:fs/promises';import{dirname}from'node:path';
import {atomicWrite}from'./storage';import {usableCards}from'./presentation';import type{ResetCards}from'./activity-model';import type{Provider}from'./model';
import type{DeliveryResult}from'./notification-delivery';
export interface Notice {key:string;expires:number;title:string;body:string}
// IDs are opaque digests; no account/credential/card identifiers are stored or shown.
export function cardNotices(id:Provider,scope:string,data:ResetCards,now=Date.now()):Notice[]{const seen=new Map<string,number>();return usableCards(data,id,now).cards.filter(c=>c.expiresAt!==null&&c.expiresAt-now<=3*86400000).map(c=>{const signature=c.kind+':'+c.expiresAt;const ordinal=seen.get(signature)??0;seen.set(signature,ordinal+1);return {key:createHash('sha256').update(id+'\0'+scope+'\0'+signature).digest('hex'),expires:c.expiresAt!,title:(id==='glm'?'GLM':'Codex')+' 重置卡即将到期',body:'有可用重置卡将在 3 天内到期，请在官方平台查看。'};});}
export class NotificationLedger {
 private chain:Promise<unknown>=Promise.resolve();
 private attempts=new Map<string,number>();
 constructor(private path:string,private send:(n:Notice)=>Promise<DeliveryResult>){}
 async deliver(notices:Notice[],allowed:()=>boolean,now=Date.now()){const job=this.chain.then(async()=>{if(!allowed())return;let saved:Record<string,number>={};try{const raw=JSON.parse(await readFile(this.path,'utf8'));if(raw.schema!==1||!raw.sent||typeof raw.sent!=='object')return;for(const [key,value]of Object.entries(raw.sent))if(/^[a-f0-9]{64}$/.test(key)&&typeof value==='number'&&value>now)saved[key]=value;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')return;}
 for(const notice of notices){if(!allowed())return;if(saved[notice.key]||notice.expires<=now||now-(this.attempts.get(notice.key)??-Infinity)<60000)continue;this.attempts.set(notice.key,now);if(await this.send(notice)!=='shown')continue;saved[notice.key]=notice.expires;await mkdir(dirname(this.path),{recursive:true});await atomicWrite(this.path,JSON.stringify({schema:1,sent:saved}));}});this.chain=job.catch(()=>{});await job;}
 settled(){return this.chain;}
}
