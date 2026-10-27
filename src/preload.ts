import {contextBridge,ipcRenderer} from 'electron';
// Fixed channels only; no generic IPC, filesystem, shell or remote URL capability.
contextBridge.exposeInMainWorld('quota',{
 pickSource:(id:string)=>ipcRenderer.invoke('quota:source-pick',id),
 saveSources:(value:unknown)=>ipcRenderer.invoke('quota:sources',value),
 pickData:()=>ipcRenderer.invoke('quota:data-pick'),
 state:()=>ipcRenderer.invoke('quota:state'),
 kimiMembershipOpen:()=>ipcRenderer.invoke('quota:kimi-membership-open'),
 kimiMembershipLogout:()=>ipcRenderer.invoke('quota:kimi-membership-logout'),
 testNotification:()=>ipcRenderer.invoke('quota:notification-test'),
 refresh:(id:string)=>ipcRenderer.invoke('quota:refresh',id),
 settings:(value:unknown)=>ipcRenderer.invoke('quota:settings',value),
 saveKey:(id:string,value:string)=>ipcRenderer.invoke('quota:key-save',id,value),
 removeKey:(id:string)=>ipcRenderer.invoke('quota:key-remove',id),
 hide:()=>ipcRenderer.invoke('quota:hide'),
 webLogin:(id:string)=>ipcRenderer.invoke('quota:web-login',id),
 webLogout:(id:string)=>ipcRenderer.invoke('quota:web-logout',id),
 subscribe:(callback:(value:unknown)=>void)=>{const fn=(_e:unknown,value:unknown)=>callback(value);ipcRenderer.on('quota:update',fn);return()=>ipcRenderer.removeListener('quota:update',fn);}
});
