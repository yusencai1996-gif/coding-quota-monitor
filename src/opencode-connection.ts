import {safeCode} from './model';
import type {OpenCodeOAuthSnapshot} from './opencode-oauth';
import type {McpTool} from './opencode-mcp';

export interface OpenCodeConnectionState {status:string;coverage:string}
interface Authorization {
 has():Promise<boolean>;begin():Promise<void>;logout():Promise<void>;close():Promise<void>;
 snapshot():OpenCodeOAuthSnapshot;
}
interface ConsoleClient {listTools():Promise<McpTool[]>;close():void}
const coverage='在默认浏览器授权；本应用不读取浏览器 Cookie';

/** Authorization is not proof that token history is available. Never publish synthetic usage. */
export class OpenCodeConnection {
 private epoch=0;
 private closed=false;
 private work?:Promise<void>;
 private interactive=false;
 private client?:ConsoleClient;
 private tools:McpTool[]=[];
 constructor(private auth:Authorization,private makeClient:()=>ConsoleClient,private publish:(state:OpenCodeConnectionState)=>void){}
 private update(status:string,detail=coverage){if(!this.closed)this.publish({status,coverage:detail});}
 authorizationChanged(){if(this.auth.snapshot().status==='pending')this.update('browser-pending');}
 open(interactive=true):Promise<void>{
  if(this.closed)return Promise.resolve();
  if(this.work){this.interactive ||= interactive;return this.work;}
  this.interactive=interactive;
  const epoch=this.epoch;
  const valid=()=>!this.closed&&epoch===this.epoch;
  const work=(async()=>{
   try{
    this.update('checking-login');
    const saved=await this.auth.has();if(!valid())return;
    if(!saved){if(!this.interactive){this.update('login-required');return;}await this.auth.begin();if(!valid())return;}
    const discover=async()=>{this.update('reading');this.client?.close();const client=this.makeClient();this.client=client;return client.listTools();};
    let tools:McpTool[];
    try{tools=await discover();}catch(error){
     if(!valid()||!this.interactive||!saved||safeCode(error)!=='auth')throw error;
     await this.auth.begin();if(!valid())return;tools=await discover();
    }
    if(!valid())return;
    this.tools=tools;
    // Real account tool contracts must be verified before enabling any usage tool.
    this.update('authorized-unverified','浏览器授权已连接；统计接口适配尚未完成，暂不显示用量');
   }catch(error){if(valid())this.update(safeCode(error)==='auth'?'login-required':safeCode(error));}
  })();
  this.work=work;
  void work.finally(()=>{if(this.work===work)this.work=undefined;});
  return work;
 }
 // Main-process diagnostics only; never send tool schemas or account identifiers over renderer IPC.
 toolContracts():readonly McpTool[]{return this.tools;}
 async logout(){
  const epoch=++this.epoch;this.work=undefined;this.client?.close();this.client=undefined;this.tools=[];this.update('disconnecting');
  try{await this.auth.logout();if(this.epoch===epoch)this.update('not-connected');}
  catch(error){if(this.epoch===epoch)this.update('storage','授权清除失败，请重试断开连接');throw error;}
 }
 async close(){this.closed=true;this.epoch++;this.client?.close();this.tools=[];await this.auth.close();}
}
