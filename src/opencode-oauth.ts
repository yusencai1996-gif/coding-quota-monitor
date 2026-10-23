import {createServer, type Server, type IncomingMessage, type ServerResponse} from 'node:http';
import {randomBytes, createHash, timingSafeEqual} from 'node:crypto';
import {mkdir, readFile, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {SafeError, type ErrorCode} from './model';
import {atomicWrite, type CryptoPort} from './storage';

export const OPENCODE_OAUTH = Object.freeze({
 issuer:'https://opencode.ai/console',
 register:'https://opencode.ai/console/auth/oauth/register',
 authorize:'https://opencode.ai/console/oauth/authorize',
 token:'https://opencode.ai/console/auth/oauth/token',
 revoke:'https://opencode.ai/console/auth/oauth/revoke',
 resource:'https://opencode.ai/console/mcp',
});
export interface OpenCodeOAuthSnapshot {status:'idle'|'pending'|'connected'|'error';error?:ErrorCode}
export interface OpenCodeOAuthOptions {
 root:string;
 crypto:CryptoPort;
 fetcher:typeof fetch;
 openExternal:(url:string)=>Promise<unknown>;
 onChange?:()=>void;
 /** Shorter deadlines are useful for synthetic tests; production uses five minutes / 15 seconds. */
 timeoutMs?:number;
 requestTimeoutMs?:number;
 now?:()=>number;
}
interface StoredAuthorization {version:1;clientId:string;refreshToken:string}
interface Token {value:string;expiresAt:number}
interface Login {
 epoch:number;controller:AbortController;server:Server;state:string;verifier:string;
 redirectUri:string;clientId?:string;consumed:boolean;timer?:ReturnType<typeof setTimeout>;
 resolve:()=>void;reject:(error:SafeError)=>void;promise:Promise<void>;
}
const MAX_BODY=64*1024;
const secret=(v:unknown,max=16384):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\x00-\x20\x7f]/.test(v);
const safe=(e:unknown)=>e instanceof SafeError?e:new SafeError('network');
const aborted=()=>new SafeError('auth');

/** Main-process only: access/refresh tokens must never be sent through renderer IPC. */
export class OpenCodeOAuth {
 private chain:Promise<unknown>=Promise.resolve();
 private login?:Login;
 private opening?:Promise<void>;
 private refreshing?:Promise<string>;
 private loggingOut?:Promise<void>;
 private token?:Token;
 private epoch=0;
 private closed=false;
 private requests=new Set<AbortController>();
 private state:OpenCodeOAuthSnapshot={status:'idle'};
 private readonly path:string;
 constructor(private options:OpenCodeOAuthOptions){this.path=join(options.root,'opencode-oauth.sealed');}
 snapshot():OpenCodeOAuthSnapshot{return {...this.state};}
 private publish(state:OpenCodeOAuthSnapshot){this.state=state;try{this.options.onChange?.();}catch{/* A UI observer cannot interrupt credential cleanup. */}}
 private serial<T>(work:()=>Promise<T>):Promise<T>{const next=this.chain.then(work);this.chain=next.catch(()=>{});return next;}
 private current(epoch:number){if(this.closed||epoch!==this.epoch)throw aborted();}
 private async readStored():Promise<StoredAuthorization|undefined>{
  try{
   const bytes=await readFile(this.path);
   if(bytes.length>MAX_BODY||!await this.options.crypto.available())throw new SafeError('storage');
   const value=JSON.parse(await this.options.crypto.decrypt(bytes));
   if(value?.version!==1||!secret(value.clientId,4096)||!secret(value.refreshToken))throw new SafeError('storage');
   return {version:1,clientId:value.clientId,refreshToken:value.refreshToken};
  }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw new SafeError('storage');}
 }
 async has():Promise<boolean>{await this.chain;return !!await this.readStored();}
 private save(value:StoredAuthorization,epoch:number){return this.serial(async()=>{
  this.current(epoch);
  try{
   if(!await this.options.crypto.available())throw new SafeError('storage');
   const bytes=await this.options.crypto.encrypt(JSON.stringify(value));
   if(!bytes.length||bytes.length>MAX_BODY)throw new SafeError('storage');
   this.current(epoch);
   await mkdir(this.options.root,{recursive:true});
   this.current(epoch);
   let previous:Buffer|undefined;
   try{previous=await readFile(this.path);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
   this.current(epoch);
   await atomicWrite(this.path,bytes);
   // Cancellation can arrive during an asynchronous rename. Restore the prior encrypted
   // record before releasing the write queue, so a cancelled login never becomes durable.
   if(this.closed||epoch!==this.epoch){if(previous)await atomicWrite(this.path,previous);else await unlink(this.path);throw aborted();}
  }catch(e){if(e instanceof SafeError)throw e;throw new SafeError('storage');}
 });}
 private async request(url:string,init:RequestInit,signal?:AbortSignal,json=true):Promise<Record<string,unknown>>{
  if(!([OPENCODE_OAUTH.register,OPENCODE_OAUTH.token,OPENCODE_OAUTH.revoke] as string[]).includes(url))throw new SafeError('schema');
  const controller=new AbortController();this.requests.add(controller);
  let expired=false;
  const timer=setTimeout(()=>{expired=true;controller.abort();},this.options.requestTimeoutMs??15000);
  const cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});
  if(signal?.aborted)controller.abort();
  let rejectAbort!:(reason:SafeError)=>void;
  const stopped=new Promise<never>((_,reject)=>{rejectAbort=reject;});
  const onAbort=()=>rejectAbort(new SafeError(expired?'timeout':'auth'));
  controller.signal.addEventListener('abort',onAbort,{once:true});
  if(controller.signal.aborted)onAbort();
  try{
   return await Promise.race([(async()=>{
    const response=await this.options.fetcher(url,{...init,redirect:'error',credentials:'omit',signal:controller.signal});
    if(!response.ok)throw new SafeError(response.status===401||response.status===403||response.status===400?'auth':response.status===429?'rateLimit':'network');
    const length=response.headers.get('content-length');
    if(length&&(!/^\d+$/.test(length)||Number(length)>MAX_BODY))throw new SafeError('schema');
    const reader=response.body?.getReader();let size=0;const chunks:Uint8Array[]=[];
    if(reader)try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BODY)throw new SafeError('schema');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
    if(!json)return {};
    try{const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!data||typeof data!=='object'||Array.isArray(data))throw 0;return data;}catch{throw new SafeError('schema');}
   })(),stopped]);
  }catch(e){throw safe(e);}finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);controller.signal.removeEventListener('abort',onAbort);controller.abort();this.requests.delete(controller);}
 }
 private form(url:string,body:Record<string,string>,signal?:AbortSignal,json=true){return this.request(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:new URLSearchParams(body).toString()},signal,json);}
 private parseToken(data:Record<string,unknown>):Token{
  if(!secret(data.access_token)||typeof data.token_type!=='string'||data.token_type.toLowerCase()!=='bearer'||typeof data.expires_in!=='number'||!Number.isFinite(data.expires_in)||data.expires_in<=0||data.expires_in>365*86400)throw new SafeError('schema');
  return {value:data.access_token,expiresAt:(this.options.now?.()??Date.now())+data.expires_in*1000};
 }
 begin():Promise<void>{
  if(this.closed)return Promise.reject(aborted());
  if(this.loggingOut)return this.loggingOut.then(()=>this.begin());
  if(this.opening)return this.opening;
  const epoch=++this.epoch;
  // An old refresh may finish its network request, but its epoch can no longer save or publish.
  for(const request of this.requests)request.abort();this.refreshing=undefined;
  const work=this.start(epoch);
  this.opening=work;
  void work.catch(()=>{}).finally(()=>{if(this.opening===work)this.opening=undefined;});
  return work;
 }
 private async start(epoch:number){
  this.publish({status:'pending'});
  let resolve!:()=>void,reject!:(error:SafeError)=>void;
  const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});void promise.catch(()=>{});
  const server=createServer({maxHeaderSize:8192},(req,res)=>{void this.callback(login,req,res).catch(()=>this.finish(login,new SafeError('network')));});
  const login:Login={epoch,controller:new AbortController(),server,state:randomBytes(32).toString('base64url'),verifier:randomBytes(32).toString('base64url'),redirectUri:'',consumed:false,resolve,reject,promise};
  this.login=login;
  server.requestTimeout=5000;server.headersTimeout=5000;server.keepAliveTimeout=1;
  login.timer=setTimeout(()=>this.finish(login,new SafeError('timeout')),this.options.timeoutMs??300000);
  try{
   if(!await this.options.crypto.available())throw new SafeError('storage');
   this.current(epoch);
   await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',no);yes();});});
   this.current(epoch);
   server.on('error',()=>this.finish(login,new SafeError('network')));
   const address=server.address();if(!address||typeof address==='string')throw new SafeError('network');
   login.redirectUri=`http://127.0.0.1:${address.port}/oauth/callback/${randomBytes(16).toString('hex')}`;
   const registration=await this.request(OPENCODE_OAUTH.register,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({client_name:'Coding Quota Monitor',redirect_uris:[login.redirectUri],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'})},login.controller.signal);
   this.current(epoch);
   if(!secret(registration.client_id,4096)||(registration.token_endpoint_auth_method!==undefined&&registration.token_endpoint_auth_method!=='none'))throw new SafeError('schema');
   const clientId=registration.client_id;
   // This closure is installed only after the exact registered callback is known.
   login.clientId=clientId;
   const url=new URL(OPENCODE_OAUTH.authorize);
   url.search=new URLSearchParams({response_type:'code',client_id:clientId,redirect_uri:login.redirectUri,state:login.state,code_challenge:createHash('sha256').update(login.verifier).digest('base64url'),code_challenge_method:'S256',resource:OPENCODE_OAUTH.resource}).toString();
   void Promise.resolve(this.options.openExternal(url.toString())).catch(e=>this.finish(login,safe(e)));
  }catch(e){this.finish(login,safe(e));}
  return promise;
 }
 private reply(res:ServerResponse,status:number,message:string){res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",'Referrer-Policy':'no-referrer','Connection':'close'});res.end(message);}
 private async callback(login:Login,req:IncomingMessage,res:ServerResponse){
  const expected=new URL(login.redirectUri||'http://127.0.0.1/invalid');
  if(this.login!==login||login.consumed||req.method!=='GET'||req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==expected.host||req.headers.origin!==undefined&&req.headers.origin!==expected.origin||!req.url?.startsWith('/')||req.url.startsWith('//')){this.reply(res,400,'Invalid authorization callback.');return;}
  let url:URL;try{url=new URL(req.url,expected.origin);}catch{this.reply(res,400,'Invalid authorization callback.');return;}
  const keys=[...url.searchParams.keys()];
  const state=url.searchParams.get('state');
  if(url.origin!==expected.origin||url.pathname!==expected.pathname||keys.some((key,index)=>keys.indexOf(key)!==index||!['state','code','error','error_description','error_uri','iss'].includes(key))||!state||Buffer.byteLength(state)!==Buffer.byteLength(login.state)||!timingSafeEqual(Buffer.from(state),Buffer.from(login.state))||(url.searchParams.has('iss')&&url.searchParams.get('iss')!==OPENCODE_OAUTH.issuer)){
   this.reply(res,400,'Invalid authorization callback.');return;
  }
  const code=url.searchParams.get('code'),error=url.searchParams.get('error');
  if((code!==null)===(error!==null)||code!==null&&!secret(code,8192)){this.reply(res,400,'Invalid authorization callback.');return;}
  login.consumed=true;
  if(error!==null){this.reply(res,400,'Authorization was not completed.');this.finish(login,new SafeError('auth'));return;}
  this.reply(res,200,'Authorization received. You can return to Coding Quota Monitor.');
  try{
   const clientId=login.clientId;if(!clientId)throw new SafeError('auth');
   const data=await this.form(OPENCODE_OAUTH.token,{grant_type:'authorization_code',client_id:clientId,code:code!,code_verifier:login.verifier,redirect_uri:login.redirectUri,resource:OPENCODE_OAUTH.resource},login.controller.signal);
   this.current(login.epoch);
   const token=this.parseToken(data);if(!secret(data.refresh_token))throw new SafeError('schema');
   await this.save({version:1,clientId,refreshToken:data.refresh_token},login.epoch);
   this.current(login.epoch);this.token=token;this.finish(login);
  }catch(e){this.finish(login,safe(e));}
 }
 private finish(login:Login,error?:SafeError){
  if(this.login!==login)return;
  if(error&&this.epoch===login.epoch)++this.epoch;
  this.login=undefined;this.opening=undefined;clearTimeout(login.timer);login.controller.abort();login.server.close();login.server.closeAllConnections();
  login.state='';login.verifier='';
  if(error){this.publish({status:'error',error:error.code});login.reject(error);}else{this.publish({status:'connected'});login.resolve();}
 }
 cancel():void{if(this.login){++this.epoch;this.finish(this.login,aborted());}}
 async accessToken(signal?:AbortSignal):Promise<string>{
  if(this.closed||this.loggingOut||this.opening||this.login||signal?.aborted)throw aborted();
  const epoch=this.epoch;
  if(this.token&&this.token.expiresAt>(this.options.now?.()??Date.now())+30000)return this.token.value;
  if(!this.refreshing){
   const work=this.refresh(epoch);this.refreshing=work;
   void work.catch(()=>{}).finally(()=>{if(this.refreshing===work)this.refreshing=undefined;});
  }
  if(!signal)return this.refreshing;
  const pending=this.refreshing;
  return new Promise<string>((resolve,reject)=>{const cancel=()=>reject(aborted());signal.addEventListener('abort',cancel,{once:true});void pending.then(resolve,reject).finally(()=>signal.removeEventListener('abort',cancel));});
 }
 private async refresh(epoch:number):Promise<string>{
  await this.chain;this.current(epoch);const stored=await this.readStored();this.current(epoch);
  if(!stored)throw new SafeError('unconfigured');
  try{
   const data=await this.form(OPENCODE_OAUTH.token,{grant_type:'refresh_token',client_id:stored.clientId,refresh_token:stored.refreshToken,resource:OPENCODE_OAUTH.resource});
   this.current(epoch);const token=this.parseToken(data);
   if(data.refresh_token!==undefined&&!secret(data.refresh_token))throw new SafeError('schema');
   await this.save({...stored,refreshToken:typeof data.refresh_token==='string'?data.refresh_token:stored.refreshToken},epoch);
   this.current(epoch);this.token=token;this.publish({status:'connected'});return token.value;
  }catch(e){this.current(epoch);const error=safe(e);if(error.code==='auth')this.token=undefined;this.publish({status:'error',error:error.code});throw error;}
 }
 logout():Promise<void>{
  if(this.loggingOut)return this.loggingOut;
  ++this.epoch;if(this.login)this.finish(this.login,aborted());
  for(const request of this.requests)request.abort();this.token=undefined;this.refreshing=undefined;this.publish({status:'idle'});
  const work=(async()=>{
   const stored=await this.serial(async()=>{
    let stored:StoredAuthorization|undefined;try{stored=await this.readStored();}finally{try{await unlink(this.path);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw new SafeError('storage');}}return stored;
   });
   if(stored&&!this.closed)try{await this.form(OPENCODE_OAUTH.revoke,{token:stored.refreshToken,token_type_hint:'refresh_token',client_id:stored.clientId},undefined,false);}catch{/* Local disconnection remains effective if the official revoke service is unavailable. */}
  })();
  this.loggingOut=work;void work.catch(()=>{}).finally(()=>{if(this.loggingOut===work)this.loggingOut=undefined;});return work;
 }
 async close():Promise<void>{this.closed=true;++this.epoch;if(this.login)this.finish(this.login,aborted());for(const request of this.requests)request.abort();this.token=undefined;await this.chain;}
}
