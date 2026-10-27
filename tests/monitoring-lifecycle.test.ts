import{test}from'node:test';import assert from'node:assert/strict';import{EventEmitter}from'node:events';
import{mkdtemp,unlink,rmdir}from'node:fs/promises';import{join}from'node:path';import{DatabaseSync}from'node:sqlite';
import{testPrefix}from'./test-paths';import{HealthMonitor}from'../src/health';import{OpenCodeConnection,type OpenCodeConnectionState}from'../src/opencode-connection';import{WebLogin,type WebLoginPorts}from'../src/web-login';import{inspectZCode}from'../src/local-statistics';
const turn=()=>new Promise(r=>setTimeout(r,20));
const usage=(range:unknown)=>({structuredContent:{user_id:'SYNTHETIC-USER',range,requests:1,input_tokens:2,output_tokens:3,cache_read_tokens:4,cache_write_tokens:5,cost_usd:0}});
async function sandbox(work:(root:string)=>Promise<void>){const root=await mkdtemp(testPrefix('monitoring-'));try{await work(root);}finally{for(const n of ['web-login-enabled-v1.json','opencode-oauth.sealed','usage.sqlite'])await unlink(join(root,n)).catch(e=>{if(e.code!=='ENOENT')throw e;});await rmdir(root);}}

test('monitoring: disabled OpenCode never reads authorization; reenable restores silently',async()=>{
 let reads=0,requests=0,cancelled=0;const states:OpenCodeConnectionState[]=[];
 const auth={has:async()=>{reads++;return true;},begin:async()=>{throw Error('Unexpected browser');},cancel:()=>{cancelled++;},logout:async()=>{throw Error('Must retain authorization');},close:async()=>{},snapshot:()=>({status:'idle' as const})};
 const client={listTools:async()=>[{name:'get_usage',inputSchema:{}}],callReadTool:async(_n:string,a:Record<string,unknown>)=>{requests++;return usage(a.range);},close(){}};
 const c=new OpenCodeConnection(auth,()=>client,s=>states.push(s));try{c.configure(false);await c.open(false);await c.open(true);assert.equal(reads,0);assert.equal(requests,0);assert.equal(states.at(-1)?.status,'paused');assert.equal(cancelled,1);c.configure(true);await turn();assert.equal(states.at(-1)?.status,'connected');assert.equal(requests,4);c.configure(false);const before=requests;await c.open(false);assert.equal(requests,before);assert.equal(states.at(-1)?.usage,undefined);}finally{await c.close();}
});

test('monitoring: pausing OpenCode aborts and fences a late daily export',async()=>{
 let release!:(v:any)=>void,signal!:AbortSignal;const states:OpenCodeConnectionState[]=[];
 const auth={has:async()=>true,begin:async()=>{},cancel(){},logout:async()=>{},close:async()=>{},snapshot:()=>({status:'idle' as const})};
 const client={listTools:async()=>[{name:'get_usage',inputSchema:{}},{name:'get_context',inputSchema:{}}],callReadTool:async(n:string,a:Record<string,unknown>)=>n==='get_context'?{structuredContent:{user:{id:'SYNTHETIC-USER'},workspace:{id:'wrk_SYNTHETIC'}}}:usage(a.range),close(){}};
 const c=new OpenCodeConnection(auth,()=>client,s=>states.push(s),async(_o,_u,s)=>{signal=s;return new Promise(r=>release=r);});try{const work=c.open(false);await turn();c.configure(false);assert.equal(signal.aborted,true);release({schema:1,source:'opencode-export-v2',sourceTimezone:'UTC',updatedAt:Date.now(),days:[]});await work;assert.equal(states.at(-1)?.status,'paused');assert.equal(states.at(-1)?.history,undefined);}finally{await c.close();}
});

class FakePage extends EventEmitter{
 destroyed=false;visible:boolean;url='about:blank';webContents:any=new EventEmitter();
 constructor(options:any){super();this.visible=options.show;Object.assign(this.webContents,{setWindowOpenHandler(){},getURL:()=>this.url,executeJavaScript:async()=> 'SYNTHETIC-SESSION',debugger:Object.assign(new EventEmitter(),{attach(){},sendCommand:async()=>({})})});}
 isDestroyed(){return this.destroyed;}isVisible(){return this.visible;}show(){this.visible=true;}focus(){}destroy(){this.destroyed=true;this.emit('closed');}async loadURL(url:string){this.url=url;this.webContents.emit('did-finish-load');}
}
const dsBody=()=>new Response(JSON.stringify({data:{biz_data:{series:[],bucket:86400,start:1,end:2}}}));
function desktop(fetcher:typeof fetch){const windows:FakePage[]=[],options:any[]=[];let clears=0;const ses:any=Object.assign(new EventEmitter(),{setPermissionRequestHandler(){},setPermissionCheckHandler(){},fetch:fetcher,flushStorageData(){},cookies:{flushStore:async()=>{}},clearStorageData:async()=>{clears++;},clearCache:async()=>{}});const ports:WebLoginPorts={createWindow:o=>{options.push(o);const w=new FakePage(o);windows.push(w);return w as any;},createSession:()=>ses,fetcher,crypto:{available:async()=>true,encrypt:async v=>Buffer.from(v),decrypt:async v=>v.toString()},openExternal:async()=>{throw Error('Unexpected browser');}};return{ports,windows,options,clears:()=>clears};}

test('monitoring: DeepSeek silent bootstrap releases its website, retains session, and stops on disable',async()=>sandbox(async root=>{
 let requests=0;const d=desktop((async()=>{requests++;return dsBody();})as typeof fetch),w=new WebLogin(()=>{},root,undefined,d.ports);try{w.configure({deepseek:false,opencode:false});await w.open('deepseek',false);w.refresh('deepseek');assert.equal(d.windows.length,0);w.configure({deepseek:true,opencode:false});await w.open('deepseek',false);await turn();assert.equal(d.windows[0].destroyed,true);assert.equal(w.states.deepseek.status,'connected');assert.equal(d.options[0].webPreferences.nodeIntegration,false);assert.equal(d.options[0].webPreferences.sandbox,true);assert.equal(d.options[0].webPreferences.webSecurity,true);assert.equal(d.clears(),0);w.configure({deepseek:false,opencode:false});const before=requests;w.refresh('deepseek');await w.open('deepseek',true);await turn();assert.equal(requests,before);assert.equal(w.states.deepseek.status,'paused');assert.equal(d.clears(),0);}finally{await w.close();}
}));

test('monitoring: DeepSeek late responses cannot restore paused data or start another page request',async()=>sandbox(async root=>{
 let release!:(v:Response)=>void,signal!:AbortSignal,requests=0;const d=desktop((async(_u,init)=>{requests++;signal=init!.signal as AbortSignal;return new Promise(r=>release=r);})as typeof fetch),w=new WebLogin(()=>{},root,undefined,d.ports);try{await w.open('deepseek',false);await turn();w.configure({deepseek:false,opencode:false});assert.equal(signal.aborted,true);release(dsBody());await turn();assert.equal(requests,1);assert.equal(w.states.deepseek.status,'paused');assert.equal(w.states.deepseek.history,undefined);assert.ok(d.windows.every(win=>win.destroyed));}finally{await w.close();}
}));

test('monitoring: public health requests are cancelled and fenced on platform disable',async()=>{
 let calls=0,signal!:AbortSignal,release!:(v:Response)=>void;const h=new HealthMonitor(()=>{},(async(_u,init)=>{calls++;signal=init!.signal as AbortSignal;return new Promise(r=>release=r);})as typeof fetch);try{h.configure({deepseek:false,codex:false});h.start();await h.refresh('codex');assert.equal(calls,0);h.configure({deepseek:false,codex:true});await turn();h.configure({deepseek:false,codex:false});assert.equal(signal.aborted,true);release(new Response(JSON.stringify({components:[{id:'01KMP3KP5MGE23B80K1EK4S8PV',status:'operational'}]})));await turn();assert.equal(h.states.codex.status,'paused');assert.equal(h.states.codex.data,undefined);await h.refresh('codex');assert.equal(calls,1);}finally{h.stop();}
});

test('monitoring: ZCode only aggregates enabled platforms and zero enabled platforms never open a file',async()=>sandbox(async root=>{
 assert.equal(inspectZCode({enabled:true,path:join(root,'does-not-exist')},[]).status,'paused');const path=join(root,'usage.sqlite'),db=new DatabaseSync(path);db.exec('CREATE TABLE model_usage(id INTEGER,provider_id TEXT,model_id TEXT,started_at INTEGER,computed_total_tokens INTEGER)');const insert=db.prepare('INSERT INTO model_usage VALUES(?,?,?,?,?)');insert.run(1,'kimi-for-coding','kimi-k2.5',Date.now(),11);insert.run(2,'minimax-cn-coding-plan','minimax-m3',Date.now(),22);db.close();const only=inspectZCode({enabled:true,path},['kimi']);assert.equal(only.histories?.kimi?.days[0].tokens,'11');assert.equal(only.histories?.minimax,undefined);assert.equal(only.records,1);
}));
