import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SafeError} from '../src/model';
import {parseOpenCodeExport,requestOpenCodeExport} from '../src/opencode-export';

const USER='SYNTHETIC-USER',NOW=Date.parse('2026-10-24T20:30:00Z');
const HEADER=['day','user_type','user_id','user_name','provider','model','requests','input_tokens','output_tokens','cache_read_tokens','cache_write_5m_tokens','cache_write_1h_tokens','cost_micro_cents'];
const row=(extra:Record<string,string>={})=>({day:'2026-10-24',user_type:'user',user_id:USER,user_name:'PRIVATE-NAME',provider:'PRIVATE-PROVIDER',model:'PRIVATE-MODEL',requests:'2',input_tokens:'1',output_tokens:'2',cache_read_tokens:'3',cache_write_5m_tokens:'4',cache_write_1h_tokens:'5',cost_micro_cents:'900',...extra});
const escape=(value:string)=>/[",\r\n]/.test(value)?'"'+value.replaceAll('"','""')+'"':value;
const csv=(rows:Record<string,string>[],headers=HEADER,newline='\r\n')=>[headers,...rows.map(value=>headers.map(name=>value[name]??''))].map(record=>record.map(escape).join(',')).join(newline);
const rejects=(value:string,user=USER,now=NOW)=>assert.throws(()=>parseOpenCodeExport(value,user,now),e=>e instanceof SafeError&&e.message==='schema');
const fetchCsv=(body:string):typeof fetch=>(async()=>new Response(body,{headers:{'Content-Type':'text/csv'}})) as typeof fetch;

test('OpenCode export sums exactly five token columns, keeps UTC dates and strips account details',()=>{
 const history=parseOpenCodeExport(csv([row(),row({provider:'SECOND-PROVIDER',model:'SECOND-MODEL',input_tokens:'00010'})]),USER,NOW);
 assert.deepEqual(history,{schema:1,source:'opencode-export-v2',sourceTimezone:'UTC',updatedAt:NOW,days:[{date:'2026-10-24',tokens:'39',partial:true}]});
 assert.ok(!/PRIVATE|SYNTHETIC|SECOND|user_id|user_name|provider|model/.test(JSON.stringify(history)));
 const headers=[...HEADER,'reasoning_tokens'];assert.equal(parseOpenCodeExport(csv([row({reasoning_tokens:'999'})],headers),USER,NOW).days[0].tokens,'15');
});

test('OpenCode export RFC4180 parsing handles BOM, reordered headers, quotes, commas and multiline fields',()=>{
 const headers=[...HEADER].reverse(),value=row({user_name:'PRIVATE, "quoted"\r\nname\nnext',provider:'provider,"one"',model:'model\r\ntwo'});
 const history=parseOpenCodeExport('\ufeff'+csv([value],headers)+'\r\n',USER,NOW);
 assert.equal(history.days[0].tokens,'15');assert.equal(history.days[0].date,'2026-10-24');
 assert.deepEqual(parseOpenCodeExport(csv([row()],HEADER,'\n'),USER,NOW),parseOpenCodeExport(csv([row()]),USER,NOW));
});

test('OpenCode export includes only exact user matches and valid empty results do not fabricate zero days',()=>{
 const foreign=row({user_id:'OTHER-USER',day:'not-a-date',input_tokens:'PRIVATE-NONNUMERIC'});
 assert.deepEqual(parseOpenCodeExport(csv([foreign]),USER,NOW).days,[]);
 assert.deepEqual(parseOpenCodeExport(csv([]),USER,NOW).days,[]);
 assert.deepEqual(parseOpenCodeExport(csv([row({user_id:USER+'-suffix'})]),USER,NOW).days,[]);
 const zeros=row(Object.fromEntries(['input_tokens','output_tokens','cache_read_tokens','cache_write_5m_tokens','cache_write_1h_tokens'].map(key=>[key,'0'])));
 assert.equal(parseOpenCodeExport(csv([zeros]),USER,NOW).days[0].tokens,'0');
});

test('OpenCode export rejects duplicate grains while allowing distinct user types, providers and models',()=>{
 rejects(csv([row(),row()]));
 rejects(csv([row(),row({user_name:'DIFFERENT-NAME'})]));
 const history=parseOpenCodeExport(csv([row(),row({user_type:'service'}),row({provider:'other'}),row({model:'other'})]),USER,NOW);
 assert.equal(history.days[0].tokens,'60');
 // Separators inside fields cannot make different tuples collide.
 assert.equal(parseOpenCodeExport(csv([row({provider:'a,b',model:'c'}),row({provider:'a',model:'b,c'})]),USER,NOW).days[0].tokens,'30');
});

test('OpenCode export rejects missing/duplicate headers, malformed quotes, row widths and illegal controls',()=>{
 for(const name of HEADER)rejects(csv([row()],HEADER.filter(header=>header!==name)));
 rejects(csv([row()],[...HEADER,'day']));rejects('');rejects(csv([row()])+',extra');
 const prefix=HEADER.join(',')+'\r\n';
 for(const bad of ['"unclosed','a"quote,b','"closed"trailing,b','"closed" ,b','bare\rreturn','bad\u0000control','"bad\tcontrol"'])rejects(prefix+bad);
 // One trailing line ending is allowed; a blank data record is malformed.
 assert.equal(parseOpenCodeExport(csv([row()])+'\r\n',USER,NOW).days.length,1);
 rejects(csv([row()])+'\r\n\r\n');
});

test('OpenCode export validates dates and bounded unsigned decimal integers without number rounding',()=>{
 for(const field of ['requests','input_tokens','output_tokens','cache_read_tokens','cache_write_5m_tokens','cache_write_1h_tokens','cost_micro_cents'])for(const value of ['','-1','+1','1.5','1e3',' 1','1 ','NaN','Infinity','9'.repeat(31)])rejects(csv([row({[field]:value})]));
 for(const day of ['2026-02-30','2026-2-03','2026-10-24T00:00:00Z','not-a-date'])rejects(csv([row({day})]));
 const exact=row({input_tokens:'900719925474099312345',output_tokens:'0',cache_read_tokens:'0',cache_write_5m_tokens:'0',cache_write_1h_tokens:'0'});
 assert.equal(parseOpenCodeExport(csv([exact]),USER,NOW).days[0].tokens,'900719925474099312345');
 rejects(csv([row({input_tokens:'9'.repeat(30)})]));
});

test('OpenCode export retains at most the latest 366 UTC dates without moving them to Beijing',()=>{
 const today='2026-10-24',date=(offset:number)=>new Date(Date.parse(today+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
 const history=parseOpenCodeExport(csv(Array.from({length:369},(_,i)=>row({day:date(i-367)}))),USER,NOW);
 assert.equal(history.days.length,366);assert.equal(history.days[0].date,date(-365));assert.equal(history.days.at(-1)?.date,today);assert.equal(history.days.at(-1)?.partial,true);
 assert.ok(history.days.slice(0,-1).every(day=>day.partial===undefined));
 rejects(csv([row()]),USER,NaN);rejects(csv([row()]),USER,Infinity);
});

test('OpenCode export enforces UTF-8 byte and logical data record limits',()=>{
 rejects('x'.repeat(10*1024*1024+1));rejects('测'.repeat(Math.ceil(10*1024*1024/3)));
 const rows=Array.from({length:20000},(_,i)=>row({model:'model-'+i}));assert.equal(parseOpenCodeExport(csv(rows),USER,NOW).days[0].tokens,'300000');
 rows.push(row({model:'one-too-many'}));rejects(csv(rows));
});

test('OpenCode export request uses only the fixed official endpoint and returns parsed history',async()=>{
 let seen:{url:string;init:RequestInit}|undefined;
 const fetcher=(async(url:unknown,init:RequestInit)=>{seen={url:String(url),init};return new Response(csv([]),{headers:{'Content-Type':'text/csv; charset=utf-8'}});}) as typeof fetch;
 const signal=new AbortController().signal,history=await requestOpenCodeExport('SYNTHETIC-KEY','wrk_SYNTHETIC','USER+with/symbols',signal,fetcher);
 assert.deepEqual(history.days,[]);assert.equal(history.source,'opencode-export-v2');assert.equal(history.sourceTimezone,'UTC');
 const url=new URL(seen!.url);assert.equal(url.origin+url.pathname,'https://opencode.ai/console/api/v2/usage/export');assert.deepEqual([...url.searchParams],[['range','90d'],['user_id','USER+with/symbols']]);
 assert.equal(seen!.init.method,'GET');assert.deepEqual(seen!.init.headers,{Authorization:'Bearer SYNTHETIC-KEY','x-org-id':'wrk_SYNTHETIC',Accept:'text/csv'});assert.equal(seen!.init.credentials,'omit');assert.equal(seen!.init.redirect,'error');assert.equal(seen!.init.signal,signal);
 assert.ok(!JSON.stringify(history).includes('SYNTHETIC'));
});

test('OpenCode export request rejects malformed context before making a network request',async()=>{
 let calls=0;const fetcher=(async()=>{calls++;return new Response(csv([]));}) as typeof fetch;
 for(const org of ['','wrk_','org_','ORG_test','https://evil.invalid','wrk_bad space','wrk_bad\nvalue','org_'+'x'.repeat(253)])await assert.rejects(requestOpenCodeExport('SYNTHETIC-KEY',org,USER,new AbortController().signal,fetcher),SafeError);
 for(const user of ['','has space','has\ncontrol','x'.repeat(257)])await assert.rejects(requestOpenCodeExport('SYNTHETIC-KEY','org_SYNTHETIC',user,new AbortController().signal,fetcher),SafeError);
 for(const key of ['','has space','has\r\ncontrol','x'.repeat(16385)])await assert.rejects(requestOpenCodeExport(key,'wrk_SYNTHETIC',USER,new AbortController().signal,fetcher),SafeError);
 assert.equal(calls,0);
});

test('OpenCode export request maps HTTP failures safely and bounds declared/streamed bodies',async()=>{
 for(const [status,code]of [[401,'auth'],[403,'auth'],[503,'network']] as const){let cancelled=false;const fetcher=(async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{status})) as typeof fetch;
  await assert.rejects(requestOpenCodeExport('SYNTHETIC-KEY','org_SYNTHETIC',USER,new AbortController().signal,fetcher),e=>e instanceof SafeError&&e.code===code&&e.message===code);assert.equal(cancelled,true);
 }
 for(const declared of [String(10*1024*1024+1),'not-a-number'])await assert.rejects(requestOpenCodeExport('SYNTHETIC-KEY','org_SYNTHETIC',USER,new AbortController().signal,(async()=>new Response('PRIVATE-BODY',{headers:{'content-length':declared}})) as typeof fetch),e=>e instanceof SafeError&&e.message==='schema');
 let cancelled=false;const large=(async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(10*1024*1024+1));},cancel(){cancelled=true;}}))) as typeof fetch;
 await assert.rejects(requestOpenCodeExport('SYNTHETIC-KEY','org_SYNTHETIC',USER,new AbortController().signal,large),SafeError);assert.equal(cancelled,true);
 await assert.rejects(requestOpenCodeExport('SYNTHETIC-KEY','org_SYNTHETIC',USER,new AbortController().signal,fetchCsv('PRIVATE-MALFORMED-CSV')),e=>e instanceof SafeError&&e.message==='schema');
});

test('OpenCode export abort releases ignored fetches and pending body readers without exposing credentials',async()=>{
 const early=new AbortController();early.abort();let called=false;
 await assert.rejects(requestOpenCodeExport('SYNTHETIC-KEY','wrk_SYNTHETIC',USER,early.signal,(async()=>{called=true;return new Response(csv([]));}) as typeof fetch),e=>e instanceof SafeError&&e.code==='timeout');assert.equal(called,false);
 const ignored=new AbortController();const pending=requestOpenCodeExport('SYNTHETIC-KEY','wrk_SYNTHETIC',USER,ignored.signal,(async()=>new Promise(()=>{})) as typeof fetch);ignored.abort();await assert.rejects(pending,e=>e instanceof SafeError&&e.code==='timeout');
 let cancelled=false;const controller=new AbortController();const reading=requestOpenCodeExport('SYNTHETIC-KEY','wrk_SYNTHETIC',USER,controller.signal,(async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}))) as typeof fetch);
 await new Promise(resolve=>setImmediate(resolve));controller.abort();await assert.rejects(reading,e=>e instanceof SafeError&&e.message==='timeout');assert.equal(cancelled,true);
});
