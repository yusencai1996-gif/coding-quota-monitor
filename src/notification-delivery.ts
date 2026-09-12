import type {Notice} from './notification-ledger';
export type DeliveryResult='shown'|'failed'|'timeout'|'blocked';
export interface NativeNotice {once(event:string,listener:(...args:any[])=>void):unknown;removeAllListeners():unknown;show():void;close():void}
// Never retain the native failed-event message. Only a fixed outcome leaves this adapter.
export function nativeDelivery(create:(notice:Notice)=>NativeNotice,allowed:()=>boolean,report:(result:DeliveryResult)=>void,timeout=10000){
 return async(notice:Notice):Promise<DeliveryResult>=>{if(!allowed())return 'blocked';return new Promise(resolve=>{
  let native:NativeNotice|undefined;let timer:ReturnType<typeof setTimeout>|undefined;let done=false;
  const finish=(result:DeliveryResult)=>{if(done)return;done=true;clearTimeout(timer);native?.removeAllListeners();if(result==='timeout')try{native?.close();}catch{}report(result);resolve(result);};
  try{native=create(notice);native.once('show',()=>finish('shown'));native.once('failed',()=>finish('failed'));timer=setTimeout(()=>finish('timeout'),timeout);if(allowed())native.show();else finish('blocked');}catch{finish('failed');}
 });};
}
