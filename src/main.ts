import {app,BrowserWindow,Tray,Menu,nativeImage,screen,ipcMain,safeStorage,powerMonitor,Notification,net,session,dialog} from 'electron';
import{AutostartManager,nativeTaskRunner,shouldShowSecondInstance,afterAutostartTransactions}from'./autostart';
import{StartupDiagnostics}from'./startup-diagnostics';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdir,readFile} from 'node:fs/promises';
import {IDS,NAMES,defaults,settings,provider,safeCode,SafeError,type Settings} from './model';
import {KeyStore,atomicWrite} from './storage';
import {Scheduler} from './scheduler';
import {requestQuota} from './adapters';
import {trustedSender} from './security';
import {commitPreferences} from './preferences';
import{LowQuotaNotices}from'./low-quota-notices';import{nativeDelivery,type DeliveryResult}from'./notification-delivery';
import {Auxiliary}from'./auxiliary';
import {credentials,queryActivity,accountScope}from'./activity-requests';
import {HistoryStore}from'./history-store';
import {HealthMonitor}from'./health';import{WebLogin}from'./web-login';import{isWebProvider}from'./web-history-data';
import{NotificationLedger,cardNotices}from'./notification-ledger';import{inspectZCode,readKimiLocal,type LocalStats}from'./local-statistics';import{createHash}from'node:crypto';
import{prepareProfile,windowsIdentity,selectionFile,type Profile}from'./profile';
import{defaultSources,parseSources,SOURCE_IDS,type Sources,type SourceId}from'./sources';
const appDirectory=app.isPackaged?dirname(process.execPath):join(process.cwd(),'dist'),bundleRoot=app.isPackaged?dirname(appDirectory):process.cwd();
let profile:Profile;let sid:string;
try{sid=windowsIdentity();profile=prepareProfile(appDirectory,bundleRoot,process.argv,sid);}catch{dialog.showErrorBox('无法打开数据目录','数据位置不可用、配置损坏或归属不匹配。请检查程序旁的数据位置配置及目录权限；没有切换到其他数据目录。');app.exit(1);throw Error('profile-unavailable');}
const DATA=profile.directory;
app.setPath('userData',join(DATA,'electron'));app.setPath('sessionData',join(DATA,'session'));app.setPath('logs',join(DATA,'logs'));app.setAppUserModelId(profile.appId);
const startupLog=new StartupDiagnostics(DATA,app.getVersion(),process.pid,process.argv.includes('--hidden'));void startupLog.record('process-start');
const canManageAutostart=app.isPackaged;
const taskHelper=app.isPackaged?join(process.resourcesPath,'manage-profile-autostart.ps1'):join(process.cwd(),'scripts','manage-profile-autostart.ps1');
const autostart=new AutostartManager(DATA,nativeTaskRunner(taskHelper,process.execPath,{dataRoot:profile.dataRoot,taskName:profile.taskName}));
let sources:Sources=defaultSources(),localGeneration=0,localAbort:AbortController|undefined,dataSwitchPending=false;
let window:BrowserWindow,tray:Tray,quitting=false,config:Settings=defaults(),scheduler:Scheduler,keys:KeyStore,auxiliary:Auxiliary,historyStore:HistoryStore;
let health:HealthMonitor,webLogin:WebLogin,notices:NotificationLedger;let localStats:{zcode?:LocalStats;kimi?:LocalStats}={};let localTimer:ReturnType<typeof setInterval>|undefined;let localBusy=false;
let settingsChain:Promise<unknown>=Promise.resolve();const presence=Object.fromEntries(IDS.map(id=>[id,false]));
const uiUrl=pathToFileURL(join(__dirname,'index.html')).href;
let lowNotices:LowQuotaNotices;const quotaScopes:Partial<Record<typeof IDS[number],string>>={};let notificationResult:DeliveryResult|'not-tested'='not-tested';let notificationTestBusy=false;
const sendNotification=nativeDelivery(n=>new Notification({title:n.title,body:n.body}),notificationAllowed,result=>{notificationResult=result;});
function publicState(){return {settings:config,providers:IDS.map(id=>scheduler.states[id]),hasKey:presence,auxiliary:auxiliary?.states,historyMaintenance:historyStore?.maintenanceStatus,health:health?.states,webConnections:webLogin?.states,localStats,sources,dataLocation:{root:profile.dataRoot,directory:DATA,firstRun:profile.firstRun},autostart:autostart.state,notificationDiagnostics:{supported:Notification.isSupported(),lastResult:notificationResult}};}
function notificationAllowed(){return config.notifications&&!quitting&&Notification.isSupported();}
function observeLowQuota(){if(!lowNotices||quitting)return;for(const id of IDS){const state=scheduler.states[id],scope=quotaScopes[id],data=state.data;if(scope&&data)void lowNotices.observe(state,scope,()=>notificationAllowed()&&scheduler.states[id].status==='ok'&&scheduler.states[id].enabled&&scheduler.states[id].data===data&&quotaScopes[id]===scope).catch(()=>{});}}
function publish(){if(window&&!window.isDestroyed())window.webContents.send('quota:update',publicState());if(notices&&auxiliary&&notificationAllowed())for(const id of ['glm','codex']as const){const cards=auxiliary.states[id].cards,scope=auxiliary.scopeFor(id);if(cards.status==='ok'&&cards.data&&scope)void notices.deliver(cardNotices(id,scope,cards.data),()=>notificationAllowed()&&auxiliary.scopeFor(id)===scope&&auxiliary.states[id].cards.status==="ok").catch(()=>{});}}
function reconcileAutostart(){if(!canManageAutostart||!config.launchAtLogin)return;const work=settingsChain.then(async()=>{try{const result=await autostart.reconcile(config.launchAtLogin);if(result.status==='preserved-disabled'||result.status==='preserved-removed'){const next={...config,launchAtLogin:false};await atomicWrite(join(DATA,'settings.json'),JSON.stringify(next));config=next;}void startupLog.record('autostart-ok');}catch{void startupLog.record('autostart-failed');}publish();});settingsChain=work.catch(()=>{});}
async function refreshLocal(){if(localBusy||quitting)return;localBusy=true;const generation=localGeneration,current=sources;localAbort=new AbortController();try{const result={zcode:current.zcode.enabled?inspectZCode(current.zcode):undefined,kimi:current.kimi.enabled?await readKimiLocal(current.kimi,localAbort.signal):undefined};if(generation===localGeneration){localStats=result;publish();}}catch{if(generation===localGeneration){localStats={};publish();}}finally{localBusy=false;if(generation!==localGeneration&&!quitting)void refreshLocal();}}

function show(){if(!window)return;const b=tray.getBounds(),area=screen.getDisplayNearestPoint({x:b.x,y:b.y}).workArea;const [w,h]=window.getSize();window.setPosition(Math.max(area.x,Math.min(b.x+w>area.x+area.width?area.x+area.width-w:b.x,area.x+area.width-w)),Math.max(area.y,area.y+area.height-h-8));window.show();window.focus();}
function toggle(){if(window.isVisible())window.hide();else show();}
function register(channel:string,fn:(...args:any[])=>unknown){ipcMain.handle(channel,async(e,...args)=>{if(!trustedSender(e.sender.id,window.webContents.id,e.senderFrame,window.webContents.mainFrame,e.senderFrame?.url??'',uiUrl))return {ok:false,error:'schema'};try{return {ok:true,value:await fn(...args)};}catch(err){return {ok:false,error:safeCode(err)};}});}
if(!app.requestSingleInstanceLock()){void startupLog.record('duplicate-exit').finally(()=>app.quit());}else{
 app.on('second-instance',(_event,argv)=>{if(shouldShowSecondInstance(argv)){void startupLog.record('duplicate-shown');if(window)show();}else void startupLog.record('duplicate-ignored');});
 let quitPhase:'running'|'waiting'|'ready'='running';app.on('before-quit',event=>{
  quitting=true;if(quitPhase==='ready')return;event.preventDefault();if(quitPhase==='waiting')return;quitPhase='waiting';void startupLog.record('quitting');
  // Native startup operations and settings rollback have no short flush deadline.
  void afterAutostartTransactions(settingsChain,autostart.settled(),async()=>{
   localAbort?.abort();scheduler?.stop();auxiliary?.stop();health?.stop();clearInterval(localTimer);tray?.destroy();
   await Promise.allSettled([notices?.settled()??Promise.resolve(),lowNotices?.settled()??Promise.resolve()]);
   await Promise.race([Promise.allSettled([webLogin?.close()??Promise.resolve(),startupLog.flush()]),new Promise(resolve=>setTimeout(resolve,3000))]);
  }).finally(()=>{quitPhase='ready';app.quit();});
 });
 app.whenReady().then(async()=>{void startupLog.record('ready');
 await mkdir(DATA,{recursive:true});
 try{config=settings(JSON.parse(await readFile(join(DATA,'settings.json'),'utf8')));void startupLog.record('settings-loaded');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw new SafeError('storage');void startupLog.record('settings-defaults');}
 try{sources=parseSources(JSON.parse(await readFile(join(DATA,'sources.json'),'utf8')));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw new SafeError('storage');}
 keys=new KeyStore(join(DATA,'keys'),{available:async()=>process.platform==='win32'&&await safeStorage.isAsyncEncryptionAvailable(),encrypt:v=>safeStorage.encryptStringAsync(v),decrypt:async v=>(await safeStorage.decryptStringAsync(v)).result});
 for(const id of IDS)if(id!=='codex')presence[id]=await keys.has(id);
 notices=new NotificationLedger(join(DATA,'notifications-v1.json'),sendNotification);lowNotices=new LowQuotaNotices(join(DATA,'low-quota-notices-v1.json'),sendNotification);
 health=new HealthMonitor(publish,net.fetch as typeof fetch);webLogin=new WebLogin(publish,DATA);
 historyStore=new HistoryStore(join(DATA,'history-v1'));auxiliary=new Auxiliary(id=>credentials(id,keys,sources.codex),(id,kind,c,signal)=>queryActivity(id,kind,c,signal,net.fetch as typeof fetch),historyStore,publish);
 scheduler=new Scheduler(async(id,signal)=>{if(id==='codex'||id==='glm'){const c=await credentials(id,keys,sources.codex);if(signal.aborted)throw new SafeError('unconfigured');auxiliary.observeScope(id,c.scope);auxiliary.setNoticeScope(id,c.noticeScope);const result=await requestQuota(id,c.key,signal,net.fetch as typeof fetch,c.account);if(!signal.aborted)quotaScopes[id]=c.noticeScope??c.scope;return result;}const key=await keys.readForRequest(id),result=await requestQuota(id,key,signal,net.fetch as typeof fetch);if(!signal.aborted)quotaScopes[id]=accountScope('notice:'+id,key);return result;},()=>{publish();observeLowQuota();});
 session.defaultSession.setPermissionRequestHandler((_w,_p,callback)=>callback(false));session.defaultSession.setPermissionCheckHandler(()=>false);
 window=new BrowserWindow({width:480,height:780,minWidth:390,minHeight:560,show:false,frame:false,skipTaskbar:true,resizable:true,backgroundColor:config.theme==='night'?'#29231f':'#f6f0e5',webPreferences:{preload:join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,devTools:false}});
 window.setAlwaysOnTop(config.pinned);window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',e=>e.preventDefault());window.webContents.on('will-attach-webview',e=>e.preventDefault());
 window.on('blur',()=>{if(!config.pinned)window.hide();});window.on('close',e=>{if(!quitting){e.preventDefault();window.hide();}});
 const pixels=Buffer.alloc(32*32*4);for(let y=0;y<32;y++)for(let x=0;x<32;x++){const i=(y*32+x)*4,bar=x>=6&&x<26&&y>=(x<12?18:x<20?12:6)&&y<27;pixels[i]=bar?39:229;pixels[i+1]=bar?72:240;pixels[i+2]=bar?173:246;pixels[i+3]=255;}
 tray=new Tray(nativeImage.createFromBitmap(pixels,{width:32,height:32}));void startupLog.record('tray-created');tray.setToolTip('额度 · 专注');tray.on('click',toggle);tray.setContextMenu(Menu.buildFromTemplate([{label:'显示 / 隐藏',click:toggle},{label:'刷新全部',click:()=>{scheduler.all();auxiliary.all();{health?.start();webLogin?.refresh("deepseek");webLogin?.refresh("opencode");void refreshLocal();}}},{label:'设置',click:()=>{show();window.webContents.send('quota:update',{...publicState(),openSettings:true});}},{type:'separator'},{label:'退出',click:()=>app.quit()}]));
 reconcileAutostart();
 register('quota:state',()=>publicState());register('quota:refresh',async(id:unknown)=>{if(id==='all'){scheduler.all();auxiliary.all();{health?.start();webLogin?.refresh("deepseek");webLogin?.refresh("opencode");void refreshLocal();}}else {const p=provider(id);if(isWebProvider(p))webLogin.refresh(p);void scheduler.refresh(p);void auxiliary.refresh(p);if((p==="codex"||p==="deepseek"))void health.refresh(p);if(p==="kimi"||p==="minimax")void refreshLocal();}});
 register('quota:web-login',async(id:unknown)=>{if(!isWebProvider(id))throw new SafeError('schema');await webLogin.open(id);});register('quota:web-logout',async(id:unknown)=>{if(!isWebProvider(id))throw new SafeError('schema');await webLogin.logout(id);});
 register('quota:notification-test',async()=>{if(!notificationAllowed()||notificationTestBusy)return 'blocked';notificationTestBusy=true;try{return await sendNotification({key:'test',expires:Date.now()+60000,title:'额度监控台 · 测试通知',body:'这是一条额度提醒测试通知。'});}finally{notificationTestBusy=false;}});
 register('quota:source-pick',async(id:unknown)=>{if(!SOURCE_IDS.includes(id as SourceId))throw new SafeError('schema');const result=await dialog.showOpenDialog(window,{title:'选择只读数据来源',properties:id==='kimi'?['openDirectory']:['openFile'],defaultPath:sources[id as SourceId].path});return result.canceled?null:result.filePaths[0];});
 register('quota:sources',(input:unknown)=>{if(quitting)throw new SafeError('storage');let next:Sources;try{next=parseSources(input);}catch{throw new SafeError('schema');}const work=settingsChain.then(async()=>{
  await atomicWrite(join(DATA,'sources.json'),JSON.stringify(next));const changed=JSON.stringify(sources.codex)!==JSON.stringify(next.codex);sources=next;
  localGeneration++;localAbort?.abort();localStats={};if(changed){delete quotaScopes.codex;scheduler.invalidate('codex');auxiliary.invalidate('codex');void scheduler.refresh('codex');void auxiliary.refresh('codex');}publish();void refreshLocal();
 });settingsChain=work.catch(()=>{});return work;});
 register('quota:data-pick',async()=>{
  if(config.launchAtLogin)return {status:'autostart-enabled'};
  const chosen=await dialog.showOpenDialog(window,{title:'选择独立数据目录',properties:['openDirectory','createDirectory']});if(chosen.canceled)return {status:'cancelled'};
  const confirmation=await dialog.showMessageBox(window,{type:'question',buttons:['取消','下次使用此目录'],defaultId:0,cancelId:0,title:'切换数据位置',message:'下次手动启动将使用此位置的独立配置。',detail:'旧数据保留，不自动搬迁账号、登录和历史。请退出后从程序文件重新打开。'});if(confirmation.response!==1)return {status:'cancelled'};
  if(quitting)return {status:'cancelled'};
  const work=settingsChain.then(async()=>{if(quitting)return {status:'cancelled'};if(config.launchAtLogin)return {status:'autostart-enabled'};try{const selected=prepareProfile(appDirectory,bundleRoot,['--data-dir',chosen.filePaths[0]],sid);await atomicWrite(selectionFile(bundleRoot,sid),JSON.stringify({schema:1,dataRoot:selected.dataRoot}));dataSwitchPending=true;return {status:'saved',path:selected.dataRoot};}catch{throw new SafeError('storage');}});settingsChain=work.catch(()=>{});return work;
 });
 register('quota:settings',(input:unknown)=>{
  if(quitting)throw new SafeError('autostart');
  const next=settings(input),explicitLoginChange=(input as {autostartExplicit?:unknown}).autostartExplicit===true;
  const operation=settingsChain.then(async()=>{
   // An unrelated form save must not undo a system disable discovered during startup reconciliation.
   if(!explicitLoginChange)next.launchAtLogin=config.launchAtLogin;
   if(next.launchAtLogin&&dataSwitchPending)throw new SafeError('autostart');
   if(next.launchAtLogin!==config.launchAtLogin&&!canManageAutostart)throw new SafeError('autostart');
   await commitPreferences(config,next,s=>atomicWrite(join(DATA,'settings.json'),JSON.stringify(s)),enabled=>autostart.setEnabled(enabled),true);
   config=next;window.setAlwaysOnTop(config.pinned);scheduler.configure(config);auxiliary.configure(config);publish();
  });settingsChain=operation.catch(()=>{});return operation;
 });
 register('quota:key-save',async(id:unknown,value:unknown)=>{const p=provider(id);if(p==='codex')throw new SafeError('schema');await keys.save(p,value);presence[p]=true;scheduler.invalidate(p);auxiliary.invalidate(p);void scheduler.refresh(p);void auxiliary.refresh(p);});
 register('quota:key-remove',async(id:unknown)=>{const p=provider(id);if(p==='codex')throw new SafeError('schema');await keys.remove(p);presence[p]=false;scheduler.invalidate(p);auxiliary.invalidate(p);void scheduler.refresh(p);void auxiliary.refresh(p);});register('quota:hide',()=>window.hide());
 await window.loadURL(uiUrl);void startupLog.record('window-loaded');scheduler.configure(config);auxiliary.configure(config);void historyStore.prune().then(publish).catch(()=>{});await webLogin.initialize();
 powerMonitor.on('resume',()=>{scheduler.all();auxiliary.all();{health?.start();webLogin?.refresh("deepseek");webLogin?.refresh("opencode");void refreshLocal();}});
 scheduler.all();auxiliary.all();health.start();webLogin.start();void refreshLocal();localTimer=setInterval(()=>void refreshLocal(),900000);if(!process.argv.includes('--hidden')||profile.firstRun){show();if(profile.firstRun)window.webContents.send('quota:update',{...publicState(),openSettings:true});}

 }).catch(async()=>{await startupLog.record('startup-failed');dialog.showErrorBox('应用启动未完成','请检查当前数据目录中的配置、写入权限及 Windows 加密服务。原数据已保留，没有切换或重建配置。');app.exit(1);});
}
