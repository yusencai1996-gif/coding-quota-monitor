import{sourcePath,type Source}from'./sources';
import {readFile,stat} from 'node:fs/promises';
import {SafeError,type Provider} from './model';
import {parse} from './parsers';
export const ENDPOINTS:Record<Provider,string>={glm:'https://open.bigmodel.cn/api/monitor/usage/quota/limit',minimax:'https://www.minimaxi.com/v1/token_plan/remains',kimi:'https://api.kimi.com/coding/v1/usages',codex:'https://chatgpt.com/backend-api/wham/usage',deepseek:'https://api.deepseek.com/user/balance',opencode:'https://opencode.ai/zen/go/v1/usage'};
export async function requestQuota(id:Provider,key:string,signal:AbortSignal,fetcher:typeof fetch=fetch,account?:string){
 const headers:Record<string,string>={Authorization:id==='glm'?key:'Bearer '+key,Accept:'application/json'};if(id==='codex'&&account)headers['ChatGPT-Account-Id']=account;
 const res=await fetcher(ENDPOINTS[id],{method:'GET',headers,signal,redirect:'error'});
 if(!res.ok){await res.body?.cancel();throw new SafeError(res.status===401||res.status===403?'auth':res.status===429?'rateLimit':'network');}
 // Bound the body, including chunked responses. Raw response content is never logged or sent to renderer.
 const reader=res.body?.getReader();if(!reader)throw new SafeError('schema');let length=0;const chunks:Uint8Array[]=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>1024*1024){await reader.cancel();throw new SafeError('schema');}chunks.push(value);}}finally{reader.releaseLock();}
 let raw:unknown;try{raw=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new SafeError('schema');}return parse(id,raw);
}
export async function readCodexCredentials(source?:Source):Promise<{key:string;account?:string}>{
 // Explicit opt-in only. No token refresh, cache, claims parsing or write-back.
 if(!source?.enabled)throw new SafeError('unconfigured');
 let auth:any;try{const path=sourcePath(source,'file');if((await stat(path)).size>1024*1024)throw Error('size');auth=JSON.parse(await readFile(path,'utf8'));}catch{throw new SafeError('auth');}
 const access=auth?.tokens?.access_token,account=auth?.tokens?.account_id;
 if(typeof access!=='string'||!access||/[\r\n]/.test(access))throw new SafeError('auth');
 return {key:access,account:typeof account==='string'&&!/[\r\n]/.test(account)?account:undefined};
}
export async function queryCodex(signal:AbortSignal,fetcher:typeof fetch=fetch,source?:Source){
 const c=await readCodexCredentials(source);return requestQuota('codex',c.key,signal,fetcher,c.account);
}
