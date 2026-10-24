import test from 'node:test';
import assert from 'node:assert/strict';
import {OpenCodeConnection,type OpenCodeConnectionState} from '../src/opencode-connection';
import {SafeError} from '../src/model';
import {OpenCodeAccessError} from '../src/opencode-mcp';
import type {McpToolResult} from '../src/opencode-mcp';
import type {TokenHistory} from '../src/activity-model';
const contract=()=>[{name:'get_usage',inputSchema:{type:'object'}},{name:'get_context',inputSchema:{type:'object'}}];
const usage=(range:unknown,user='SYNTHETIC-USER')=>({structuredContent:{user_id:user,range,requests:1,input_tokens:2,output_tokens:3,cache_read_tokens:4,cache_write_tokens:5,cost_usd:0}});

function fixture(saved=false,readDaily?:(orgId:string,userId:string,signal:AbortSignal)=>Promise<TokenHistory>){
 let begins=0,lists=0,closes=0,loggedOut=0;
 const states:OpenCodeConnectionState[]=[];
 const auth={has:async()=>saved,begin:async()=>{begins++;},logout:async()=>{loggedOut++;},close:async()=>{},snapshot:()=>({status:'idle' as const})};
 const client={listTools:async()=>{lists++;return contract();},callReadTool:async(name:string,args:Record<string,unknown>):Promise<McpToolResult>=>name==='get_context'?{structuredContent:{user:{id:'SYNTHETIC-USER',email:'PRIVATE'},workspace:{id:'wrk_SYNTHETIC',name:'PRIVATE',role:'owner'}}}:usage(args.range),close:()=>{closes++;}};
 const connection=new OpenCodeConnection(auth,()=>client,s=>states.push(s),readDaily);
 return {auth,client,connection,states,counts:()=>({begins,lists,closes,loggedOut})};
}
test('OpenCode startup without authorization never launches browser',async()=>{
 const f=fixture();await f.connection.open(false);assert.equal(f.counts().begins,0);assert.equal(f.counts().lists,0);assert.equal(f.states.at(-1)?.status,'login-required');
});
test('OpenCode interactive authorization reads verified periods without exposing account identifiers',async()=>{
 const f=fixture();await f.connection.open();assert.equal(f.counts().begins,1);assert.equal(f.counts().lists,1);assert.equal(f.states.at(-1)?.status,'connected');assert.ok(!JSON.stringify(f.states).includes('unknown'));assert.equal(f.connection.toolContracts().length,2);
});
test('OpenCode requires verified usage tool and publishes only one account across every period',async()=>{
 const missing=fixture(true);missing.client.listTools=async()=>[];await missing.connection.open(false);assert.equal(missing.states.at(-1)?.status,'schema');assert.equal(missing.states.at(-1)?.usage,undefined);
 const changed=fixture(true);changed.client.callReadTool=async(_name,args)=>usage(args.range,args.range==='all'?'OTHER-USER':'SYNTHETIC-USER');await changed.connection.open(false);assert.equal(changed.states.at(-1)?.status,'schema');assert.equal(changed.states.at(-1)?.usage,undefined);
 const f=fixture(true);await f.connection.open(false);assert.deepEqual(f.states.at(-1)?.usage?.periods.map(p=>p.range),['24h','7d','30d','all']);assert.ok(!JSON.stringify(f.states).includes('SYNTHETIC-USER'));await f.connection.close();
});
test('OpenCode retains timestamped readings on network failure and clears them on access refusal',async()=>{
 const f=fixture(true);await f.connection.open(false);const prior=f.states.at(-1)?.usage;
 f.client.callReadTool=async()=>{throw new SafeError('network');};await f.connection.open(false);assert.equal(f.states.at(-1)?.status,'network');assert.equal(f.states.at(-1)?.usage,prior);
 f.client.listTools=async()=>{throw new OpenCodeAccessError('forbidden');};await f.connection.open(false);assert.equal(f.states.at(-1)?.usage,undefined);await f.connection.close();
});
test('OpenCode saved authorization restores silently and concurrent clicks share work',async()=>{
 const f=fixture(true);await Promise.all([f.connection.open(false),f.connection.open()]);assert.equal(f.counts().begins,0);assert.equal(f.counts().lists,1);
});
test('OpenCode expired authorization prompts only on explicit login',async()=>{
 const f=fixture(true);let fail=true;f.client.listTools=async()=>{if(fail)throw new SafeError('auth');return contract();};
 await f.connection.open(false);assert.equal(f.counts().begins,0);assert.equal(f.states.at(-1)?.status,'login-required');
 f.auth.begin=async()=>{fail=false;};await f.connection.open();assert.equal(f.states.at(-1)?.status,'connected');
});
test('OpenCode logout fences a delayed response and clears contracts',async()=>{
 const f=fixture(true);let release!:(value:[])=>void;f.client.listTools=()=>new Promise(r=>{release=r;});const pending=f.connection.open();
 await new Promise(r=>setImmediate(r));await f.connection.logout();release([]);await pending;
 assert.equal(f.states.at(-1)?.status,'not-connected');assert.equal(f.connection.toolContracts().length,0);assert.equal(f.counts().loggedOut,1);
});
test('OpenCode close stops publishing late discovery results',async()=>{
 const f=fixture(true);let release!:(value:[])=>void;f.client.listTools=()=>new Promise(r=>{release=r;});const pending=f.connection.open();
 await new Promise(r=>setImmediate(r));await f.connection.close();const count=f.states.length;release([]);await pending;await f.connection.open();assert.equal(f.states.length,count);
});
test('OpenCode explicit login upgrades pending silent restore without saved credentials',async()=>{
 const f=fixture();let release!:(v:boolean)=>void;f.auth.has=()=>new Promise(r=>{release=r;});
 const restore=f.connection.open(false),click=f.connection.open(true);release(false);await Promise.all([restore,click]);
 assert.equal(f.counts().begins,1);assert.equal(f.states.at(-1)?.status,'connected');
});
test('OpenCode explicit login upgrades silent restore that receives auth failure',async()=>{
 const f=fixture(true);let reject!:(e:Error)=>void,attempt=0;
 f.client.listTools=async()=>{if(attempt++===0)return new Promise((_r,no)=>{reject=no;});return contract();};
 const restore=f.connection.open(false);await new Promise(r=>setImmediate(r));const click=f.connection.open(true);reject(new SafeError('auth'));
 await Promise.all([restore,click]);assert.equal(f.counts().begins,1);assert.equal(f.states.at(-1)?.status,'connected');
});
test('OpenCode failed credential deletion does not claim disconnected',async()=>{
 const f=fixture(true);f.auth.logout=async()=>{throw new SafeError('storage');};
 await assert.rejects(f.connection.logout(),SafeError);assert.equal(f.states.at(-1)?.status,'storage');assert.match(f.states.at(-1)!.coverage,/清除失败/);
});
test('OpenCode workspace refusal keeps authorization and never requests login again',async()=>{
 for(const reason of ['mcp-disabled','forbidden'] as const){const f=fixture(true);f.client.listTools=async()=>{throw new OpenCodeAccessError(reason);};await f.connection.open(true);assert.equal(f.counts().begins,0);assert.equal(f.states.at(-1)?.status,reason);assert.ok(!JSON.stringify(f.states).includes('PRIVATE'));}
});
const daily=(tokens='10000'):TokenHistory=>({schema:1,source:'opencode-export-v2',sourceTimezone:'UTC',days:[{date:'2026-10-24',tokens,partial:true}],updatedAt:Date.now()});
test('OpenCode binds daily export to verified OAuth user and workspace without exposing identifiers',async()=>{
 let called=false;const f=fixture(true,async(orgId,userId)=>{assert.equal(orgId,'wrk_SYNTHETIC');assert.equal(userId,'SYNTHETIC-USER');called=true;return daily();});await f.connection.open(false);
 assert.equal(called,true);assert.equal(f.states.at(-1)?.historyStatus,'ok');assert.equal(f.states.at(-1)?.history?.days[0].tokens,'10000');assert.ok(!JSON.stringify(f.states).includes('SYNTHETIC'));await f.connection.close();
});
test('OpenCode daily export permission failure preserves the OAuth summary without triggering login',async()=>{
 const f=fixture(true,async()=>{throw new SafeError('auth');});await f.connection.open(false);assert.equal(f.states.at(-1)?.status,'connected');assert.equal(f.states.at(-1)?.historyStatus,'auth');assert.equal(f.states.at(-1)?.history,undefined);assert.equal(f.states.at(-1)?.usage?.periods.length,4);assert.equal(f.counts().begins,0);await f.connection.close();
});
test('OpenCode mismatched context never calls daily API or publishes mixed account data',async()=>{
 let called=false;const f=fixture(true,async()=>{called=true;return daily();});f.client.callReadTool=async(name,args)=>name==='get_context'?{structuredContent:{user:{id:'OTHER'},workspace:{id:'wrk_OTHER'}}}:usage(args.range);
 await f.connection.open(false);assert.equal(called,false);assert.equal(f.states.at(-1)?.status,'schema');assert.equal(f.states.at(-1)?.usage,undefined);assert.equal(f.states.at(-1)?.history,undefined);await f.connection.close();
});
test('OpenCode key changes abort and fence stale daily responses, then refresh with the new source',async()=>{
 let release!:(h:TokenHistory)=>void,first=true,signal!:AbortSignal;const f=fixture(true,async(_org,_user,sig)=>{if(first){first=false;signal=sig;return new Promise(r=>{release=r;});}return daily('20000');});
 const pending=f.connection.open(false);await new Promise(r=>setImmediate(r));f.connection.invalidateDaily();assert.equal(signal.aborted,true);release(daily('1'));await pending;await new Promise(r=>setImmediate(r));
 assert.equal(f.states.at(-1)?.history?.days[0].tokens,'20000');assert.ok(!f.states.some(s=>s.history?.days[0].tokens==='1'));await f.connection.close();
});
test('OpenCode logout aborts a daily request and late result cannot restore the heatmap',async()=>{
 let release!:(h:TokenHistory)=>void,signal!:AbortSignal;const f=fixture(true,async(_org,_user,sig)=>{signal=sig;return new Promise(r=>{release=r;});});const pending=f.connection.open(false);await new Promise(r=>setImmediate(r));await f.connection.logout();assert.equal(signal.aborted,true);release(daily());await pending;assert.equal(f.states.at(-1)?.status,'not-connected');assert.equal(f.states.at(-1)?.history,undefined);await f.connection.close();
});
