import type {ResetCard,ResetCards} from './activity-model';
import type {Provider} from './model';

// Keep exact storage/aggregation untouched; abbreviate only at the display boundary.
export function tokenText(raw:string|null|undefined,detailed=false):string {
  if(typeof raw!=='string'||!/^\d{1,30}$/.test(raw))return '暂无数据';
  const value=BigInt(raw);
  if(detailed)return value.toLocaleString('en-US');
  if(value===0n)return '0万';
  if(value<10000n)return `0.${value.toString().padStart(4,'0').replace(/0+$/,'')}万`;
  let unit=value>=100000000n?100000000n:value>=1000000n?1000000n:10000n;
  let suffix=unit===100000000n?'亿':unit===1000000n?'M':'万';
  let rounded=(value*100n+unit/2n)/unit;
  // Carry rounding across 万→M and M→亿 instead of displaying 100万 / 100M.
  if(unit<100000000n&&rounded>=10000n){unit*=100n;suffix=unit===1000000n?'M':'亿';rounded=(value*100n+unit/2n)/unit;}
  const fraction=(rounded%100n).toString().padStart(2,'0').replace(/0+$/,'');
  return `${rounded/100n}${fraction?'.'+fraction:''}${suffix}`;
}

// GLM domestic-site compatibility convention: naive timestamps use Asia/Shanghai.
// Explicit offsets always take precedence; reject invalid calendar/time components.
export function glmExpiryMs(value:unknown):number|null {
  if(typeof value!=='string')return null;
  const m=/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if(!m)return null;
  const [year,month,day,hour,minute,second]=m.slice(1,7).map(Number);
  const calendar=new Date(Date.UTC(year,month-1,day));
  if(year<1000||calendar.getUTCFullYear()!==year||calendar.getUTCMonth()!==month-1||calendar.getUTCDate()!==day||hour>23||minute>59||second>59)return null;
  const result=Date.parse(value.replace(' ','T')+(m[8]?'':'+08:00'));
  return Number.isFinite(result)?result:null;
}

export function cardExpiry(card:ResetCard,id:Provider):number|null {
  if(card.expiresAt!==null&&Number.isFinite(card.expiresAt))return card.expiresAt;
  return id==='glm'?glmExpiryMs(card.expiresLocal):null;
}

export function usableCards(data:ResetCards,id:Provider,now=Date.now()):ResetCards {
  const cards=data.cards.filter(card=>card.available===true).map(card=>({...card,expiresAt:cardExpiry(card,id)})).filter(card=>card.expiresAt===null||card.expiresAt>now);
  return {...data,cards,availableCount:data.detailsComplete?cards.length:data.availableCount};
}
