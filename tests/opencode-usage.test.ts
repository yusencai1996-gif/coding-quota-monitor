import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SafeError} from '../src/model';
import type {McpToolResult} from '../src/opencode-mcp';
import {OPENCODE_USAGE_RANGES,parseOpenCodeUsage,type OpenCodeUsageRange,type OpenCodeUsageSummary} from '../src/opencode-usage';

const usage=(range:OpenCodeUsageRange='30d'):Record<string,unknown>=>({user_id:'SYNTHETIC-USER',range,requests:12,input_tokens:100,output_tokens:50,cache_read_tokens:30,cache_write_tokens:20,cost_usd:0.0123,models:[{model:'PRIVATE-MODEL',provider:'PRIVATE-PROVIDER',requests:12,cost_usd:0.0123}],budgets:[{id:'PRIVATE-BUDGET'}]});
const structured=(value:Record<string,unknown>):McpToolResult=>({structuredContent:value});
const text=(value:unknown):McpToolResult=>({content:[{type:'text',text:JSON.stringify(value)}]});
const rejects=(result:unknown,range:OpenCodeUsageRange='30d')=>assert.throws(()=>parseOpenCodeUsage(result as McpToolResult,range),error=>error instanceof SafeError&&error.code==='schema'&&error.message==='schema');

test('OpenCode usage keeps official period totals independent and strips account/model/budget data',()=>{
 const raw=usage(),parsed=parseOpenCodeUsage(structured(raw),'30d');
 assert.equal(parsed.userId,'SYNTHETIC-USER');
 assert.deepEqual(parsed.period,{range:'30d',requests:'12',inputTokens:'100',outputTokens:'50',cacheReadTokens:'30',cacheWriteTokens:'20',costUsd:0.0123});
 const summary:OpenCodeUsageSummary={periods:[parsed.period],updatedAt:123};
 assert.deepEqual(Object.keys(summary),['periods','updatedAt']);
 assert.ok(!/SYNTHETIC|PRIVATE|user|model|budget|days|quota/i.test(JSON.stringify(summary)));
 raw.input_tokens=999;assert.equal(parsed.period.inputTokens,'100');
});

test('OpenCode usage accepts all verified ranges and rejects mismatched or unknown periods',()=>{
 assert.deepEqual(OPENCODE_USAGE_RANGES,['24h','7d','30d','all']);
 for(const range of OPENCODE_USAGE_RANGES){assert.equal(parseOpenCodeUsage(structured(usage(range)),range).period.range,range);assert.equal(parseOpenCodeUsage(text(usage(range)),range).period.range,range);}
 rejects(structured(usage('7d')),'30d');rejects(structured({...usage(),range:'month'}));rejects(structured(usage()),'month' as OpenCodeUsageRange);
});

test('OpenCode usage prefers structured content and never masks malformed structured data with text',()=>{
 const preferred=parseOpenCodeUsage({...structured(usage()),content:[{type:'text',text:'PRIVATE-INVALID-JSON'},{type:'image'}]},'30d');
 assert.equal(preferred.period.inputTokens,'100');
 for(const value of [null,[],42,'PRIVATE-INVALID',{}])rejects({...text(usage()),structuredContent:value});
});

test('OpenCode usage text fallback requires exactly one text JSON object and redacts parse failures',()=>{
 const block={type:'text',text:JSON.stringify(usage())};
 for(const result of [{},{content:[]},{content:[block,block]},{content:[block,{type:'image'}]},{content:[{type:'image',text:block.text}]},{content:[{type:'text',text:42}]},{content:[{type:'text',text:'PRIVATE-INVALID-JSON'}]},{content:[{type:'text',text:'{}{}'}]},...['null','[]','42','"PRIVATE"'].map(value=>({content:[{type:'text',text:value}]}))])rejects(result);
 rejects({content:[{type:'text',text:'x'.repeat(2*1024*1024+1)}]});
});

test('OpenCode usage requires every consumed field without inventing zero totals',()=>{
 for(const field of ['user_id','range','requests','input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','cost_usd']){
  const raw=usage();delete raw[field];rejects(structured(raw));
 }
 const raw=usage();delete raw.models;delete raw.budgets;assert.equal(parseOpenCodeUsage(structured(raw),'30d').period.requests,'12');
});

test('OpenCode usage counts reject unsafe/fractional/coerced values and normalize exact decimal strings',()=>{
 const fields=['requests','input_tokens','output_tokens','cache_read_tokens','cache_write_tokens'];
 const invalid=[undefined,null,'0','12','',true,false,NaN,Infinity,-Infinity,-1,0.1,Number.MAX_SAFE_INTEGER+1,BigInt(1),{},[]];
 for(const field of fields)for(const value of invalid)rejects(structured({...usage(),[field]:value}));
 const parsed=parseOpenCodeUsage(structured({...usage(),requests:0,input_tokens:Number.MAX_SAFE_INTEGER,output_tokens:-0,cache_read_tokens:1,cache_write_tokens:2}),'30d');
 assert.deepEqual(parsed.period,{range:'30d',requests:'0',inputTokens:'9007199254740991',outputTokens:'0',cacheReadTokens:'1',cacheWriteTokens:'2',costUsd:0.0123});
});

test('OpenCode usage cost accepts finite nonnegative numbers only',()=>{
 for(const value of [undefined,null,'0','0.01','',true,false,NaN,Infinity,-Infinity,-0.01,{},[]])rejects(structured({...usage(),cost_usd:value}));
 for(const value of [0,-0,0.001,Number.MAX_VALUE])assert.equal(parseOpenCodeUsage(structured({...usage(),cost_usd:value}),'30d').period.costUsd,value===0?0:value);
});

test('OpenCode usage account identifiers reject empty, excessive or control-character values',()=>{
 for(const user_id of [undefined,null,42,'',' ',' USER','USER ','x'.repeat(257),'USER\nPRIVATE','USER\u0000PRIVATE','USER\u007fPRIVATE','USER\u0085PRIVATE','USER\u202ePRIVATE'])rejects(structured({...usage(),user_id}));
 assert.equal(parseOpenCodeUsage(structured({...usage(),user_id:'x'.repeat(256)}),'30d').userId.length,256);
});

test('OpenCode usage rejects tool errors and malformed envelopes even when totals are present',()=>{
 for(const isError of [true,'false','true',1,null])rejects({...structured(usage()),isError});
 for(const envelope of [undefined,null,42,'PRIVATE',[]])rejects(envelope);
 assert.equal(parseOpenCodeUsage({...structured(usage()),isError:false},'30d').period.requests,'12');
});
