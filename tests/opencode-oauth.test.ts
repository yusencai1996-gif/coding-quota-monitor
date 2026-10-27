import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,unlink,rmdir} from 'node:fs/promises';
import {join} from 'node:path';
import {request} from 'node:http';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {testPrefix} from './test-paths';
import {OpenCodeOAuth,OPENCODE_OAUTH,type OpenCodeOAuthOptions} from '../src/opencode-oauth';
import {SafeError} from '../src/model';

const cipher={available:async()=>true,encrypt:async(value:string)=>Buffer.from(Buffer.from(value).map(x=>x^197)),decrypt:async(value:Buffer)=>Buffer.from(value.map(x=>x^197)).toString()};
const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>resolve=yes);return {promise,resolve};}
async function callback(url:URL,headers:Record<string,string>={}){return new Promise<{status:number;body:string;headers:import('node:http').IncomingHttpHeaders}>((resolve,reject)=>{const req=request(url,{headers},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode!,body,headers:res.headers}));});req.on('error',reject);req.end();});}
function replyUrl(authorize:URL,changes:Record<string,string>={}){const url=new URL(authorize.searchParams.get('redirect_uri')!);url.search=new URLSearchParams({state:authorize.searchParams.get('state')!,code:'SYNTHETIC-CODE',...changes}).toString();return url;}
async function harness(extra:Partial<OpenCodeOAuthOptions>={},handler?:(url:string,init:RequestInit)=>Promise<Response>){
 const root=await mkdtemp(testPrefix('oauth-unit-')),opened=deferred<URL>();
 const calls:{url:string;init:RequestInit}[]=[];
 const fetcher=(async(url:string|URL|Request,init:RequestInit)=>{
  calls.push({url:String(url),init});
  if(handler)return handler(String(url),init);
  if(String(url)===OPENCODE_OAUTH.register)return json({client_id:'SYNTHETIC-CLIENT',token_endpoint_auth_method:'none'});
  if(String(url)===OPENCODE_OAUTH.revoke)return new Response('',{status:200});
  return json({access_token:'SYNTHETIC-ACCESS',refresh_token:'SYNTHETIC-REFRESH',token_type:'Bearer',expires_in:60});
 }) as typeof fetch;
 const options:OpenCodeOAuthOptions={root,crypto:cipher,fetcher,openExternal:async url=>{opened.resolve(new URL(url));},timeoutMs:2000,requestTimeoutMs:1000,...extra};
 const oauth=new OpenCodeOAuth(options);
 return {oauth,root,options,opened:opened.promise,calls,async cleanup(){await oauth.close();await unlink(join(root,'opencode-oauth.sealed')).catch(()=>{});await unlink(join(root,'opencode-oauth.sealed.pending')).catch(()=>{});await rmdir(root);}};
}

test('OpenCode OAuth binds callback before registration, uses PKCE and stores only encrypted authorization',async()=>{
 let bound=false;
 const h=await harness({},async(url,init)=>{
  if(url===OPENCODE_OAUTH.register){const metadata=JSON.parse(String(init.body));const result=await callback(new URL(metadata.redirect_uris[0]));bound=result.status===400;assert.equal(metadata.token_endpoint_auth_method,'none');assert.deepEqual(metadata.grant_types,['authorization_code','refresh_token']);return json({client_id:'SYNTHETIC-CLIENT'});}
  return json({access_token:'SYNTHETIC-ACCESS',refresh_token:'SYNTHETIC-REFRESH',token_type:'Bearer',expires_in:60});
 });
 try{
  const started=h.oauth.begin(),url=await h.opened;
  assert.equal(h.oauth.begin(),started);assert.equal(h.oauth.snapshot().status,'pending');assert.ok(bound);
  assert.equal(url.origin+url.pathname,OPENCODE_OAUTH.authorize);assert.equal(url.searchParams.get('resource'),OPENCODE_OAUTH.resource);assert.equal(url.searchParams.get('code_challenge_method'),'S256');
  assert.equal((await callback(replyUrl(url,{iss:OPENCODE_OAUTH.issuer}))).status,200);await started;
  assert.equal(h.oauth.snapshot().status,'connected');assert.equal(await h.oauth.accessToken(),'SYNTHETIC-ACCESS');assert.equal(await h.oauth.has(),true);
  const exchange=new URLSearchParams(String(h.calls.find(call=>call.url===OPENCODE_OAUTH.token)!.init.body));
  assert.equal(createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url'),url.searchParams.get('code_challenge'));
  assert.equal(exchange.get('redirect_uri'),url.searchParams.get('redirect_uri'));assert.equal(exchange.get('resource'),OPENCODE_OAUTH.resource);
  for(const call of h.calls){assert.equal(call.init.redirect,'error');assert.equal(call.init.credentials,'omit');assert.ok(call.init.signal);}
  const bytes=await readFile(join(h.root,'opencode-oauth.sealed'));assert.ok(!bytes.includes(Buffer.from('SYNTHETIC')));
  const stored=JSON.parse(await cipher.decrypt(bytes));assert.equal(stored.refreshToken,'SYNTHETIC-REFRESH');assert.equal(stored.accessToken,undefined);
  await h.oauth.close();const reopened=new OpenCodeOAuth(h.options);assert.equal(await reopened.has(),true);await reopened.close();
 }finally{await h.cleanup();}
});

test('OpenCode callback rejects forged state, issuer, duplicate parameters, paths, Host and browser origins',async()=>{
 const h=await harness();
 try{
  const started=h.oauth.begin(),url=await h.opened;
  const wrongState=replyUrl(url,{state:'wrong'}),wrongIssuer=replyUrl(url,{iss:'https://evil.invalid'}),duplicate=replyUrl(url);duplicate.searchParams.append('state',url.searchParams.get('state')!);
  const duplicateCode=replyUrl(url);duplicateCode.searchParams.append('code','OTHER-CODE');
  const wrongPath=replyUrl(url);wrongPath.pathname='/unexpected';
  for(const bad of [wrongState,wrongIssuer,duplicate,duplicateCode,wrongPath])assert.equal((await callback(bad)).status,400);
  assert.equal((await callback(replyUrl(url),{Origin:'https://evil.invalid'})).status,400);
  assert.equal((await callback(replyUrl(url),{Host:'evil.invalid'})).status,400);
  assert.equal(h.calls.filter(call=>call.url===OPENCODE_OAUTH.token).length,0);
  assert.equal((await callback(replyUrl(url))).status,200);await started;
  assert.equal(h.calls.filter(call=>call.url===OPENCODE_OAUTH.token).length,1);
 }finally{await h.cleanup();}
});

test('OpenCode callback HTML clears sensitive query parameters under a fixed CSP without reflecting requests',async()=>{
 const cases=['received','invalid','declined'] as const;
 for(const kind of cases){
  const h=await harness();
  try{
   const started=h.oauth.begin(),settled=kind==='received'?started:assert.rejects(started,SafeError),authorize=await h.opened;
   const url=replyUrl(authorize,{code:'PRIVATE-CALLBACK-CODE'});
   if(kind==='invalid')url.searchParams.set('state','PRIVATE-INVALID-STATE');
   if(kind==='declined'){url.searchParams.delete('code');url.searchParams.set('error','access_denied');url.searchParams.set('error_description','PRIVATE-DESCRIPTION-<script>alert(1)</script>');url.searchParams.set('error_uri','https://private.invalid/PRIVATE-ERROR-URI');}
   const response=await callback(url);
   assert.equal(response.status,kind==='received'?200:400);
   assert.equal(response.headers['content-type'],'text/html; charset=utf-8');assert.equal(response.headers['cache-control'],'no-store');assert.equal(response.headers['referrer-policy'],'no-referrer');assert.equal(response.headers['x-content-type-options'],'nosniff');assert.equal(response.headers.location,undefined);
   assert.match(response.body,/<html lang="zh-CN">/);
   const title=/<title>(.*?)<\/title>/.exec(response.body)?.[1];assert.ok(title?.includes(kind==='received'?'授权已返回':kind==='invalid'?'回调无效':'授权未完成'));
   for(const sensitive of [url.toString(),authorize.searchParams.get('state')!,'PRIVATE-CALLBACK-CODE','PRIVATE-INVALID-STATE','PRIVATE-DESCRIPTION','PRIVATE-ERROR-URI','access_denied'])assert.ok(!response.body.includes(sensitive));
   assert.ok(!/<(?:script|link|img|iframe)\b[^>]*(?:src|href)\s*=/i.test(response.body));
   const scripts=[...response.body.matchAll(/<script>(.*?)<\/script>/gs)];assert.equal(scripts.length,1);
   const script=scripts[0][1],digest=createHash('sha256').update(script).digest('base64');
   const csp=response.headers['content-security-policy'];assert.equal(csp,`default-src 'none'; script-src 'sha256-${digest}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
   const location=new URL(url);let replaced=0;
   runInNewContext(script,{history:{replaceState:(state:unknown,unused:string,path:string)=>{assert.equal(state,null);assert.equal(unused,'');assert.equal(path,'/oauth/complete');location.href=new URL(path,location).href;replaced++;}}},{timeout:100});
   assert.equal(replaced,1);assert.equal(location.pathname,'/oauth/complete');assert.equal(location.search,'');assert.equal(location.origin,url.origin);
   runInNewContext(script,{history:{replaceState:()=>{throw new Error('disabled');}}},{timeout:100});
   if(kind==='invalid'){assert.equal(h.oauth.snapshot().status,'pending');h.oauth.cancel();}
   await settled;assert.equal(h.oauth.snapshot().status,kind==='received'?'connected':'error');
  }finally{await h.cleanup();}
 }
});

test('OpenCode rejects service body contents, oversized responses and missing refresh tokens without exposing details',async()=>{
 for(const response of [()=>new Response('PRIVATE-SERVER-CONTENT',{status:400}),()=>new Response('PRIVATE-SERVER-CONTENT'.repeat(4000)),()=>json({access_token:'SYNTHETIC-ACCESS',token_type:'Bearer',expires_in:60})]){
  const h=await harness({},async url=>url===OPENCODE_OAUTH.register?json({client_id:'SYNTHETIC-CLIENT'}):response());
  try{const started=h.oauth.begin();const rejected=assert.rejects(started,e=>e instanceof SafeError&&['auth','schema'].includes(e.message)&&!String(e).includes('PRIVATE'));await callback(replyUrl(await h.opened));await rejected;assert.equal(await h.oauth.has(),false);}
  finally{await h.cleanup();}
 }
});

test('OpenCode cancel and deadline settle authorization, close the callback and permit a new attempt',async()=>{
 const h=await harness({timeoutMs:100});
 try{
  const first=h.oauth.begin(),rejected=assert.rejects(first,e=>e instanceof SafeError&&e.code==='auth');const url=await h.opened;h.oauth.cancel();await rejected;
  await assert.rejects(callback(replyUrl(url)));
  await assert.rejects(h.oauth.begin(),e=>e instanceof SafeError&&e.code==='timeout');
  assert.equal(h.oauth.snapshot().error,'timeout');
 }finally{await h.cleanup();}
});

test('OpenCode request deadline also releases a fetcher that ignores abort',async()=>{
 const h=await harness({requestTimeoutMs:25},async()=>new Promise(()=>{}));
 try{await assert.rejects(h.oauth.begin(),e=>e instanceof SafeError&&e.code==='timeout');assert.equal(await h.oauth.has(),false);}
 finally{await h.cleanup();}
});

test('OpenCode immediate cancellation permits retry and close prevents a browser from opening',async()=>{
 let opens=0;
 const h=await harness({openExternal:async()=>{opens++;}});
 try{
  const first=h.oauth.begin(),rejected=assert.rejects(first,SafeError);h.oauth.cancel();
  const second=h.oauth.begin();assert.notEqual(second,first);const closed=assert.rejects(second,SafeError);await h.oauth.close();
  await Promise.all([rejected,closed]);assert.equal(opens,0);assert.equal(h.calls.length,0);assert.equal(await h.oauth.has(),false);
 }finally{await h.cleanup();}
});

test('OpenCode close or cancel during encryption cannot persist a late authorization',async()=>{
 for(const action of ['close','cancel'] as const){
  const encrypting=deferred<void>(),release=deferred<void>();
  const h=await harness({crypto:{...cipher,encrypt:async value=>{encrypting.resolve();await release.promise;return cipher.encrypt(value);}}});
  try{
   const started=h.oauth.begin(),rejected=assert.rejects(started,SafeError);await callback(replyUrl(await h.opened));await encrypting.promise;
   const closing=action==='close'?h.oauth.close():(h.oauth.cancel(),Promise.resolve());
   release.resolve();await closing;await rejected;assert.equal(await h.oauth.has(),false);
  }finally{release.resolve();await h.cleanup();}
 }
});

test('OpenCode overall deadline fences delayed encryption and leaves no token or sealed authorization',async()=>{
 const encrypting=deferred<void>(),release=deferred<void>();
 const h=await harness({timeoutMs:80,crypto:{...cipher,encrypt:async value=>{encrypting.resolve();await release.promise;return cipher.encrypt(value);}}});
 try{
  const started=h.oauth.begin(),rejected=assert.rejects(started,e=>e instanceof SafeError&&e.code==='timeout');
  await callback(replyUrl(await h.opened));await encrypting.promise;await rejected;release.resolve();
  assert.equal(await h.oauth.has(),false);assert.deepEqual(h.oauth.snapshot(),{status:'error',error:'timeout'});
  await assert.rejects(h.oauth.accessToken(),e=>e instanceof SafeError&&e.code==='unconfigured');
 }finally{release.resolve();await h.cleanup();}
});

test('OpenCode encryption unavailable fails before registering or opening the browser',async()=>{
 let opens=0;const h=await harness({crypto:{...cipher,available:async()=>false},openExternal:async()=>{opens++;}});
 try{await assert.rejects(h.oauth.begin(),e=>e instanceof SafeError&&e.code==='storage');assert.equal(opens,0);assert.equal(h.calls.length,0);}
 finally{await h.cleanup();}
});

test('OpenCode logout fences an in-flight code exchange and never resurrects its tokens',async()=>{
 const exchanging=deferred<void>(),result=deferred<Response>();
 const h=await harness({},async url=>{
  if(url===OPENCODE_OAUTH.register)return json({client_id:'SYNTHETIC-CLIENT'});
  exchanging.resolve();return result.promise;
 });
 try{
  const started=h.oauth.begin(),rejected=assert.rejects(started,e=>e instanceof SafeError&&e.code==='auth');await callback(replyUrl(await h.opened));await exchanging.promise;
  await h.oauth.logout();await rejected;result.resolve(json({access_token:'LATE-ACCESS',refresh_token:'LATE-REFRESH',token_type:'Bearer',expires_in:60}));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(await h.oauth.has(),false);assert.equal(h.oauth.snapshot().status,'idle');
  await assert.rejects(h.oauth.accessToken(),e=>e instanceof SafeError&&e.code==='unconfigured');
 }finally{await h.cleanup();}
});

test('OpenCode refresh is shared, rotates the encrypted token and logout revokes the latest authorization',async()=>{
 let now=1_000_000,refreshes=0;
 const h=await harness({now:()=>now},async(url,init)=>{
  if(url===OPENCODE_OAUTH.register)return json({client_id:'SYNTHETIC-CLIENT'});
  if(url===OPENCODE_OAUTH.revoke)return new Response('',{status:200});
  if(new URLSearchParams(String(init.body)).get('grant_type')==='refresh_token'){refreshes++;return json({access_token:'ROTATED-ACCESS',refresh_token:'ROTATED-REFRESH',token_type:'Bearer',expires_in:3600});}
  return json({access_token:'SYNTHETIC-ACCESS',refresh_token:'SYNTHETIC-REFRESH',token_type:'Bearer',expires_in:60});
 });
 try{
  const started=h.oauth.begin();await callback(replyUrl(await h.opened));await started;now+=60000;
  assert.deepEqual(await Promise.all([h.oauth.accessToken(),h.oauth.accessToken()]),['ROTATED-ACCESS','ROTATED-ACCESS']);assert.equal(refreshes,1);
  await h.oauth.logout();assert.equal(await h.oauth.has(),false);
  const revoke=new URLSearchParams(String(h.calls.find(call=>call.url===OPENCODE_OAUTH.revoke)!.init.body));assert.equal(revoke.get('token'),'ROTATED-REFRESH');assert.equal(revoke.get('client_id'),'SYNTHETIC-CLIENT');
 }finally{await h.cleanup();}
});

test('OpenCode logout wins over late refresh and close preserves existing encrypted authorization',async()=>{
 let now=1_000_000;const refreshing=deferred<void>(),late=deferred<Response>();
 const h=await harness({now:()=>now},async(url,init)=>{
  if(url===OPENCODE_OAUTH.register)return json({client_id:'SYNTHETIC-CLIENT'});
  if(url===OPENCODE_OAUTH.revoke)return new Response('',{status:200});
  if(new URLSearchParams(String(init.body)).get('grant_type')==='refresh_token'){refreshing.resolve();return late.promise;}
  return json({access_token:'SYNTHETIC-ACCESS',refresh_token:'SYNTHETIC-REFRESH',token_type:'Bearer',expires_in:60});
 });
 try{
  const started=h.oauth.begin();await callback(replyUrl(await h.opened));await started;now+=60000;
  const access=h.oauth.accessToken(),rejected=assert.rejects(access,SafeError);await refreshing.promise;
  await h.oauth.logout();late.resolve(json({access_token:'LATE-ACCESS',refresh_token:'LATE-REFRESH',token_type:'Bearer',expires_in:3600}));await rejected;
  await new Promise(resolve=>setImmediate(resolve));assert.equal(await h.oauth.has(),false);assert.equal(h.oauth.snapshot().status,'idle');
  await h.oauth.close();await assert.rejects(h.oauth.begin(),SafeError);await assert.rejects(h.oauth.accessToken(),SafeError);
 }finally{await h.cleanup();}
});

test('OpenCode monitoring pause cancels refresh without deleting encrypted authorization',async()=>{
 let now=1_000_000;const refreshing=deferred<void>(),late=deferred<Response>();
 const h=await harness({now:()=>now},async(url,init)=>{
  if(url===OPENCODE_OAUTH.register)return json({client_id:'SYNTHETIC-CLIENT'});
  if(new URLSearchParams(String(init.body)).get('grant_type')==='refresh_token'){refreshing.resolve();return late.promise;}
  return json({access_token:'SYNTHETIC-ACCESS',refresh_token:'SYNTHETIC-REFRESH',token_type:'Bearer',expires_in:60});
 });
 try{const started=h.oauth.begin();await callback(replyUrl(await h.opened));await started;now+=60000;const access=h.oauth.accessToken(),rejected=assert.rejects(access,SafeError);await refreshing.promise;h.oauth.cancel();await rejected;late.resolve(json({access_token:'LATE-ACCESS',refresh_token:'LATE-REFRESH',token_type:'Bearer',expires_in:3600}));await new Promise(r=>setImmediate(r));assert.equal(await h.oauth.has(),true);const stored=JSON.parse(await cipher.decrypt(await readFile(join(h.root,'opencode-oauth.sealed'))));assert.equal(stored.refreshToken,'SYNTHETIC-REFRESH');assert.equal(h.calls.filter(c=>c.url===OPENCODE_OAUTH.revoke).length,0);}finally{await h.cleanup();}
});
