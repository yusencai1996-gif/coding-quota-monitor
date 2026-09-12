import type{Source}from'./sources';
import {createHash}from'node:crypto';
import {SafeError}from'./model';import {readCodexCredentials}from'./adapters';
import type{KeyStore}from'./storage';import type{ActivityProvider,ActivityKind}from'./activity-model';
import {calendarToday,shiftDate,parseHistory,parseCards}from'./activity-parsers';
export interface Credentials {key:string;account?:string;scope:string;noticeScope?:string}
export const accountScope=(id:string,value:string)=>createHash('sha256').update(id+'\0'+value).digest('hex');
export async function credentials(id:ActivityProvider,keys:KeyStore,codexSource?:Source):Promise<Credentials>{if(id==='codex'){const c=await readCodexCredentials(codexSource);if(!c.account)throw new SafeError('auth');return {...c,scope:accountScope(id,c.account+'\0'+c.key),noticeScope:accountScope('notice:'+id,c.account)};}const key=await keys.readForRequest(id);return {key,scope:accountScope(id,key)};}
export function activityRequest(id:ActivityProvider,kind:ActivityKind,c:Credentials,now=Date.now()){
 let url:string;const headers:Record<string,string>={Accept:'application/json',Authorization:'Bearer '+c.key};
 if(id==='codex'){url='https://chatgpt.com/backend-api/wham/'+(kind==='history'?'profiles/me':'rate-limit-reset-credits');if(c.account)headers['ChatGPT-Account-Id']=c.account;}
 else if(kind==='history'){const end=calendarToday(now);url='https://open.bigmodel.cn/api/monitor/credit-usage/activity?'+new URLSearchParams({startTime:shiftDate(end,-365)+' 00:00:00',endTime:end+' 23:59:59',type:'1'});}
 else{url='https://bigmodel.cn/api/biz/customer-package-reset/list?targetType=PERSONAL';headers.Authorization=c.key;headers.Referer='https://bigmodel.cn/coding-plan/personal/usage';}
 return {url,headers};
}
// This transport constructs every URL itself. It exposes no arbitrary URL or method input.
export async function queryActivity(id:ActivityProvider,kind:ActivityKind,c:Credentials,signal:AbortSignal,fetcher:typeof fetch=fetch){
 const {url,headers}=activityRequest(id,kind,c);const res=await fetcher(url,{method:'GET',headers,redirect:'error',signal});
 if(!res.ok){await res.body?.cancel();throw new SafeError(res.status===401||res.status===403?'auth':res.status===429?'rateLimit':'network');}
 const reader=res.body?.getReader();if(!reader)throw new SafeError('schema');const chunks:Uint8Array[]=[];let bytes=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>2*1024*1024){await reader.cancel();throw new SafeError('schema');}chunks.push(value);}}finally{reader.releaseLock();}
 let raw:unknown;try{raw=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new SafeError('schema');}
 return kind==='history'?parseHistory(id,raw):parseCards(id,raw);
}
