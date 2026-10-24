import {BrowserWindow,safeStorage,net,shell,type Session} from 'electron';
import {OpenCodeOAuth} from './opencode-oauth';
import {OpenCodeMcp} from './opencode-mcp';
import {OpenCodeConnection} from './opencode-connection';
import type {OpenCodeUsageSummary} from './opencode-usage';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {atomicWrite} from './storage';
import {WEB_HOME,allowedWebNavigation,type WebProvider} from './web-history-data';
import {mergeHistory} from './activity-parsers';
import {safeCode,SafeError} from './model';
import type {TokenHistory} from './activity-model';

import {persistentSession} from './web-session';
import {readBounded} from './opencode-history';
import {deepSeekHistoryURL,parseDeepSeekSeries} from './deepseek-history';

export interface WebConnectionState {status:string;history?:TokenHistory;coverage:string;pages?:number;records?:number;usage?:OpenCodeUsageSummary}
const IDS=['deepseek'] as const;
export class WebLogin {
 states:Record<WebProvider,WebConnectionState>={deepseek:{status:'not-connected',coverage:'官方按API Key月报，Token合计不包含请求次数'},opencode:{status:'not-connected',coverage:'在默认浏览器授权，读取当前账号的官方期间合计'}};

 private windows=new Map<WebProvider,BrowserWindow>();private sessions=new Map<WebProvider,Session>();
 private cleanups=new Map<WebProvider,Promise<void>>();private enabled:Partial<Record<WebProvider,boolean>>={};
 private migrationRevoked:Partial<Record<WebProvider,boolean>>={};private metadataWrites:Promise<unknown>=Promise.resolve();
 private versions=new Map<WebProvider,number>();private intents=new Map<WebProvider,number>();
 private running=new Map<WebProvider,AbortController>();private timers=new Map<WebProvider,ReturnType<typeof setTimeout>>();
 private dsAuth?:string;private dsFull=false;
 private closing=false;
 private consoleConnection:OpenCodeConnection;
 constructor(private publish:()=>void,private root:string){
  const auth=new OpenCodeOAuth({root,fetcher:net.fetch as typeof fetch,openExternal:url=>shell.openExternal(url),crypto:{available:async()=>process.platform==='win32'&&await safeStorage.isAsyncEncryptionAvailable(),encrypt:v=>safeStorage.encryptStringAsync(v),decrypt:async v=>(await safeStorage.decryptStringAsync(v)).result},onChange:()=>this.consoleConnection?.authorizationChanged()});
  this.consoleConnection=new OpenCodeConnection(auth,()=>new OpenCodeMcp(net.fetch as typeof fetch,()=>auth.accessToken(),{allowedReadTools:['get_usage']}),state=>{this.states.opencode=state;this.publish();});
 }
 private version(id:'deepseek'){return this.versions.get(id)??0;}
 private session(id:'deepseek'){let value=this.sessions.get(id);if(value)return value;value=persistentSession(id);value.setPermissionRequestHandler((_w,_p,done)=>done(false));value.setPermissionCheckHandler(()=>false);value.on('will-download',e=>e.preventDefault());this.sessions.set(id,value);return value;}
 private saveEnabled(){const body=JSON.stringify({schema:1,enabled:this.enabled,migrationRevoked:this.migrationRevoked});const job=this.metadataWrites.catch(()=>{}).then(()=>atomicWrite(join(this.root,'web-login-enabled-v1.json'),body));this.metadataWrites=job.catch(()=>{});return job;}
 async initialize(){
  try{const saved=JSON.parse(await readFile(join(this.root,'web-login-enabled-v1.json'),'utf8'));if(saved.schema===1)for(const id of IDS){if(typeof saved.enabled?.[id]==='boolean')this.enabled[id]=saved.enabled[id];if(saved.migrationRevoked?.[id]===true||saved.enabled?.[id]===false)this.migrationRevoked[id]=true;}}catch{}
  for(const id of IDS)if(this.enabled[id])this.states[id].status='checking-login';
  this.publish();
 }
 start(){void this.consoleConnection.open(false);for(const id of IDS)if(this.enabled[id])void this.open(id,false).catch(()=>{this.states[id].status='storage';this.publish();});}
 private invalidate(id:'deepseek',status='login-required'){
  this.versions.set(id,this.version(id)+1);this.running.get(id)?.abort();this.running.delete(id);clearTimeout(this.timers.get(id));this.timers.delete(id);
  this.dsAuth=undefined;this.dsFull=false;
  this.states[id]={status,coverage:this.states[id].coverage};this.publish();
 }
 async open(id:WebProvider,visible=true){
  if(id==='opencode'){await this.consoleConnection.open(visible);return;}
  const intent=(this.intents.get(id)??0)+1;this.intents.set(id,intent);await this.cleanups.get(id);if(this.closing||this.intents.get(id)!==intent)return;
  const existing=this.windows.get(id);if(existing&&!existing.isDestroyed()){if(visible){existing.show();existing.focus();}void this.bootstrap(id,existing);return;}
  this.enabled[id]=true;await this.saveEnabled();if(this.closing||this.intents.get(id)!==intent)return;
  const ses=this.session(id),win=new BrowserWindow({width:1000,height:800,show:visible,title:'DeepSeek 官方用量 · 独立登录',webPreferences:{session:ses,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,devTools:false}});
  this.windows.set(id,win);if(!this.states[id].history)this.states[id].status='checking-login';this.publish();
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-attach-webview',e=>e.preventDefault());
  const navigation=(event:{preventDefault():void},url:string)=>{if(!allowedWebNavigation(id,url))event.preventDefault();};win.webContents.on('will-navigate',navigation);win.webContents.on('will-redirect',navigation);
  win.webContents.on('did-start-navigation',(_event,url,_inPlace,main)=>{
   if(!main||!allowedWebNavigation(id,url))return;const u=new URL(url);
   if(/\/(?:sign_in|login)(?:\/|$)/.test(u.pathname))this.invalidate(id);
  });
  win.webContents.on('did-finish-load',()=>void this.bootstrap(id,win));win.webContents.on('did-navigate-in-page',()=>void this.bootstrap(id,win));
  this.watch(id,win);
  win.on('closed',()=>{if(this.windows.get(id)===win)this.windows.delete(id);if(this.states[id].status==='checking-login'&&!this.states[id].history)this.states[id].status='login-required';this.publish();});
  void win.loadURL(WEB_HOME[id]).catch(()=>{if(this.windows.get(id)===win){this.states[id].status='network';this.publish();}});
 }
 private async bootstrap(id:'deepseek',win:BrowserWindow){
  const version=this.version(id);if(this.closing||win.isDestroyed()||this.windows.get(id)!==win)return;
  const url=win.webContents.getURL();
  try{
   if(new URL(url).origin!=='https://platform.deepseek.com'||!new URL(url).pathname.startsWith('/usage'))return;
   // Only this publicly verified login key is read; the value never leaves the main process.
   const token=await win.webContents.executeJavaScript("(()=>{try{const raw=JSON.parse(localStorage.getItem('userToken')||'null');return typeof raw==='string'?raw:typeof raw?.value==='string'?raw.value:null;}catch{return null;}})()");
   if(this.closing||version!==this.version(id)||win.isDestroyed()||win.webContents.getURL()!==url)return;
   if(typeof token!=='string'||!token||token.length>65536||/[\r\n\0]/.test(token)){this.states[id].status='login-required';this.publish();return;}
   this.adoptDeepSeek('Bearer '+token);
  }catch{if(version===this.version(id)&&!this.closing){this.states[id].status='schema';this.publish();}}
 }
 private adoptDeepSeek(auth:string){if(!auth.startsWith('Bearer ')||auth.length>65543||/[\r\n\0]/.test(auth))return;if(this.dsAuth!==auth){this.invalidate('deepseek','reading');this.dsAuth=auth;}void this.readDeepSeek(!this.dsFull);}
 private watch(id:'deepseek',win:BrowserWindow){
  win.webContents.debugger.attach('1.3');void win.webContents.debugger.sendCommand('Network.enable');
  win.webContents.debugger.on('message',(_event,method,p)=>{
   if(this.closing||this.windows.get(id)!==win||win.isDestroyed())return;
   if(method==='Network.requestWillBeSent'){try{const u=new URL(p.request?.url);if(u.origin==='https://platform.deepseek.com'&&u.pathname==='/api/v0/usage/by_api_key/amount'&&p.documentURL===win.webContents.getURL())void this.bootstrap(id,win);}catch{}return;}
  });
 }
 private schedule(id:'deepseek'){clearTimeout(this.timers.get(id));if(!this.closing&&this.enabled[id])this.timers.set(id,setTimeout(()=>this.refresh(id),900000));}
 private async readDeepSeek(full=false){const id='deepseek',auth=this.dsAuth,version=this.version(id);if(!auth||this.closing||this.running.has(id))return;clearTimeout(this.timers.get(id));const controller=new AbortController();this.running.set(id,controller);const timeout=setTimeout(()=>controller.abort(),90000);const valid=()=>!this.closing&&this.version(id)===version&&this.dsAuth===auth&&!controller.signal.aborted;
  this.states[id].status='reading';this.publish();
  try{for(let offset=0;offset<(full?13:1);offset++){if(!valid())return;const r=await this.session(id).fetch(deepSeekHistoryURL(Date.now(),offset),{method:'GET',headers:{Authorization:auth,Accept:'application/json'},credentials:'omit',redirect:'error',signal:controller.signal});if(!valid())return;if(!r.ok)throw new SafeError(r.status===401||r.status===403?'auth':'network');const body=await readBounded(r);if(!valid())return;const history=parseDeepSeekSeries(JSON.parse(body));this.states[id].history=mergeHistory(this.states[id].history,history);this.states[id].status='connected-partial';this.publish();}if(valid()){this.dsFull ||= full;this.states[id].status='connected';this.states[id].coverage='官方按API Key用量：缓存命中输入+未命中输入+输出；北京时间日，当前日仍在变化';this.session(id).flushStorageData();await this.session(id).cookies.flushStore();}}
  catch(e){if(this.version(id)===version&&!this.closing){if(safeCode(e)==='auth')this.invalidate(id);else{this.states[id].status=safeCode(e);this.publish();}}}
  finally{clearTimeout(timeout);if(this.running.get(id)===controller){this.running.delete(id);this.schedule(id);}this.publish();}
 }
 refresh(id:WebProvider){if(id==='opencode'){void this.consoleConnection.open(false);return;}if(this.dsAuth)void this.readDeepSeek(!this.dsFull);else{const win=this.windows.get(id);if(win&&!win.isDestroyed())void this.bootstrap(id,win);else if(this.enabled[id])void this.open(id,false);}}
 async logout(id:WebProvider){if(id==='opencode'){await this.consoleConnection.logout();return;}this.intents.set(id,(this.intents.get(id)??0)+1);const previous=this.cleanups.get(id);const cleanup=(async()=>{await previous;this.enabled[id]=false;this.migrationRevoked[id]=true;await this.saveEnabled();this.invalidate(id,'not-connected');const win=this.windows.get(id);this.windows.delete(id);if(win&&!win.isDestroyed())win.destroy();const ses=this.session(id);await ses.clearStorageData();await ses.clearCache();ses.flushStorageData();await ses.cookies.flushStore();})();this.cleanups.set(id,cleanup);try{await cleanup;}finally{if(this.cleanups.get(id)===cleanup)this.cleanups.delete(id);}}
 async close(){this.closing=true;await this.consoleConnection.close();for(const id of IDS){this.versions.set(id,this.version(id)+1);this.running.get(id)?.abort();clearTimeout(this.timers.get(id));const win=this.windows.get(id);if(win&&!win.isDestroyed())win.destroy();}this.dsAuth=undefined;await Promise.allSettled([...this.cleanups.values(),this.metadataWrites]);await Promise.allSettled([...this.sessions.values()].map(async ses=>{ses.flushStorageData();await ses.cookies.flushStore();}));}
}
