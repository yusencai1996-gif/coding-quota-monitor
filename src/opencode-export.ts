import {SafeError} from './model';
import {dateOnly,shiftDate} from './activity-parsers';
import type {TokenHistory} from './activity-model';

const MAX_BYTES=10*1024*1024,MAX_ROWS=20000,MAX_COLUMNS=256;
const HEADERS=['day','user_type','user_id','user_name','provider','model','requests','input_tokens','output_tokens','cache_read_tokens','cache_write_5m_tokens','cache_write_1h_tokens','cost_micro_cents'] as const;
const TOKEN_FIELDS=['input_tokens','output_tokens','cache_read_tokens','cache_write_5m_tokens','cache_write_1h_tokens'] as const;
const schema=()=>new SafeError('schema');
const validUser=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\s\p{Cc}\p{Cf}]/u.test(value);
function integer(value:string):bigint{if(!/^\d{1,30}$/.test(value))throw schema();return BigInt(value);}

/** RFC4180 quoting, with LF record endings accepted alongside CRLF for exported CSV interoperability. */
function* records(csv:string):Generator<string[]> {
 let row:string[]=[],field='',quoted=false,closed=false,started=false;
 const push=()=>{row.push(field);if(row.length>MAX_COLUMNS)throw schema();field='';closed=false;};
 for(let i=0;i<csv.length;i++){
  const c=csv[i];
  if(quoted){
   if(c==='"'){if(csv[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}
   else{if(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/.test(c))throw schema();field+=c;}
   continue;
  }
  if(closed&&c!==','&&c!=='\r'&&c!=='\n')throw schema();
  if(c===','){push();started=true;}
  else if(c==='\r'||c==='\n'){
   if(c==='\r'){if(csv[i+1]!=='\n')throw schema();i++;}
   push();yield row;row=[];started=false;
  }else if(c==='"'){if(field||closed)throw schema();quoted=true;started=true;}
  else{if(/[\u0000-\u001f\u007f]/.test(c))throw schema();field+=c;started=true;}
 }
 if(quoted)throw schema();
 if(started||row.length||closed){push();yield row;}
}

/** UTC export dates are kept verbatim; no org/account/model identifiers leave this parser. */
export function parseOpenCodeExport(csv:string,expectedUserId:string,now=Date.now()):TokenHistory {
 try{
  if(typeof csv!=='string'||Buffer.byteLength(csv)>MAX_BYTES||!validUser(expectedUserId)||!Number.isFinite(now))throw schema();
  const today=new Date(now).toISOString().slice(0,10);if(!dateOnly(today))throw schema();
  const cutoff=shiftDate(today,-365),days=new Map<string,bigint>(),grains=new Set<string>();
  let headers:string[]|undefined,index:Record<string,number>={},rows=0;
  for(const row of records(csv.startsWith('\ufeff')?csv.slice(1):csv)){
   if(!headers){
    if(row.some(name=>!name)||new Set(row).size!==row.length||HEADERS.some(name=>!row.includes(name)))throw schema();
    headers=row;index=Object.fromEntries(row.map((name,i)=>[name,i]));continue;
   }
   if(++rows>MAX_ROWS||row.length!==headers.length)throw schema();
   if(row[index.user_id]!==expectedUserId)continue;
   const date=dateOnly(row[index.day]);if(!date)throw schema();
   const grain=JSON.stringify([date,row[index.user_type],row[index.provider],row[index.model]]);
   if(grains.has(grain))throw schema();grains.add(grain);
   // Request and cost columns are validated but are never counted as tokens.
   integer(row[index.requests]);integer(row[index.cost_micro_cents]);
   const total=TOKEN_FIELDS.reduce((sum,name)=>sum+integer(row[index[name]]),0n);
   if(date<cutoff||date>today)continue;
   const sum=(days.get(date)??0n)+total;if(sum.toString().length>30)throw schema();days.set(date,sum);
  }
  if(!headers)throw schema();
  return {schema:1,source:'opencode-export-v2',sourceTimezone:'UTC',updatedAt:now,days:[...days].sort(([a],[b])=>a.localeCompare(b)).map(([date,sum])=>({date,tokens:sum.toString(),...(date===today?{partial:true}:{})}))};
 }catch{throw schema();}
}

/** Internal-only API request: the raw CSV, key and account identifiers never enter renderer state. */
export async function requestOpenCodeExport(key:string,orgId:string,userId:string,signal:AbortSignal,fetcher:typeof fetch=fetch):Promise<TokenHistory> {
 if(typeof key!=='string'||!key||key.length>16384||/[\s\p{Cc}\p{Cf}]/u.test(key)||typeof orgId!=='string'||orgId.length>256||!/^(wrk_|org_)[A-Za-z0-9_-]+$/.test(orgId)||!validUser(userId))throw schema();
 if(signal.aborted)throw new SafeError('timeout');
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,response:Response|undefined;
 const cancel=()=>{if(reader)void reader.cancel().catch(()=>{});else if(response?.body)void response.body.cancel().catch(()=>{});};
 let rejectAbort!:(error:SafeError)=>void;
 const stopped=new Promise<never>((_,reject)=>{rejectAbort=reject;});
 const onAbort=()=>{cancel();rejectAbort(new SafeError('timeout'));};signal.addEventListener('abort',onAbort,{once:true});
 const work=async()=>{
  const url='https://opencode.ai/console/api/v2/usage/export?'+new URLSearchParams({range:'90d',user_id:userId});
  response=await fetcher(url,{method:'GET',headers:{Authorization:`Bearer ${key}`,'x-org-id':orgId,Accept:'text/csv'},credentials:'omit',redirect:'error',signal});
  if(signal.aborted){cancel();throw new SafeError('timeout');}
  if(!response.ok){cancel();throw new SafeError(response.status===401||response.status===403?'auth':response.status===429?'rateLimit':'network');}
  const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>MAX_BYTES)){cancel();throw schema();}
  reader=response.body?.getReader();if(!reader)throw schema();
  let bytes=0;const chunks:Uint8Array[]=[];
  try{
   for(;;){const chunk=await reader.read();if(signal.aborted)throw new SafeError('timeout');if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>MAX_BYTES)throw schema();chunks.push(chunk.value);}
   let csv:string;try{csv=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));}catch{throw schema();}
   return parseOpenCodeExport(csv,userId);
  }finally{cancel();reader.releaseLock();}
 };
 try{return await Promise.race([work(),stopped]);}
 catch(error){throw signal.aborted?new SafeError('timeout'):error instanceof SafeError?error:new SafeError('network');}
 finally{signal.removeEventListener('abort',onAbort);}
}
