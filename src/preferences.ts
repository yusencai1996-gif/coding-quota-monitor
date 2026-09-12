import type {Settings}from'./model';
// Persist first: a failed disk write must never enable a Windows login item.
export async function commitPreferences(current:Settings,next:Settings,persist:(s:Settings)=>Promise<void>,applyLogin:(enabled:boolean)=>void|Promise<void>,nativeOwnsRollback=false){
 await persist(next);
 if(current.launchAtLogin!==next.launchAtLogin){try{await applyLogin(next.launchAtLogin);}catch(error){try{if(!nativeOwnsRollback)await applyLogin(current.launchAtLogin);}finally{await persist(current);}throw error;}}
}
