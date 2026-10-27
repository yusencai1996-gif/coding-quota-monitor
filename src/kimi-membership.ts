import {BrowserWindow,session,type Session} from 'electron';
import {readFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {atomicWrite} from './storage';
import {parseKimiMembership,type KimiMembershipQuota} from './kimi-membership-data';

export const KIMI_MEMBERSHIP_HOME='https://www.kimi.com/membership/subscription?tab=quota';
export const KIMI_LOGIN_HOME='https://www.kimi.com/login';
const STATS='https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats';
export interface KimiMembershipState {status:'not-connected'|'paused'|'login-required'|'reading'|'connected'|'schema'|'network'|'storage';quota?:KimiMembershipQuota;updatedAt?:number}
// A separate browser partition. We observe only the official quota RPC response;
// credentials, chat responses, billing history and existing browser profiles are never imported.
export class KimiMembership {
 state:KimiMembershipState={status:'not-connected'};
 private window?:BrowserWindow;private ses?:Session;private enabled=false;private closed=false;private monitoring=true;
 private epoch=0;private timer?:ReturnType<typeof setTimeout>;private authStamp='';
 private backgroundTimer?:ReturnType<typeof setTimeout>;
 private scope?:string;
 private pending=new Map<string,{epoch:number;accepted?:boolean}>();private writes:Promise<unknown>=Promise.resolve();
 private intent=0;private cleanup?:Promise<void>;private children=new Set<BrowserWindow>();
 private cookieListener?:(_event:unknown,cookie:{domain?:string},cause:string,removed:boolean)=>void;
 private downloadListener?:(event:{preventDefault():void})=>void;
 constructor(private root:string,private publish:()=>void,private desktop:{BrowserWindow:typeof BrowserWindow;session:typeof session}={BrowserWindow,session}){}
 private persist(){const body=JSON.stringify({schema:1,enabled:this.enabled});const job=this.writes.catch(()=>{}).then(()=>atomicWrite(join(this.root,'kimi-membership-enabled-v1.json'),body));this.writes=job.catch(()=>{});return job;}
 async initialize(){try{const d=JSON.parse(await readFile(join(this.root,'kimi-membership-enabled-v1.json'),'utf8'));this.enabled=d.schema===1&&d.enabled===true;}catch{} }
 start(){if(this.enabled&&this.monitoring)void this.open(false).catch(()=>{if(!this.closed&&this.monitoring)this.invalidate('storage');});}
 configure(enabled:boolean){if(this.monitoring===enabled)return;this.monitoring=enabled;if(!enabled){this.intent++;clearTimeout(this.timer);clearTimeout(this.backgroundTimer);this.invalidate('paused');const win=this.window;this.window=undefined;if(win&&!win.isDestroyed())win.destroy();for(const child of this.children)if(!child.isDestroyed())child.destroy();}else{this.state={status:'not-connected'};this.publish();this.start();}}
 private invalidate(status:KimiMembershipState['status']){this.epoch++;this.pending.clear();this.scope=undefined;this.state={status};this.publish();}
 noticeScope(){return this.state.status==='connected'?this.scope:undefined;}
 private allowed(url:string){try{const u=new URL(url);return u.protocol==='https:'&&['www.kimi.com','kimi.com','accounts.google.com'].includes(u.hostname);}catch{return false;}}
 private schedule(){clearTimeout(this.timer);if(this.enabled&&this.monitoring&&!this.closed&&this.state.status!=='login-required')this.timer=setTimeout(()=>this.refresh(),300000);}
 private park(win:BrowserWindow){if(this.window!==win)return;clearTimeout(this.backgroundTimer);this.epoch++;this.pending.clear();this.window=undefined;if(!win.isDestroyed())win.destroy();for(const child of this.children)if(!child.isDestroyed())child.destroy();}
 private boundBackground(win:BrowserWindow){clearTimeout(this.backgroundTimer);this.backgroundTimer=setTimeout(()=>{if(this.window===win&&!win.isVisible()){if(['reading','not-connected','login-required'].includes(this.state.status))this.invalidate('login-required');this.park(win);this.schedule();}},30000);}
 async open(visible=true){
  const intent=++this.intent;await this.cleanup;if(this.closed||!this.monitoring||intent!==this.intent)return;
  if(this.window&&!this.window.isDestroyed()){if(visible){this.window.show();this.window.focus();const target=this.state.status==='connected'?KIMI_MEMBERSHIP_HOME:KIMI_LOGIN_HOME;if(this.window.webContents.getURL()!==target)void this.window.loadURL(target).catch(()=>{});}else this.refresh();return;}
  if(!this.enabled){this.enabled=true;try{await mkdir(this.root,{recursive:true});await this.persist();}catch(error){if(intent===this.intent)this.enabled=false;throw error;}}if(this.closed||!this.enabled||intent!==this.intent)return;
  this.ses??=this.desktop.session.fromPartition('persist:quota-kimi-membership-v1');
  // This partition belongs only to Kimi. Pause website/worker requests too,
  // without deleting cookies or inspecting any request headers.
  this.ses.webRequest?.onBeforeRequest((_details,done)=>done({cancel:this.closed||!this.enabled||!this.monitoring}));
  // Cookie metadata only. A normal overwrite is not a logout; never inspect values.
  if(!this.cookieListener){this.cookieListener=(_event,cookie,cause,removed)=>{
   if(removed&&['explicit','expired','evicted','expired-overwrite'].includes(cause)&&['.kimi.com','www.kimi.com','kimi.com'].includes(cookie.domain??'')&&this.enabled&&this.monitoring&&!this.closed)this.invalidate('login-required');
  };this.ses.cookies.on('changed',this.cookieListener);}
  this.ses.setPermissionRequestHandler((_w,_p,done)=>done(false));this.ses.setPermissionCheckHandler(()=>false);
  if(!this.downloadListener){this.downloadListener=e=>e.preventDefault();this.ses.on('will-download',this.downloadListener);}
  const win=new this.desktop.BrowserWindow({width:1000,height:800,show:visible,title:'Kimi 会员月额度',webPreferences:{session:this.ses,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,devTools:false}});
  this.window=win;this.state={status:visible?'login-required':'reading'};this.publish();
  win.webContents.setUserAgent(this.ses.getUserAgent().replace(/ Electron\/\S+/g,''));
  win.on('close',e=>{if(!this.closed&&this.enabled){e.preventDefault();win.hide();if(this.state.status==='connected'){this.park(win);this.schedule();}else{this.refresh();this.boundBackground(win);}}});
  win.webContents.on('will-navigate',(e,url)=>{if(!this.allowed(url))e.preventDefault();});
  win.webContents.on('will-redirect',(e,url)=>{if(!this.allowed(url))e.preventDefault();});
  // Document and SPA navigation fence responses captured in the previous page context.
  win.webContents.on('did-start-navigation',(_e,_url,_inPlace,main)=>{if(main&&!this.closed&&this.enabled&&this.window===win)this.invalidate('reading');});
  // Kimi's dedicated login page returns to / after success or cancellation.
  // That navigation is not proof of login: only the quota RPC can mark connected.
  let loginPage=false;
  const afterNavigation=(url:string)=>{if(this.closed||!this.enabled||!this.monitoring||this.window!==win)return;let u:URL;try{u=new URL(url);}catch{return;}if(u.origin!=='https://www.kimi.com')return;if(u.pathname==='/login'){loginPage=true;return;}if(loginPage&&u.pathname==='/'){loginPage=false;void win.loadURL(KIMI_MEMBERSHIP_HOME).catch(()=>{if(!this.closed&&this.window===win)this.invalidate('network');});}};
  win.webContents.on('did-navigate',(_e,url)=>afterNavigation(url));
  win.webContents.on('did-navigate-in-page',(_e,url,main)=>{if(main)afterNavigation(url);});
  win.webContents.setWindowOpenHandler(({url})=>this.allowed(url)?{action:'allow',overrideBrowserWindowOptions:{webPreferences:{session:this.ses,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}}}:{action:'deny'});
  win.webContents.on('did-create-window',child=>{this.children.add(child);child.webContents.on('will-navigate',(e,url)=>{if(!this.allowed(url))e.preventDefault();});child.webContents.on('will-redirect',(e,url)=>{if(!this.allowed(url))e.preventDefault();});child.webContents.setWindowOpenHandler(()=>({action:'deny'}));child.on('closed',()=>this.children.delete(child));});
  win.webContents.debugger.attach('1.3');
  // Network.enable may await renderer initialization; do not await it before loadURL.
  void win.webContents.debugger.sendCommand('Network.enable').catch(()=>{if(!this.closed&&this.enabled&&this.window===win)this.invalidate('network');});
  win.webContents.debugger.on('message',(_event,method,p)=>{void this.observe(win,method,p).catch(()=>{if(!this.closed&&this.window===win){this.invalidate('schema');this.schedule();}});});
  win.webContents.on('did-fail-load',(_e,code,_text,_url,main)=>{if(main&&code!==-3&&!this.closed&&this.enabled&&this.window===win){this.invalidate('network');this.schedule();}});
  // Opening the main panel must not wait for the entire remote site's resource load.
  void win.loadURL(visible?KIMI_LOGIN_HOME:KIMI_MEMBERSHIP_HOME).catch(()=>{if(!this.closed&&this.enabled&&this.window===win){this.invalidate('network');if(!win.isVisible())this.park(win);this.schedule();}});if(!visible)this.boundBackground(win);this.schedule();
 }
 private async observe(win:BrowserWindow,method:string,p:any){
  if(this.closed||!this.enabled||!this.monitoring||win.isDestroyed()||this.window!==win)return;
  if(method==='Network.requestWillBeSent'&&this.pending.has(p.requestId)&&(p.request?.url!==STATS||p.redirectResponse)){this.invalidate('login-required');return;}
  if(method==='Network.requestWillBeSent'&&p.request?.url===STATS){
   // Hash only: a changed login/request context invalidates the prior quota immediately.
   const header=Object.entries(p.request.headers??{}).find(([k])=>k.toLowerCase()==='authorization')?.[1];
   const stamp=typeof header==='string'?createHash('sha256').update(header).digest('hex'):'';
   if(stamp!==this.authStamp){this.authStamp=stamp;this.invalidate('reading');}
   if(this.pending.size>=16)this.pending.clear();this.pending.set(p.requestId,{epoch:this.epoch});return;
  }
  const record=this.pending.get(p.requestId);if(!record)return;
  if(method==='Network.responseReceived'&&p.response?.url===STATS){
   if(p.response.status===401||p.response.status===403){this.invalidate('login-required');if(!win.isVisible())this.park(win);this.schedule();return;}
   if(p.response.status!==200){this.invalidate('network');return;}
   record.accepted=true;
  }
  if(method==='Network.loadingFailed'){this.invalidate('network');return;}
  if(method!=='Network.loadingFinished')return;this.pending.delete(p.requestId);
  if(record.epoch!==this.epoch||!record.accepted)return;
  if(p.encodedDataLength>1048576)throw Error('quota-size');
  let response;try{response=await win.webContents.debugger.sendCommand('Network.getResponseBody',{requestId:p.requestId});}catch(error){if(record.epoch!==this.epoch||this.closed||this.window!==win)return;throw error;}
  if(record.epoch!==this.epoch||this.closed||!this.enabled||!this.monitoring||win.isDestroyed())return;
  if(typeof response.body!=='string'||response.body.length>1400000)throw Error('quota-size');
  const bytes=response.base64Encoded?Buffer.from(response.body,'base64'):Buffer.from(response.body);
  if(bytes.length>1048576)throw Error('quota-size');
  const raw=JSON.parse(bytes.toString('utf8')),quota=parseKimiMembership(raw);
  const balance=raw.subscriptionBalance??raw.subscription_balance,id=balance?.id;
  this.scope=typeof id==='string'&&id.length>0&&id.length<=4096?createHash('sha256').update('kimi-membership:'+id).digest('hex'):this.authStamp||undefined;
  this.state={status:'connected',quota,updatedAt:Date.now()};this.publish();
  try{this.ses!.flushStorageData();await this.ses!.cookies.flushStore();}catch(error){if(record.epoch!==this.epoch||this.closed||this.window!==win)return;throw error;}if(this.window===win&&!win.isVisible())this.park(win);this.schedule();
 }
 refresh(){if(this.closed||!this.enabled||!this.monitoring)return;const win=this.window;if(!win||win.isDestroyed()){void this.open(false).catch(()=>{if(!this.closed&&this.monitoring)this.invalidate('storage');});return;}if(win.isVisible()){this.schedule();return;}this.invalidate('reading');void win.loadURL(KIMI_MEMBERSHIP_HOME).catch(()=>{if(!this.closed&&this.monitoring&&this.window===win)this.invalidate('network');});this.schedule();}
 async logout(){this.intent++;this.enabled=false;this.invalidate('not-connected');clearTimeout(this.timer);clearTimeout(this.backgroundTimer);const previous=this.cleanup;const job=(async()=>{await previous;await this.persist();const win=this.window;this.window=undefined;if(win&&!win.isDestroyed())win.destroy();for(const child of this.children)if(!child.isDestroyed())child.destroy();if(this.ses){await this.ses.clearStorageData();await this.ses.clearCache();this.ses.flushStorageData();await this.ses.cookies.flushStore();}this.authStamp='';})();this.cleanup=job;try{await job;}finally{if(this.cleanup===job)this.cleanup=undefined;}}
 async close(){this.closed=true;this.intent++;this.epoch++;this.pending.clear();clearTimeout(this.timer);clearTimeout(this.backgroundTimer);if(this.window&&!this.window.isDestroyed())this.window.destroy();for(const child of this.children)if(!child.isDestroyed())child.destroy();await Promise.allSettled([this.writes,this.cleanup]);if(this.ses){if(this.cookieListener)this.ses.cookies.removeListener('changed',this.cookieListener);if(this.downloadListener)this.ses.removeListener('will-download',this.downloadListener);this.ses.flushStorageData();await this.ses.cookies.flushStore();}}
}
