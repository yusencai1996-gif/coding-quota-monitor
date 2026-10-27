import {number,instant} from './parse-values';
import {SafeError} from './model';
export interface KimiMembershipQuota {remaining:number;periodEndAt:number|null}
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
// Official MembershipService/GetSubscriptionStats selects the subscription pool,
// not gift balances, booster wallets, or the Code share of this same monthly pool.
export function parseKimiMembership(raw:unknown):KimiMembershipQuota{
 const root=obj(raw),balance=obj(root.subscriptionBalance??root.subscription_balance);
 if(!Object.keys(balance).length)throw new SafeError('schema');
 const kind=balance.type;if(kind!==undefined&&!['SUBSCRIPTION',1].includes(kind as any))throw new SafeError('schema');
 const value=Object.hasOwn(balance,'amountUsedRatio')?balance.amountUsedRatio:balance.amount_used_ratio;
 // The official web client uses protobuf's zero default only for a present balance.
 const integer=(v:unknown)=>typeof v==='string'&&/^\d{1,30}$/.test(v)?BigInt(v):typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?BigInt(v):null;
 const amount=integer(balance.amount),left=integer(balance.amountLeft??balance.amount_left);
 const zeroDefault=value===undefined&&amount!==null&&amount>0n&&left===amount;
 const used=zeroDefault?0:number(value);if(used===null)throw new SafeError('schema');
 return {remaining:Math.max(0,100-used*100),periodEndAt:instant(balance.expireTime??balance.expire_time,'iso')};
}
