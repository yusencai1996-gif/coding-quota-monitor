import {safeCode,SafeError} from './model';
import type {OpenCodeOAuthSnapshot} from './opencode-oauth';
import type {McpTool,McpToolResult} from './opencode-mcp';
import {OpenCodeAccessError} from './opencode-mcp';
import {parseOpenCodeUsage,parseOpenCodeContext,type OpenCodeUsageSummary,type OpenCodeUsageRange} from './opencode-usage';
import type {TokenHistory} from './activity-model';

export interface OpenCodeConnectionState {status:string;coverage:string;usage?:OpenCodeUsageSummary;history?:TokenHistory;historyStatus?:string}
interface Authorization {
 has():Promise<boolean>;begin():Promise<void>;logout():Promise<void>;close():Promise<void>;
 snapshot():OpenCodeOAuthSnapshot;
}
interface ConsoleClient {listTools():Promise<McpTool[]>;callReadTool(name:string,args:Record<string,unknown>):Promise<McpToolResult>;close():void}
const coverage='在默认浏览器授权；本应用不读取浏览器 Cookie';

/** Authorization is not proof that token history is available. Never publish synthetic usage. */
export class OpenCodeConnection {
 private epoch=0;
 private closed=false;
 private work?:Promise<void>;
 private interactive=false;
 private client?:ConsoleClient;
 private tools:McpTool[]=[];
 private summary?:OpenCodeUsageSummary;
 private timer?:ReturnType<typeof setTimeout>;
 private history?:TokenHistory;
 private historyStatus='idle';
 private historyVersion=0;
 private dailyAbort?:AbortController;
 private scope='';
 private status='not-connected';private detail=coverage;
 constructor(private auth:Authorization,private makeClient:()=>ConsoleClient,private publish:(state:OpenCodeConnectionState)=>void,private readDaily?:(orgId:string,userId:string,signal:AbortSignal)=>Promise<TokenHistory>){}
 private update(status:string,detail=coverage){this.status=status;this.detail=detail;if(!this.closed)this.publish({status,coverage:detail,usage:this.summary,history:this.history,historyStatus:this.historyStatus});}
 authorizationChanged(){if(this.auth.snapshot().status==='pending')this.update('browser-pending');}
 open(interactive=true):Promise<void>{
  if(this.closed)return Promise.resolve();
  if(this.work){this.interactive ||= interactive;return this.work;}
  clearTimeout(this.timer);
  this.interactive=interactive;
  const epoch=this.epoch;
  let shouldRetry=false;
  const valid=()=>!this.closed&&epoch===this.epoch;
  const work=(async()=>{
   try{
    this.update('checking-login');
    const saved=await this.auth.has();if(!valid())return;shouldRetry=saved;
    if(!saved){this.summary=undefined;this.history=undefined;this.historyStatus='idle';if(!this.interactive){this.update('login-required');return;}await this.auth.begin();if(!valid())return;shouldRetry=true;}
    const discover=async()=>{this.update('reading');this.client?.close();const client=this.makeClient();this.client=client;return client.listTools();};
    let tools:McpTool[];
    try{tools=await discover();}catch(error){
     if(!valid()||!this.interactive||!saved||error instanceof OpenCodeAccessError||safeCode(error)!=='auth')throw error;
     this.summary=undefined;this.history=undefined;this.historyStatus='idle';this.scope='';
     await this.auth.begin();if(!valid())return;tools=await discover();
    }
    if(!valid())return;
    this.tools=tools;
    if(!tools.some(tool=>tool.name==='get_usage'))throw new SafeError('schema');
    const periods:OpenCodeUsageSummary['periods']=[];let userId:string|undefined;
    for(const range of ['24h','7d','30d','all'] as const satisfies readonly OpenCodeUsageRange[]){
     const result=parseOpenCodeUsage(await this.client!.callReadTool('get_usage',{range}),range);
     if(!valid())return;
     if(userId!==undefined&&userId!==result.userId){this.summary=undefined;this.history=undefined;throw new SafeError('schema');}
     userId=result.userId;periods.push(result.period);
    }
    let context:{orgId:string;userId:string}|undefined;
    if(this.readDaily){
     if(!tools.some(tool=>tool.name==='get_context'))throw new SafeError('schema');
     context=parseOpenCodeContext(await this.client!.callReadTool('get_context',{}));if(!valid())return;
     if(context.userId!==userId){this.summary=undefined;this.history=undefined;throw new SafeError('schema');}
     const scope=JSON.stringify([context.orgId,context.userId]);if(this.scope!==scope){this.history=undefined;this.scope=scope;}
    }
    this.summary={periods,updatedAt:Date.now()};
    this.update('connected','官方本人用量；套餐剩余额度单独查询。');
    if(this.readDaily&&context){
     const historyVersion=this.historyVersion,controller=new AbortController();this.dailyAbort=controller;const deadline=setTimeout(()=>controller.abort(),30000);
     this.historyStatus='reading';this.update('connected',this.detail);
     try{const history=await this.readDaily(context.orgId,context.userId,controller.signal);if(!valid()||historyVersion!==this.historyVersion)return;this.history=history;this.historyStatus='ok';}
     catch(error){if(!valid()||historyVersion!==this.historyVersion)return;this.historyStatus=safeCode(error);if(['auth','unconfigured','schema'].includes(this.historyStatus))this.history=undefined;}
     finally{clearTimeout(deadline);if(this.dailyAbort===controller)this.dailyAbort=undefined;}
     if(valid())this.update('connected',this.detail);
    }
   }catch(error){if(valid()){
    if(error instanceof OpenCodeAccessError){this.summary=undefined;this.history=undefined;this.update(error.reason,error.reason==='mcp-disabled'?'请在 OpenCode 官网 Integrations → Console MCP 中启用，然后刷新此平台':'官方拒绝当前工作区的访问，请检查工作区设置及授权角色');}
    else{if(safeCode(error)==='auth'){this.summary=undefined;this.history=undefined;}this.update(safeCode(error)==='auth'?'login-required':safeCode(error));}
   }}
  })();
  this.work=work;
  void work.finally(()=>{if(this.work===work){this.work=undefined;if(valid()&&shouldRetry){this.timer=setTimeout(()=>void this.open(false),900000);this.timer.unref();}}});
  return work;
 }
 // Main-process diagnostics only; never send tool schemas or account identifiers over renderer IPC.
 toolContracts():readonly McpTool[]{return this.tools;}
 invalidateDaily(){
  const version=++this.historyVersion,epoch=this.epoch;this.dailyAbort?.abort();this.history=undefined;this.historyStatus='idle';this.update(this.status,this.detail);
  void Promise.resolve(this.work).then(()=>{if(!this.closed&&this.epoch===epoch&&this.historyVersion===version)void this.open(false);});
 }
 async logout(){
  const epoch=++this.epoch;clearTimeout(this.timer);this.dailyAbort?.abort();this.work=undefined;this.client?.close();this.client=undefined;this.tools=[];this.summary=undefined;this.history=undefined;this.historyStatus='idle';this.scope='';this.update('disconnecting');
  try{await this.auth.logout();if(this.epoch===epoch)this.update('not-connected');}
  catch(error){if(this.epoch===epoch)this.update('storage','授权清除失败，请重试断开连接');throw error;}
 }
 async close(){this.closed=true;this.epoch++;clearTimeout(this.timer);this.dailyAbort?.abort();this.client?.close();this.tools=[];this.summary=undefined;this.history=undefined;await this.auth.close();}
}
