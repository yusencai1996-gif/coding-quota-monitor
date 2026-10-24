import{glmExpiryMs}from'./presentation';
import {SafeError}from'./model';
import {instant,number}from'./parse-values';
import type{TokenHistory,ResetCards,ResetCard,DayBucket,AggregateCell}from'./activity-model';
const obj=(v:unknown):Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v:{};
export function dateOnly(v:unknown):string|null {if(typeof v!=='string')return null;const d=/^\d{4}-\d{2}-\d{2}$/.test(v)?v:null;if(!d)return null;const t=Date.parse(d+'T00:00:00Z');return Number.isFinite(t)&&new Date(t).toISOString().slice(0,10)===d?d:null;}
export function tokens(v:unknown):string|null {if(typeof v==='number')return Number.isSafeInteger(v)&&v>=0?String(v):null;if(typeof v==='string'&&/^\d{1,30}$/.test(v))return BigInt(v).toString();return null;}
export function calendarToday(now=Date.now()):string {return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);}
export function shiftDate(date:string,days:number){return new Date(Date.parse(date+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);}
function rows(input:unknown,dateField:string,tokenField:string):DayBucket[]{if(!Array.isArray(input))throw new SafeError('schema');const result=new Map<string,string>();for(const v of input){const r=obj(v),date=dateOnly(r[dateField]),n=tokens(r[tokenField]);if(date&&n!==null)result.set(date,n);}if(input.length&&!result.size)throw new SafeError('schema');return [...result].map(([date,tokens])=>({date,tokens}));}
export function parseHistory(id:'codex'|'glm',input:unknown,now=Date.now()):TokenHistory {
 const r=obj(input);if(id==='glm'&&![0,200,'0','200'].includes(r.code))throw new SafeError('schema');
 const days=id==='codex'?rows(obj(r.stats).daily_usage_buckets,'start_date','tokens'):rows(obj(r.data).series,'date','totalTokens');
 return mergeHistory(undefined,{schema:1,source:id==='codex'?'codex-profile-v1':'glm-activity-v1',sourceTimezone:'platform-date',days,updatedAt:now},now);
}
// Source dates are calendar labels, not timezone-converted instants. Missing rows never become zero.
export function mergeHistory(previous:TokenHistory|undefined,next:TokenHistory,now=Date.now()):TokenHistory {
 const today=next.sourceTimezone==='UTC'?new Date(now).toISOString().slice(0,10):calendarToday(now),cutoff=shiftDate(today,-365),map=new Map<string,DayBucket>();
 for(const row of [...(previous?.source===next.source?previous.days:[]),...next.days])if(dateOnly(row.date)&&row.date>=cutoff&&row.date<=today&&tokens(row.tokens)!==null)map.set(row.date,{date:row.date,tokens:row.tokens,...(row.partial?{partial:true}:{})});
 return {...next,days:[...map].sort(([a],[b])=>a.localeCompare(b)).slice(-366).map(([,row])=>row)};
}
export function validStoredHistory(input:unknown):TokenHistory|undefined {const r=obj(input);if(r.schema!==1||!['codex-profile-v1','glm-activity-v1'].includes(r.source)||r.sourceTimezone!=='platform-date'||!Array.isArray(r.days)||r.days.length>366||typeof r.updatedAt!=='number'||!Number.isFinite(r.updatedAt))return;const days:DayBucket[]=[];for(const row of r.days){const v=obj(row),date=dateOnly(v.date),n=tokens(v.tokens);if(!date||n===null)return;days.push({date,tokens:n});}return {schema:1,source:r.source,sourceTimezone:'platform-date',days,updatedAt:r.updatedAt};}
const count=(v:unknown)=>{const n=number(v);return n!==null&&Number.isSafeInteger(n)?n:null;};
function kind(v:unknown):ResetCard['kind'] {return v==='codex_rate_limits'?'codex':v==='five_hour'||v==='five-hour'||v==='fiveHour'?'five-hour':v==='weekly'||v==='week'?'weekly':'other';}
export function parseCards(id:'codex'|'glm',input:unknown,now=Date.now()):ResetCards {
 const r=obj(input);if(id==='codex'){
  const availableCount=count(r.available_count);if(availableCount===null)throw new SafeError('schema');
  if(r.credits===null||r.credits===undefined)return {availableCount,cards:[],detailsComplete:availableCount===0,updatedAt:now};
  if(!Array.isArray(r.credits))throw new SafeError('schema');
  const cards=r.credits.slice(0,500).map((v:unknown)=>{const c=obj(v);return {kind:kind(c.reset_type),available:c.status==='available'?true:c.status==='consumed'||c.status==='expired'?false:null,expiresAt:instant(c.expires_at,'iso')};});
  return {availableCount,cards,detailsComplete:cards.filter(c=>c.available===true).length===availableCount&&r.credits.length<=500,updatedAt:now};
 }
 if(![0,200,'0','200'].includes(r.code))throw new SafeError('schema');const d=obj(r.data);if(!Array.isArray(d.fiveHourResets)||!Array.isArray(d.weekResets))throw new SafeError('schema');
 const cards:ResetCard[]=[];for(const [list,type]of [[d.fiveHourResets,'five-hour'],[d.weekResets,'weekly']]as const)for(const v of list.slice(0,500)){const c=obj(v),explicit=glmExpiryMs(c.expireTime);const local=typeof c.expireTime==='string'&&/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(c.expireTime)&&dateOnly(c.expireTime.slice(0,10))?c.expireTime:undefined;cards.push({kind:type,available:typeof c.available==='boolean'?c.available:null,expiresAt:explicit,...(explicit===null&&local?{expiresLocal:local}:{})});}
 const complete=d.fiveHourResets.length<=500&&d.weekResets.length<=500,known=cards.every(c=>c.available!==null)&&complete;return {availableCount:known?cards.filter(c=>c.available).length:null,cards,detailsComplete:known,updatedAt:now};
}
export function aggregate(history:TokenHistory,mode:'day'|'week'|'month',now=Date.now()):AggregateCell[]{
 const today=history.sourceTimezone==='UTC'?new Date(now).toISOString().slice(0,10):calendarToday(now),first=shiftDate(today,-365),daily=new Map(history.days.map(d=>[d.date,d.tokens])),groups=new Map<string,AggregateCell>();
 for(let date=first;date<=today;date=shiftDate(date,1)){
  const day=new Date(date+'T00:00:00Z');const start=mode==='day'?date:mode==='week'?shiftDate(date,-((day.getUTCDay()+6)%7)):date.slice(0,7)+'-01';
  const end=mode==='day'?date:mode==='week'?shiftDate(start,6):new Date(Date.UTC(day.getUTCFullYear(),day.getUTCMonth()+1,0)).toISOString().slice(0,10);
  let g=groups.get(start);if(!g){g={start,end,tokens:null,knownDays:0,expectedDays:Math.round((Date.parse(end)-Date.parse(start))/86400000)+1,partial:true};groups.set(start,g);}
  const value=daily.get(date);if(value!==undefined){g.tokens=(BigInt(g.tokens??'0')+BigInt(value)).toString();g.knownDays++;}
 }
 for(const g of groups.values())g.partial=g.knownDays!==g.expectedDays||g.end>=today||history.days.some(d=>d.partial&&d.date>=g.start&&d.date<=g.end);
 return [...groups.values()];
}
