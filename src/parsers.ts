import{number,instant,duration}from'./parse-values';
export{number,instant,duration}from'./parse-values';
import {SafeError,type Provider,type Snapshot,type WindowQuota,type Balance} from './model';
import{createHash}from'node:crypto';
type Obj=Record<string,any>;
const obj=(x:unknown):Obj=>x!==null&&typeof x==='object'&&!Array.isArray(x)?x:{};
const percent=(x:unknown)=>{const n=number(x);return n!==null&&n<=100?n:null;};
const fromUsed=(label:string,used:unknown,resetAt:number|null):WindowQuota=>{const p=percent(used);return {label,remaining:p===null?null:100-p,resetAt};};
const ratio=(used:unknown,limit:unknown)=>{const u=number(used),l=number(limit);return u===null||l===null||l<=0?null:Math.min(100,u/l*100);};
// Kimi 官方客户端对省略的 used 使用协议默认值0；只在有效正数上限下采用。
// 显式null、坏字符串和缺失/零上限仍保持未知，不扩展到其它平台。
const kimiRatio=(row:Obj)=>ratio(row.used===undefined?0:row.used,row.limit);
// Only normalized numeric fields and fixed labels leave the main process. Never echo raw names/messages.
export function parse(id:Provider,input:unknown,now=Date.now()):Snapshot {
 const root=obj(input),d=obj(root.data);let windows:WindowQuota[]=[],balances:Balance[]=[],mcp:Snapshot['mcp'];
 if(id==='codex'){
  const rate=obj(root.rate_limit);for(const key of ['primary_window','secondary_window']){const w=obj(rate[key]);if(Object.keys(w).length)windows.push({...fromUsed(duration(w.limit_window_seconds),w.used_percent,instant(w.reset_at,'seconds')),id:'codex:main:'+key});}
  const review=obj(root.code_review_rate_limit);for(const key of ['primary_window','secondary_window']){const w=obj(review[key]);if(Object.keys(w).length)windows.push({...fromUsed('代码审查 · '+duration(w.limit_window_seconds),w.used_percent,instant(w.reset_at,'seconds')),id:'codex:review:'+key});}
  if(Array.isArray(root.additional_rate_limits))for(const v of root.additional_rate_limits.slice(0,10)){const pool=obj(v),r=obj(pool.rate_limit);const spark=pool.limit_name==='GPT-5.3-Codex-Spark'||pool.metered_feature==='codex_bengalfox';const label=spark?'GPT-5.3-Codex-Spark 专用额度':'额外模型额度（名称未识别）';const identity=createHash('sha256').update(JSON.stringify([typeof pool.limit_name==='string'?pool.limit_name.slice(0,200):'',typeof pool.metered_feature==='string'?pool.metered_feature.slice(0,200):''])).digest('hex');for(const key of ['primary_window','secondary_window']){const w=obj(r[key]);if(Object.keys(w).length)windows.push({...fromUsed(`${label} · ${duration(w.limit_window_seconds)}`,w.used_percent,instant(w.reset_at,'seconds')),id:'codex:extra:'+identity+':'+key});}}
  const credit=obj(root.credits);if(credit.unlimited===true)windows.push({label:'额外积分',remaining:null,resetAt:null,unlimited:true});else if(number(credit.balance)!==null)balances.push({label:'额外积分（非货币）',currency:'积分',total:number(credit.balance)!});
 }else if(id==='deepseek'){
  if(root.is_available===false&&!Array.isArray(root.balance_infos))throw new SafeError('schema');
  for(const b of Array.isArray(root.balance_infos)?root.balance_infos.slice(0,10):[]){const v=obj(b),n=number(v.total_balance);if(n!==null&&['CNY','USD'].includes(v.currency))balances.push({label:'API 余额',currency:v.currency,total:n,...(number(v.granted_balance)!==null?{granted:number(v.granted_balance)!}:{}),...(number(v.topped_up_balance)!==null?{paid:number(v.topped_up_balance)!}:{})});}
 }else if(id==='kimi'){
  const u=obj(root.usage);if(Object.keys(u).length)windows.push({...fromUsed('周窗口',kimiRatio(u),instant(u.resetTime,'iso')),id:'kimi:usage'});
  const units:Record<string,number>={TIME_UNIT_MINUTE:60,TIME_UNIT_HOUR:3600,TIME_UNIT_DAY:86400,TIME_UNIT_WEEK:604800};
  for(const v of Array.isArray(root.limits)?root.limits.slice(0,12):[]){const x=obj(v),w=obj(x.window),q=obj(x.detail);windows.push({...fromUsed(duration((number(w.duration)??0)*(units[w.timeUnit]??0)),kimiRatio(q),instant(q.resetTime,'iso')),id:'kimi:limit:'+number(w.duration)+':'+(units[w.timeUnit]??0)});}
  // Official Kimi Code uses usages.limit_month_total for the shared monthly pool.
  // limit_month_code is a contribution to that pool, not a separate remaining allowance.
  const usages=obj(root.usages);
  for(const [key,label,id]of [['limit_5h','5 小时窗口','kimi:ratio:5h'],['limit_7d','周窗口','kimi:usage'],['limit_month_total','月总额度（Kimi 与 Code 共用）','kimi:month-total']]){
   if(!Object.prototype.hasOwnProperty.call(usages,key))continue;
   const entry=obj(usages[key]),used=number(entry.used_ratio);
   // Keep legacy short/weekly readings when present; add ratio-only windows otherwise.
   if(key==='limit_5h'&&windows.some(w=>w.label==='5 小时窗口'))continue;
   if(key==='limit_7d'&&windows.some(w=>w.id==='kimi:usage'))continue;
   windows.push({...fromUsed(label,used!==null&&used<=1?used*100:null,instant(entry.reset_time,'iso')),id});
  }
  const wallet=obj(root.boosterWallet),balance=obj(wallet.balance),money=obj(wallet.monthlyChargeLimit),used=obj(wallet.monthlyUsed);const currency=money.currency??used.currency;
  if(balance.type==='BOOSTER'&&number(balance.amountLeft)!==null&&['CNY','USD'].includes(currency))balances.push({label:'补充余额',currency,total:number(balance.amountLeft)!/100000000});
 }else if(id==='opencode'){
  const usage=obj(root.usage);for(const [key,label]of [['rolling','滚动窗口'],['weekly','周窗口'],['monthly','月窗口']]){const w=obj(usage[key]);if(Object.keys(w).length)windows.push({...fromUsed(label,w.percent,instant(w.resetsAt,'iso')),id:'opencode:'+key});}
 }else if(id==='glm'){
  if(root.success===false||(root.code!==undefined&& ![0,200,'200','0'].includes(root.code)))throw new SafeError('auth');
  for(const [i,v] of (Array.isArray(d.limits)?d.limits:[]).slice(0,12).entries()){const w=obj(v);const unit=number(w.unit),count=number(w.number);const period=unit===3&&count===5?'5 小时窗口':unit===6&&count===1?'周窗口':null;const label=w.type==='TOKENS_LIMIT'?(period??'编程额度（周期未识别）'):w.type==='TIME_LIMIT'?'工具调用窗口':`额度窗口 ${i+1}`;windows.push({...fromUsed(label,w.percentage,instant(w.nextResetTime,'milliseconds')),id:'glm:'+(['TOKENS_LIMIT','TIME_LIMIT'].includes(w.type)?w.type:'unknown')+':'+unit+':'+count});if(w.type==='TIME_LIMIT')mcp={used:number(w.currentValue),limit:number(w.usage),details:(Array.isArray(w.usageDetails)?w.usageDetails:[]).slice(0,20).map((v:unknown)=>({used:number(obj(v).currentValue),limit:number(obj(v).usage)})).filter((v:{used:number|null;limit:number|null})=>v.used!==null&&v.limit!==null)};}
 }else if(id==='minimax'){
  const base=obj(root.base_resp);if(base.status_code!==undefined&&base.status_code!==0)throw new SafeError('auth');
  const rows=Array.isArray(root.model_remains)?root.model_remains:Array.isArray(d.model_remains)?d.model_remains:[];
  const general=rows.find((v:unknown)=>obj(v).model_name==='general');const selected=general?[general]:rows.slice(0,6);
  for(const [i,v]of selected.entries()){const w=obj(v),identity=createHash('sha256').update(typeof w.model_name==='string'?w.model_name.slice(0,200):'unknown').digest('hex');windows.push({id:'minimax:'+identity+':interval',label:`5 小时窗口${selected.length>1?' · '+(i+1):''}`,remaining:percent(w.current_interval_remaining_percent),resetAt:instant(w.end_time,'milliseconds'),...(w.current_interval_status===3?{unlimited:true}:{})});windows.push({id:'minimax:'+identity+':weekly',label:'周窗口',remaining:percent(w.current_weekly_remaining_percent),resetAt:instant(w.weekly_end_time,'milliseconds'),...(w.current_weekly_status===3?{unlimited:true}:{})});}
 }
 if(!windows.some(w=>w.remaining!==null||w.unlimited)&&balances.length===0)throw new SafeError('schema');
 return {kind:id==='deepseek'?'balance':'quota',windows,balances,updatedAt:now,...(mcp?{mcp}:{})};
}
