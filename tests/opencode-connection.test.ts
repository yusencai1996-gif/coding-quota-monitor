import test from 'node:test';
import assert from 'node:assert/strict';
import {OpenCodeConnection,type OpenCodeConnectionState} from '../src/opencode-connection';
import {SafeError} from '../src/model';

function fixture(saved=false){
 let begins=0,lists=0,closes=0,loggedOut=0;
 const states:OpenCodeConnectionState[]=[];
 const auth={has:async()=>saved,begin:async()=>{begins++;},logout:async()=>{loggedOut++;},close:async()=>{},snapshot:()=>({status:'idle' as const})};
 const client={listTools:async()=>{lists++;return [{name:'unknown',inputSchema:{type:'object'}}];},close:()=>{closes++;}};
 const connection=new OpenCodeConnection(auth,()=>client,s=>states.push(s));
 return {auth,client,connection,states,counts:()=>({begins,lists,closes,loggedOut})};
}
test('OpenCode startup without authorization never launches browser',async()=>{
 const f=fixture();await f.connection.open(false);assert.equal(f.counts().begins,0);assert.equal(f.counts().lists,0);assert.equal(f.states.at(-1)?.status,'login-required');
});
test('OpenCode interactive authorization discovers contracts without claiming usage',async()=>{
 const f=fixture();await f.connection.open();assert.equal(f.counts().begins,1);assert.equal(f.counts().lists,1);assert.equal(f.states.at(-1)?.status,'authorized-unverified');assert.ok(!JSON.stringify(f.states).includes('unknown'));assert.equal(f.connection.toolContracts().length,1);
});
test('OpenCode saved authorization restores silently and concurrent clicks share work',async()=>{
 const f=fixture(true);await Promise.all([f.connection.open(false),f.connection.open()]);assert.equal(f.counts().begins,0);assert.equal(f.counts().lists,1);
});
test('OpenCode expired authorization prompts only on explicit login',async()=>{
 const f=fixture(true);let fail=true;f.client.listTools=async()=>{if(fail)throw new SafeError('auth');return [];};
 await f.connection.open(false);assert.equal(f.counts().begins,0);assert.equal(f.states.at(-1)?.status,'login-required');
 f.auth.begin=async()=>{fail=false;};await f.connection.open();assert.equal(f.states.at(-1)?.status,'authorized-unverified');
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
 assert.equal(f.counts().begins,1);assert.equal(f.states.at(-1)?.status,'authorized-unverified');
});
test('OpenCode explicit login upgrades silent restore that receives auth failure',async()=>{
 const f=fixture(true);let reject!:(e:Error)=>void,attempt=0;
 f.client.listTools=async()=>{if(attempt++===0)return new Promise((_r,no)=>{reject=no;});return [];};
 const restore=f.connection.open(false);await new Promise(r=>setImmediate(r));const click=f.connection.open(true);reject(new SafeError('auth'));
 await Promise.all([restore,click]);assert.equal(f.counts().begins,1);assert.equal(f.states.at(-1)?.status,'authorized-unverified');
});
test('OpenCode failed credential deletion does not claim disconnected',async()=>{
 const f=fixture(true);f.auth.logout=async()=>{throw new SafeError('storage');};
 await assert.rejects(f.connection.logout(),SafeError);assert.equal(f.states.at(-1)?.status,'storage');assert.match(f.states.at(-1)!.coverage,/清除失败/);
});
