import {SafeError} from './model';

export const OPENCODE_MCP_ENDPOINT='https://opencode.ai/console/mcp';
export const OPENCODE_MCP_VERSION='2025-03-26';
const MAX_BYTES=2*1024*1024;
type JsonObject=Record<string,unknown>;
export interface McpTool extends JsonObject {name:string;inputSchema:JsonObject;description?:string}
export interface McpToolResult extends JsonObject {content?:unknown[];structuredContent?:JsonObject;isError?:boolean}
export interface OpenCodeMcpOptions {allowedReadTools?:readonly string[];timeoutMs?:number;maxPages?:number;maxTools?:number}
export class OpenCodeAccessError extends SafeError {
  constructor(public readonly reason:'mcp-disabled'|'forbidden'){super('auth');}
}
class SessionLost extends Error {}
const object=(value:unknown):value is JsonObject=>!!value&&typeof value==='object'&&!Array.isArray(value);
const boundedInteger=(value:number|undefined,fallback:number,max:number)=>{
  const n=value??fallback;if(!Number.isInteger(n)||n<1||n>max)throw new SafeError('schema');return n;
};

// Main-process transport only. Tool descriptions/annotations never grant permission to call a tool.
export class OpenCodeMcp {
  private session?:string;
  private ready=false;
  private closed=false;
  private sequence=0;
  private chain:Promise<unknown>=Promise.resolve();
  private pending=new Set<AbortController>();
  private allowed:Set<string>;
  private timeout:number;
  private pages:number;
  private toolLimit:number;
  constructor(private fetcher:typeof fetch,private token:()=>Promise<string>,options:OpenCodeMcpOptions={}) {
    this.allowed=new Set(options.allowedReadTools??[]);
    if([...this.allowed].some(name=>!this.validName(name)))throw new SafeError('schema');
    this.timeout=boundedInteger(options.timeoutMs,30000,120000);
    this.pages=boundedInteger(options.maxPages,20,100);
    this.toolLimit=boundedInteger(options.maxTools,1000,10000);
  }
  private validName(name:unknown):name is string{return typeof name==='string'&&name.length>0&&name.length<=256&&!/[\r\n\0]/.test(name);}
  private serial<T>(work:()=>Promise<T>):Promise<T>{
    const run=this.chain.then(()=>{if(this.closed)throw new SafeError('timeout');return work();});
    this.chain=run.catch(()=>{});return run;
  }
  initialize():Promise<void>{return this.serial(()=>this.ensureInitialized());}
  private async ensureInitialized():Promise<void>{
    if(this.ready)return;
    try {
      const result=await this.request('initialize',{protocolVersion:OPENCODE_MCP_VERSION,capabilities:{},clientInfo:{name:'coding-quota-monitor',version:'1.3.0'}});
      if(!object(result)||result.protocolVersion!==OPENCODE_MCP_VERSION||!object(result.capabilities)||!object(result.serverInfo))throw new SafeError('schema');
      await this.request('notifications/initialized',{},true);
      this.ready=true;
    } catch(error) {
      this.ready=false;this.session=undefined;
      throw error instanceof SafeError?error:new SafeError('network');
    }
  }
  private async read<T>(work:()=>Promise<T>):Promise<T>{
    await this.ensureInitialized();
    try{return await work();}
    catch(error){
      if(!(error instanceof SessionLost))throw error;
      this.ready=false;this.session=undefined;
      await this.ensureInitialized();
      try{return await work();}catch(retry){throw retry instanceof SafeError?retry:new SafeError('network');}
    }
  }
  listTools():Promise<McpTool[]>{
    return this.serial(()=>this.read(async()=>{
      const tools:McpTool[]=[],names=new Set<string>(),cursors=new Set<string>();let cursor:string|undefined;
      for(let page=0;page<this.pages;page++){
        const result=await this.request('tools/list',cursor?{cursor}:{});
        if(!object(result)||!Array.isArray(result.tools)||tools.length+result.tools.length>this.toolLimit)throw new SafeError('schema');
        for(const tool of result.tools){
          if(!object(tool)||!this.validName(tool.name)||!object(tool.inputSchema)||names.has(tool.name)||(tool.description!==undefined&&typeof tool.description!=='string'))throw new SafeError('schema');
          names.add(tool.name);tools.push(tool as McpTool);
        }
        if(result.nextCursor===undefined)return tools;
        if(typeof result.nextCursor!=='string'||!result.nextCursor||result.nextCursor.length>2048||cursors.has(result.nextCursor))throw new SafeError('schema');
        cursor=result.nextCursor;cursors.add(cursor);
      }
      throw new SafeError('schema');
    }));
  }
  callReadTool(name:string,args:JsonObject={}):Promise<McpToolResult>{
    // A fetched tools/list schema is data, not authorization. The integration must opt into known read operations.
    if(!this.allowed.has(name)||!object(args))return Promise.reject(new SafeError('schema'));
    return this.serial(()=>this.read(async()=>{
      const result=await this.request('tools/call',{name,arguments:args});
      if(!object(result)||result.isError===true||(result.isError!==undefined&&typeof result.isError!=='boolean')||
        (result.content!==undefined&&!Array.isArray(result.content))||(result.structuredContent!==undefined&&!object(result.structuredContent))||
        (result.content===undefined&&result.structuredContent===undefined))throw new SafeError('schema');
      return result as McpToolResult;
    }));
  }
  close():void {
    this.closed=true;this.ready=false;this.session=undefined;
    for(const controller of this.pending)controller.abort();
    this.pending.clear();
  }
  private async request(method:string,params:JsonObject,notification=false):Promise<unknown>{
    if(this.closed)throw new SafeError('timeout');
    const controller=new AbortController();this.pending.add(controller);
    let timer:ReturnType<typeof setTimeout>|undefined;
    let onAbort:(()=>void)|undefined;
    const aborted=new Promise<never>((_,reject)=>{
      onAbort=()=>reject(new SafeError('timeout'));
      controller.signal.addEventListener('abort',onAbort,{once:true});
      timer=setTimeout(()=>controller.abort(),this.timeout);
    });
    const work=async()=>{
      const token=await this.token();
      if(controller.signal.aborted||this.closed)throw new SafeError('timeout');
      if(typeof token!=='string'||!token||token.length>16384||/[\r\n\0]/.test(token))throw new SafeError('auth');
      const id=notification?undefined:++this.sequence;
      let body:string;
      try{body=JSON.stringify({jsonrpc:'2.0',...(id===undefined?{}:{id}),method,params});}catch{throw new SafeError('schema');}
      if(Buffer.byteLength(body)>MAX_BYTES)throw new SafeError('schema');
      const headers:Record<string,string>={Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'};
      if(method!=='initialize')headers['MCP-Protocol-Version']=OPENCODE_MCP_VERSION;
      if(this.session)headers['Mcp-Session-Id']=this.session;
      const response=await this.fetcher(OPENCODE_MCP_ENDPOINT,{method:'POST',headers,body,signal:controller.signal,credentials:'omit',redirect:'error'});
      if(controller.signal.aborted||this.closed){void response.body?.cancel().catch(()=>{});throw new SafeError('timeout');}
      if(!response.ok){
        if(response.status===403){
          const reason=await this.forbiddenReason(response,controller.signal);
          if(controller.signal.aborted||this.closed)throw new SafeError('timeout');
          throw new OpenCodeAccessError(reason);
        }
        void response.body?.cancel().catch(()=>{});
        if(response.status===401){this.ready=false;this.session=undefined;throw new SafeError('auth');}
        if(response.status===404&&this.session)throw new SessionLost();
        throw new SafeError(response.status===429?'rateLimit':'network');
      }
      const session=response.headers.get('Mcp-Session-Id');
      if(session!==null){if(!/^[\x21-\x7e]{1,256}$/.test(session)){void response.body?.cancel().catch(()=>{});throw new SafeError('schema');}this.session=session;}
      if(notification){void response.body?.cancel().catch(()=>{});return undefined;}
      const media=(response.headers.get('Content-Type')??'').split(';')[0].trim().toLowerCase();
      if(!['application/json','text/event-stream','application/event-stream'].includes(media)){void response.body?.cancel().catch(()=>{});throw new SafeError('schema');}
      const length=response.headers.get('Content-Length');
      if(length!==null&&(/^\d+$/.test(length)?Number(length)>MAX_BYTES:true)){void response.body?.cancel().catch(()=>{});throw new SafeError('schema');}
      return this.readResponse(response,media,id!,controller.signal);
    };
    try{return await Promise.race([work(),aborted]);}
    catch(error){if(error instanceof SessionLost)throw error;throw error instanceof SafeError?error:new SafeError(controller.signal.aborted?'timeout':'network');}
    finally{if(timer)clearTimeout(timer);if(onAbort)controller.signal.removeEventListener('abort',onAbort);this.pending.delete(controller);}
  }
  private async forbiddenReason(response:Response,signal:AbortSignal):Promise<'mcp-disabled'|'forbidden'>{
    const reader=response.body?.getReader();if(!reader)return 'forbidden';
    const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
    try{
      let text='',bytes=0;const decoder=new TextDecoder();
      while(true){if(signal.aborted)throw new SafeError('timeout');const part=await reader.read();if(signal.aborted)throw new SafeError('timeout');if(part.done)break;bytes+=part.value.byteLength;if(bytes>4096)return 'forbidden';text+=decoder.decode(part.value,{stream:true});}
      const data=JSON.parse(text+decoder.decode());
      return data?.error==='forbidden'&&data?.message==='The Console MCP is not enabled for this workspace.'?'mcp-disabled':'forbidden';
    }catch(error){if(signal.aborted)throw new SafeError('timeout');return 'forbidden';}
    finally{signal.removeEventListener('abort',abort);void reader.cancel().catch(()=>{});reader.releaseLock();}
  }
  private async readResponse(response:Response,media:string,id:number,signal:AbortSignal):Promise<unknown>{
    const reader=response.body?.getReader();if(!reader)throw new SafeError('schema');
    let bytes=0,text='',eventData:string[]=[];
    const decoder=new TextDecoder('utf-8',{fatal:true});
    const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
    const parse=(raw:string):JsonObject=>{try{const value:unknown=JSON.parse(raw);if(object(value))return value;}catch{}throw new SafeError('schema');};
    const result=(message:JsonObject)=>{
      if(message.jsonrpc!=='2.0'||message.id!==id||('error'in message)||!('result'in message))throw new SafeError('schema');
      return message.result;
    };
    const event=(line:string):JsonObject|undefined=>{
      if(line===''){
        if(!eventData.length)return;
        const raw=eventData.join('\n');eventData=[];
        const message=parse(raw);
        if(message.jsonrpc!=='2.0')throw new SafeError('schema');
        if(message.id===id)return message;
      }else if(line==='data'||line.startsWith('data:'))eventData.push(line==='data'?'':line.slice(5).replace(/^ /,''));
    };
    const events=(end=false):JsonObject|undefined=>{
      let newline:number;
      while((newline=text.search(/[\r\n]/))!==-1){
        // Keep a trailing CR until the next chunk so CRLF is always one line ending.
        if(!end&&newline===text.length-1&&text[newline]==='\r')break;
        const width=text[newline]==='\r'&&text[newline+1]==='\n'?2:1;
        const line=text.slice(0,newline);text=text.slice(newline+width);
        const message=event(line);if(message)return message;
      }
    };
    try{
      while(true){
        if(signal.aborted)throw new SafeError('timeout');
        const chunk=await reader.read();
        if(signal.aborted)throw new SafeError('timeout');
        if(chunk.done){
          text+=decoder.decode();
          if(media==='application/json')return result(parse(text));
          const message=events(true);if(message)return result(message);
          // An SSE event is dispatched by a blank line, not by EOF.
          throw new SafeError('schema');
        }
        bytes+=chunk.value.byteLength;if(bytes>MAX_BYTES)throw new SafeError('schema');
        text+=decoder.decode(chunk.value,{stream:true});
        if(media!=='application/json'){
          const message=events();if(message)return result(message);
        }
      }
    }catch(error){throw error instanceof SafeError?error:new SafeError(signal.aborted?'timeout':'schema');}
    finally{signal.removeEventListener('abort',abort);void reader.cancel().catch(()=>{});reader.releaseLock();}
  }
}
