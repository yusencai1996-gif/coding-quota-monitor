import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SafeError} from '../src/model';
import {OpenCodeMcp,OpenCodeAccessError,OPENCODE_MCP_ENDPOINT,OPENCODE_MCP_VERSION} from '../src/opencode-mcp';

type Call={url:string;init:RequestInit;rpc:any;headers:Headers};
const calls:Call[]=[];
const json=(rpc:any,result:unknown,headers:Record<string,string>={})=>new Response(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}),{headers:{'Content-Type':'application/json',...headers}});
const initialized=(rpc:any,session='synthetic-session')=>json(rpc,{protocolVersion:OPENCODE_MCP_VERSION,capabilities:{tools:{}},serverInfo:{name:'test',version:'0'}},{'Mcp-Session-Id':session});
const tool=(name='read_usage')=>({name,inputSchema:{type:'object'}});
function fake(handler:(call:Call)=>Response|Promise<Response>):typeof fetch{
  return (async(url:any,init?:RequestInit)=>{
    const call={url:String(url),init:init!,rpc:JSON.parse(String(init?.body)),headers:new Headers(init?.headers)};calls.push(call);
    if(call.rpc.method==='initialize')return initialized(call.rpc);
    if(call.rpc.method==='notifications/initialized')return new Response(null,{status:202});
    return handler(call);
  }) as typeof fetch;
}
const code=(expected:string)=>(error:unknown)=>error instanceof SafeError&&error.code===expected&&error.message===expected;

test('OpenCode MCP distinguishes disabled workspace and forbidden access without returning server text',async()=>{
 for(const [body,reason]of [[{error:'forbidden',message:'The Console MCP is not enabled for this workspace.'},'mcp-disabled'],[{error:'forbidden',message:'PRIVATE SERVER DETAIL'},'forbidden']] as const){
  const mcp=new OpenCodeMcp((async()=>new Response(JSON.stringify(body),{status:403})) as typeof fetch,async()=>'SYNTHETIC');
  await assert.rejects(mcp.listTools(),e=>e instanceof OpenCodeAccessError&&e.reason===reason&&e.message==='auth');mcp.close();
 }
 const huge=new OpenCodeMcp((async()=>new Response('x'.repeat(5000),{status:403})) as typeof fetch,async()=>'SYNTHETIC');await assert.rejects(huge.listTools(),e=>e instanceof OpenCodeAccessError&&e.reason==='forbidden');huge.close();
});
test('OpenCode MCP cancels a hanging forbidden response on deadline and close',async()=>{
 for(const close of [false,true]){
  let cancelled=false,started!:(v?:unknown)=>void;const ready=new Promise(r=>{started=r;});
  const mcp=new OpenCodeMcp((async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));started();},cancel(){cancelled=true;}}),{status:403})) as typeof fetch,async()=>'SYNTHETIC',{timeoutMs:close?1000:20});
  const pending=mcp.listTools();await ready;if(close)mcp.close();await assert.rejects(pending,code('timeout'));assert.equal(cancelled,true);mcp.close();
 }
});

test('OpenCode MCP initializes once, keeps the session in memory and uses fixed safe requests',async()=>{
  const seen:Call[]=[];const mcp=new OpenCodeMcp(fake(c=>{seen.push(c);return json(c.rpc,{tools:[tool()]});}),async()=>'SYNTHETIC');
  const start=calls.length;assert.equal((await mcp.listTools())[0].name,'read_usage');await mcp.listTools();
  const requestCalls=calls.slice(start);assert.deepEqual(requestCalls.map(c=>c.rpc.method),['initialize','notifications/initialized','tools/list','tools/list']);
  for(const c of requestCalls){assert.equal(c.url,OPENCODE_MCP_ENDPOINT);assert.equal(c.init.redirect,'error');assert.equal(c.init.credentials,'omit');assert.equal(c.headers.get('Authorization'),'Bearer SYNTHETIC');}
  assert.equal(requestCalls[1].rpc.id,undefined);assert.equal(seen[0].headers.get('Mcp-Session-Id'),'synthetic-session');assert.equal(seen[0].headers.get('MCP-Protocol-Version'),OPENCODE_MCP_VERSION);mcp.close();
});
test('OpenCode MCP reads split SSE events, skips notifications and other ids, and cancels a live stream',async()=>{
  let cancelled=false;
  const mcp=new OpenCodeMcp(fake(c=>{const text=': ping\r\ndata: '+JSON.stringify({jsonrpc:'2.0',method:'notifications/message',params:{message:'SECRET'}})+'\r\n\r\ndata: '+JSON.stringify({jsonrpc:'2.0',id:999,result:{tools:[]}})+'\n\ndata: '+JSON.stringify({jsonrpc:'2.0',id:c.rpc.id,result:{tools:[tool('读取')]}})+'\n\n';const bytes=new TextEncoder().encode(text);let offset=0;return new Response(new ReadableStream({pull(controller){if(offset<bytes.length){controller.enqueue(bytes.subarray(offset,offset+1));offset++;}},cancel(){cancelled=true;}}),{headers:{'Content-Type':'text/event-stream; charset=utf-8'}});}),async()=>'SYNTHETIC');
  assert.equal((await mcp.listTools())[0].name,'读取');assert.equal(cancelled,true);mcp.close();
});
test('OpenCode MCP follows bounded tools pages and rejects repeated cursors or duplicate tools',async()=>{
  const cursors:unknown[]=[];const mcp=new OpenCodeMcp(fake(c=>{cursors.push(c.rpc.params.cursor);return json(c.rpc,c.rpc.params.cursor?{tools:[tool('read_b')]}:{tools:[tool('read_a')],nextCursor:'next'});}),async()=>'SYNTHETIC');
  assert.deepEqual((await mcp.listTools()).map(t=>t.name),['read_a','read_b']);assert.deepEqual(cursors,[undefined,'next']);mcp.close();
  for(const result of [{tools:[],nextCursor:'same'},{tools:[tool()],nextCursor:'next'}]){const bad=new OpenCodeMcp(fake(c=>json(c.rpc,result)),async()=>'SYNTHETIC');await assert.rejects(bad.listTools(),code('schema'));bad.close();}
  const limited=new OpenCodeMcp(fake(c=>json(c.rpc,{tools:[],nextCursor:'next'})),async()=>'SYNTHETIC',{maxPages:1});await assert.rejects(limited.listTools(),code('schema'));limited.close();
});
test('OpenCode MCP defaults to denying tools and does not trust read annotations',async()=>{
  let requested=false;const mcp=new OpenCodeMcp(fake(c=>{requested=true;return json(c.rpc,{tools:[{...tool(),annotations:{readOnlyHint:true}}]});}),async()=>'SYNTHETIC');
  await assert.rejects(mcp.callReadTool('read_usage'),code('schema'));assert.equal(requested,false);await mcp.listTools();await assert.rejects(mcp.callReadTool('read_usage'),code('schema'));mcp.close();
});
test('OpenCode MCP calls only opted-in tools and redacts tool and JSON-RPC errors',async()=>{
  const options={allowedReadTools:['read_usage']};
  const ok=new OpenCodeMcp(fake(c=>{assert.equal(c.rpc.method,'tools/call');assert.deepEqual(c.rpc.params,{name:'read_usage',arguments:{days:7}});return json(c.rpc,{content:[{type:'text',text:'{"used":1}'}],structuredContent:{used:1}});}),async()=>'SYNTHETIC',options);
  assert.deepEqual((await ok.callReadTool('read_usage',{days:7})).structuredContent,{used:1});ok.close();
  for(const mode of ['tool','rpc']){const bad=new OpenCodeMcp(fake(c=>mode==='tool'?json(c.rpc,{isError:true,content:[{type:'text',text:'SECRET'}]}):new Response(JSON.stringify({jsonrpc:'2.0',id:c.rpc.id,error:{code:-1,message:'SECRET'}}),{headers:{'Content-Type':'application/json'}})),async()=>'SYNTHETIC',options);await assert.rejects(bad.callReadTool('read_usage'),code('schema'));bad.close();}
});
test('OpenCode MCP maps auth/rate/network failures without propagating response bodies',async()=>{
  for(const [status,expected] of [[401,'auth'],[403,'auth'],[429,'rateLimit'],[500,'network']] as const){const mcp=new OpenCodeMcp(fake(()=>new Response('SECRET',{status})),async()=>'SYNTHETIC');await assert.rejects(mcp.listTools(),code(expected));mcp.close();}
  const failed=new OpenCodeMcp((async()=>{throw Error('SECRET');}) as typeof fetch,async()=>'SYNTHETIC');await assert.rejects(failed.initialize(),code('network'));failed.close();
});
test('OpenCode MCP reinitializes and retries a read once when the server loses a session',async()=>{
  let reads=0;const start=calls.length;const mcp=new OpenCodeMcp(fake(c=>++reads===1?new Response(null,{status:404}):json(c.rpc,{tools:[tool()]})),async()=>'SYNTHETIC');
  assert.equal((await mcp.listTools()).length,1);assert.equal(calls.slice(start).filter(c=>c.rpc.method==='initialize').length,2);mcp.close();
  const gone=new OpenCodeMcp(fake(()=>new Response(null,{status:404})),async()=>'SYNTHETIC');await assert.rejects(gone.listTools(),code('network'));gone.close();
});
test('OpenCode MCP bounds JSON and SSE response sizes and rejects mismatched response ids',async()=>{
  for(const media of ['application/json','text/event-stream']){const mcp=new OpenCodeMcp(fake(()=>new Response(' '.repeat(2*1024*1024+1),{headers:{'Content-Type':media}})),async()=>'SYNTHETIC');await assert.rejects(mcp.listTools(),code('schema'));mcp.close();}
  const mismatch=new OpenCodeMcp(fake(()=>new Response(JSON.stringify({jsonrpc:'2.0',id:999,result:{tools:[]}}),{headers:{'Content-Type':'application/json'}})),async()=>'SYNTHETIC');await assert.rejects(mismatch.listTools(),code('schema'));mismatch.close();
});
test('OpenCode MCP hard deadlines and close cancel even uncooperative fetch or token functions',async()=>{
  const stalled=new OpenCodeMcp((()=>new Promise(()=>{})) as typeof fetch,async()=>'SYNTHETIC',{timeoutMs:20});await assert.rejects(stalled.initialize(),code('timeout'));stalled.close();
  const tokenStalled=new OpenCodeMcp(fake(()=>{throw Error('unexpected');}),()=>new Promise(()=>{}),{timeoutMs:20});await assert.rejects(tokenStalled.initialize(),code('timeout'));tokenStalled.close();
  let signal:AbortSignal|undefined;const closing=new OpenCodeMcp((async(_url,init)=>{signal=init?.signal as AbortSignal;return new Promise(()=>{});}) as typeof fetch,async()=>'SYNTHETIC');
  const pending=closing.initialize();await new Promise(resolve=>setImmediate(resolve));closing.close();await assert.rejects(pending,code('timeout'));assert.equal(signal?.aborted,true);await assert.rejects(closing.listTools(),code('timeout'));
});
test('OpenCode MCP aborts a hanging SSE body on deadline',async()=>{
  let cancelled=false;const mcp=new OpenCodeMcp(fake(()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(': ping\n'));},cancel(){cancelled=true;}}),{headers:{'Content-Type':'text/event-stream'}})),async()=>'SYNTHETIC',{timeoutMs:20});
  await assert.rejects(mcp.listTools(),code('timeout'));assert.equal(cancelled,true);mcp.close();
});
test('OpenCode MCP accepts CR-only and multiline SSE data but requires a completed event',async()=>{
  for(const ending of ['\r','\r\n','\n']){const mcp=new OpenCodeMcp(fake(c=>new Response('data: {"jsonrpc":"2.0",'+ending+'data: "id":'+c.rpc.id+',"result":{"tools":[]}}'+ending+ending,{headers:{'Content-Type':'text/event-stream'}})),async()=>'SYNTHETIC');assert.deepEqual(await mcp.listTools(),[]);mcp.close();}
  const incomplete=new OpenCodeMcp(fake(c=>new Response('data: '+JSON.stringify({jsonrpc:'2.0',id:c.rpc.id,result:{tools:[]}})+'\n',{headers:{'Content-Type':'text/event-stream'}})),async()=>'SYNTHETIC');await assert.rejects(incomplete.listTools(),code('schema'));incomplete.close();
});
