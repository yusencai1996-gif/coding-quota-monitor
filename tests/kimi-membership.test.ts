import{test}from'node:test';import assert from'node:assert/strict';
import{mkdtemp,readdir,unlink,rmdir}from'node:fs/promises';import{join}from'node:path';import{EventEmitter}from'node:events';
import{parse}from'../src/parsers';import{parseKimiMembership}from'../src/kimi-membership-data';import{KimiMembership,KIMI_LOGIN_HOME,KIMI_MEMBERSHIP_HOME}from'../src/kimi-membership';import{testPrefix}from'./test-paths';

test('Kimi modern API preserves month total, actual Code limits and missing weekly scope',()=>{
 const d=parse('kimi',{usage:{used:20,limit:100},usages:{limit_month_total:{used_ratio:0.4,reset_time:'2026-11-01T00:00:00Z'},limit_5h:{used_ratio:'0.0196'},limit_month_code:{used_ratio:0.25}}});
 assert.deepEqual(d.windows.map(w=>w.label),['会员月总额度','5 小时窗口']);assert.equal(d.windows[0].remaining,60);assert.ok(Math.abs(d.windows[1].remaining!-98.04)<1e-9);assert.equal(d.windows[0].resetAt,Date.parse('2026-11-01T00:00:00Z'));
 assert.throws(()=>parse('kimi',{usages:{limit_5h:{}}}));
});
test('Kimi monthly read ignores gift/booster pools and does not expose identity or raw response',()=>{
 const d=parseKimiMembership({subscriptionBalance:{type:'SUBSCRIPTION',id:'PRIVATE-ACCOUNT',amountUsedRatio:0.25,expireTime:'2026-11-01T00:00:00Z'},giftBalances:[{amountUsedRatio:1}],boosterWallets:[{balance:42}],user:'PRIVATE-ACCOUNT'});
 assert.deepEqual(d,{remaining:75,periodEndAt:Date.parse('2026-11-01T00:00:00Z')});assert.ok(!JSON.stringify(d).includes('PRIVATE-ACCOUNT'));
 for(const raw of [{giftBalances:[{}]},{subscriptionBalance:{}},{subscriptionBalance:{type:'GIFT',amountUsedRatio:0}},{subscriptionBalance:{amountUsedRatio:null}},{subscriptionBalance:{amountUsedRatio:'bad'}},{subscriptionBalance:{amountUsedRatio:-1}}])assert.throws(()=>parseKimiMembership(raw));
 assert.equal(parseKimiMembership({subscriptionBalance:{type:'SUBSCRIPTION',amount:'100',amountLeft:'100'}}).remaining,100);
 assert.throws(()=>parseKimiMembership({subscriptionBalance:{amount:'100',amountLeft:'90'}}));assert.throws(()=>parseKimiMembership({subscriptionBalance:{amount:'90071992547409930',amountLeft:'90071992547409929'}}));
 assert.equal(parseKimiMembership({subscriptionBalance:{amountUsedRatio:2}}).remaining,0);
 assert.equal(parseKimiMembership({subscriptionBalance:{amountUsedRatio:0,expireTime:'2026-11-01 00:00:00'}}).periodEndAt,null);
});

class FakeWindow extends EventEmitter{
 static last:FakeWindow;destroyed=false;shown=false;loads=0;url='about:blank';body='{}';bodyWait?:Promise<any>;
 webContents:any=new EventEmitter();constructor(options:any){super();FakeWindow.last=this;this.shown=options.show;Object.assign(this.webContents,{getURL:()=>this.url,setUserAgent(){},setWindowOpenHandler(){},debugger:Object.assign(new EventEmitter(),{attach(){},sendCommand:async(method:string)=>method==='Network.getResponseBody'?this.bodyWait??{body:this.body,base64Encoded:false}:{}})});}
 isDestroyed(){return this.destroyed;}isVisible(){return this.shown;}show(){this.shown=true;}focus(){}hide(){this.shown=false;}destroy(){this.destroyed=true;this.emit('closed');}async loadURL(url:string){this.loads++;this.url=url;this.webContents.emit('did-navigate',{},url);}
}
const url='https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats';
const turn=()=>new Promise(r=>setTimeout(r,10));
async function sandbox(work:(root:string)=>Promise<void>){const root=await mkdtemp(testPrefix('kimi-monthly-'));try{await work(root);}finally{for(const n of await readdir(root))await unlink(join(root,n));await rmdir(root);}}
test('Kimi monthly default never creates a session; late response after revoke stays cleared',async()=>sandbox(async root=>{
 let sessions=0,cleared=0;const ses:any=new EventEmitter();Object.assign(ses,{setPermissionRequestHandler(){},setPermissionCheckHandler(){},getUserAgent(){return'Browser';},flushStorageData(){},cookies:Object.assign(new EventEmitter(),{flushStore:async()=>{}}),clearStorageData:async()=>{cleared++;},clearCache:async()=>{}});
 const module=new KimiMembership(root,()=>{},{BrowserWindow:FakeWindow as any,session:{fromPartition(){sessions++;return ses;}}as any});
 await module.initialize();module.start();await turn();assert.equal(sessions,0);module.configure(false);await module.open();assert.equal(sessions,0);assert.equal(module.state.status,'paused');module.configure(true);
 await module.open();const w=FakeWindow.last;assert.equal(sessions,1);
 const emit=(method:string,data:any)=>w.webContents.debugger.emit('message',{},method,data);
 w.body=JSON.stringify({subscriptionBalance:{amountUsedRatio:0.2}});
 emit('Network.requestWillBeSent',{requestId:'one',request:{url,headers:{Authorization:'SYNTHETIC'}}});emit('Network.responseReceived',{requestId:'one',response:{url,status:200}});emit('Network.loadingFinished',{requestId:'one',encodedDataLength:200});await turn();assert.equal(module.state.quota?.remaining,80);
 let release!:(v:any)=>void;w.bodyWait=new Promise(r=>release=r);
 emit('Network.requestWillBeSent',{requestId:'two',request:{url,headers:{Authorization:'SYNTHETIC'}}});emit('Network.responseReceived',{requestId:'two',response:{url,status:200}});emit('Network.loadingFinished',{requestId:'two',encodedDataLength:200});await turn();await module.logout();release({body:w.body,base64Encoded:false});await turn();assert.equal(module.state.status,'not-connected');assert.equal(module.state.quota,undefined);assert.equal(cleared,1);assert.ok(w.destroyed);await module.close();
}));
test('Kimi monthly ignores redirected quota responses and rejects auth failure immediately',async()=>sandbox(async root=>{
 const ses:any=new EventEmitter();Object.assign(ses,{setPermissionRequestHandler(){},setPermissionCheckHandler(){},getUserAgent(){return'Browser';},flushStorageData(){},cookies:Object.assign(new EventEmitter(),{flushStore:async()=>{}})});
 const module=new KimiMembership(root,()=>{},{BrowserWindow:FakeWindow as any,session:{fromPartition(){return ses;}}as any});await module.open();const w=FakeWindow.last;const emit=(m:string,p:any)=>w.webContents.debugger.emit('message',{},m,p);
 emit('Network.requestWillBeSent',{requestId:'r',request:{url,headers:{Authorization:'SYNTHETIC'}}});emit('Network.requestWillBeSent',{requestId:'r',request:{url:'https://other.example/GetSubscriptionStats'}});emit('Network.loadingFinished',{requestId:'r',encodedDataLength:10});await turn();assert.equal(module.state.quota,undefined);
 emit('Network.requestWillBeSent',{requestId:'a',request:{url,headers:{Authorization:'SYNTHETIC'}}});emit('Network.responseReceived',{requestId:'a',response:{url,status:401}});await turn();assert.equal(module.state.status,'login-required');await module.close();
}));

test('Kimi failures, cookie revoke and page changes fence old quota bodies; redirects are bounded',async()=>sandbox(async root=>{
 const cookies=Object.assign(new EventEmitter(),{flushStore:async()=>{}}),ses:any=new EventEmitter();Object.assign(ses,{setPermissionRequestHandler(){},setPermissionCheckHandler(){},getUserAgent(){return'Browser';},flushStorageData(){},cookies});
 const module=new KimiMembership(root,()=>{},{BrowserWindow:FakeWindow as any,session:{fromPartition(){return ses;}}as any});await module.open();const w=FakeWindow.last;const emit=(m:string,p:any)=>w.webContents.debugger.emit('message',{},m,p);
 let id=0;async function success(){w.bodyWait=undefined;w.body=JSON.stringify({subscriptionBalance:{amountUsedRatio:0.95}});const r=String(++id);emit('Network.requestWillBeSent',{requestId:r,request:{url,headers:{Authorization:'SYNTHETIC'}}});emit('Network.responseReceived',{requestId:r,response:{url,status:200}});emit('Network.loadingFinished',{requestId:r,encodedDataLength:100});await turn();assert.ok(Math.abs(module.state.quota!.remaining-5)<1e-9);}
 for(const fail of [()=>w.webContents.emit('did-fail-load',{},-2,'','',true),()=>w.webContents.emit('did-start-navigation',{},'https://www.kimi.com/',true,true),()=>cookies.emit('changed',{}, {domain:'.kimi.com'},'explicit',true),()=>emit('Network.loadingFailed',{requestId:'failure'})]){
  await success();let release!:(v:any)=>void;w.bodyWait=new Promise(r=>release=r);emit('Network.requestWillBeSent',{requestId:'late',request:{url,headers:{Authorization:'SYNTHETIC'}}});emit('Network.responseReceived',{requestId:'late',response:{url,status:200}});emit('Network.loadingFinished',{requestId:'late',encodedDataLength:100});emit('Network.requestWillBeSent',{requestId:'failure',request:{url,headers:{Authorization:'SYNTHETIC'}}});fail();release({body:w.body,base64Encoded:false});await turn();assert.equal(module.state.quota,undefined);assert.notEqual(module.state.status,'connected');
 }
 await success();cookies.emit('changed',{}, {domain:'.kimi.com'},'overwrite',true);assert.equal(module.state.status,'connected');cookies.emit('changed',{}, {domain:'other.example'},'explicit',true);assert.equal(module.state.status,'connected');
 emit('Network.requestWillBeSent',{requestId:'redirect',request:{url,headers:{Authorization:'SYNTHETIC'}}});emit('Network.requestWillBeSent',{requestId:'redirect',request:{url:'https://other.example/'}});assert.equal(module.state.quota,undefined);
 let rejectOld!:(e:Error)=>void;w.bodyWait=new Promise((_r,j)=>rejectOld=j);emit('Network.requestWillBeSent',{requestId:'old-rejection',request:{url,headers:{Authorization:'SYNTHETIC'}}});emit('Network.responseReceived',{requestId:'old-rejection',response:{url,status:200}});emit('Network.loadingFinished',{requestId:'old-rejection',encodedDataLength:100});w.webContents.emit('did-start-navigation',{},'https://www.kimi.com/',false,true);await success();rejectOld(Error('synthetic stale body'));await turn();assert.equal(module.state.status,'connected');assert.ok(Math.abs(module.state.quota!.remaining-5)<1e-9);
 const child=new FakeWindow({show:true});w.webContents.emit('did-create-window',child);for(const win of [w,child]){let blocked=false;win.webContents.emit('will-redirect',{preventDefault(){blocked=true;}},'https://outside.example/');assert.equal(blocked,true);blocked=false;win.webContents.emit('will-redirect',{preventDefault(){blocked=true;}},'https://accounts.google.com/');assert.equal(blocked,false);}
 await module.close();assert.equal(cookies.listenerCount('changed'),0);
}));

test('Kimi opens official standalone login and reads quota after its return without assuming login success',async()=>sandbox(async root=>{
 const cookies=Object.assign(new EventEmitter(),{flushStore:async()=>{}}),ses:any=new EventEmitter();Object.assign(ses,{setPermissionRequestHandler(){},setPermissionCheckHandler(){},getUserAgent(){return'Browser';},flushStorageData(){},cookies});
 const module=new KimiMembership(root,()=>{},{BrowserWindow:FakeWindow as any,session:{fromPartition(){return ses;}}as any});await module.open();const w=FakeWindow.last;
 assert.equal(w.url,KIMI_LOGIN_HOME);const loads=w.loads;await module.open();assert.equal(w.loads,loads,'reopening must preserve the active login form');
 w.webContents.emit('did-navigate-in-page',{},'https://www.kimi.com/',false);assert.equal(w.url,KIMI_LOGIN_HOME,'ignore iframe navigation');
 w.webContents.emit('did-navigate-in-page',{},'https://www.kimi.com/',true);assert.equal(w.url,KIMI_MEMBERSHIP_HOME);assert.notEqual(module.state.status,'connected');assert.equal(module.state.quota,undefined);
 await module.close();
}));

test('Kimi silent refresh retires the page after quota capture without deleting login or losing quota',async()=>sandbox(async root=>{
 let cleared=0;const ses:any=Object.assign(new EventEmitter(),{setPermissionRequestHandler(){},setPermissionCheckHandler(){},getUserAgent(){return'Browser';},flushStorageData(){},cookies:Object.assign(new EventEmitter(),{flushStore:async()=>{}}),clearStorageData:async()=>{cleared++;}});
 const module=new KimiMembership(root,()=>{},{BrowserWindow:FakeWindow as any,session:{fromPartition(){return ses;}}as any});try{await module.open(false);const win=FakeWindow.last;const emit=(method:string,data:any)=>win.webContents.debugger.emit('message',{},method,data);win.body=JSON.stringify({subscriptionBalance:{id:'SYNTHETIC',amountUsedRatio:0.2}});emit('Network.requestWillBeSent',{requestId:'quota',request:{url,headers:{Authorization:'SYNTHETIC'}}});emit('Network.responseReceived',{requestId:'quota',response:{url,status:200}});emit('Network.loadingFinished',{requestId:'quota',encodedDataLength:100});await turn();assert.equal(win.destroyed,true);assert.equal(module.state.status,'connected');assert.equal(module.state.quota?.remaining,80);assert.equal(cleared,0);assert.ok(module.noticeScope());module.configure(false);module.refresh();await turn();assert.equal(FakeWindow.last,win);assert.equal(module.state.status,'paused');}finally{await module.close();}
}));

test('Kimi repeated page recycling retains one session download listener and removes it on close',async()=>sandbox(async root=>{
 const ses:any=Object.assign(new EventEmitter(),{setPermissionRequestHandler(){},setPermissionCheckHandler(){},getUserAgent(){return'Browser';},flushStorageData(){},cookies:Object.assign(new EventEmitter(),{flushStore:async()=>{}})});const module=new KimiMembership(root,()=>{},{BrowserWindow:FakeWindow as any,session:{fromPartition(){return ses;}}as any});
 try{for(let i=0;i<12;i++){await module.open(false);const win=FakeWindow.last;win.body=JSON.stringify({subscriptionBalance:{amountUsedRatio:0.2}});const emit=(m:string,p:any)=>win.webContents.debugger.emit('message',{},m,p);emit('Network.requestWillBeSent',{requestId:'r',request:{url,headers:{Authorization:'SYNTHETIC'}}});emit('Network.responseReceived',{requestId:'r',response:{url,status:200}});emit('Network.loadingFinished',{requestId:'r',encodedDataLength:100});await turn();assert.equal(win.destroyed,true);assert.equal(ses.listenerCount('will-download'),1);}}finally{await module.close();}assert.equal(ses.listenerCount('will-download'),0);assert.equal(ses.cookies.listenerCount('changed'),0);
}));
