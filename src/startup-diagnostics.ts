import{appendFile,mkdir,stat,rename,readFile}from'node:fs/promises';import{join}from'node:path';
const STAGES=['process-start','ready','settings-loaded','settings-defaults','tray-created','window-loaded','autostart-ok','autostart-failed','duplicate-exit','duplicate-ignored','duplicate-shown','quitting','startup-failed']as const;
type Stage=typeof STAGES[number];
export class StartupDiagnostics {
 private chain:Promise<unknown>=Promise.resolve();
 constructor(private root:string,private version:string,private pid:number,private hidden:boolean){}
 record(stage:Stage){const data={schema:1,utc:new Date().toISOString(),stage,pid:this.pid,version:/^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:beta|rc)\.\d{1,4})?$/.test(this.version)?this.version:'unknown',hidden:this.hidden};const job=this.chain.then(async()=>{try{await mkdir(this.root,{recursive:true});const path=join(this.root,'startup-events.jsonl');const size=await stat(path).then(s=>s.size).catch(()=>0);if(size>256*1024)await rename(path,join(this.root,'startup-events.previous.jsonl')).catch(()=>{});await appendFile(path,JSON.stringify(data)+'\n',{mode:0o600});}catch{/* Diagnostic failure never prevents application startup. */}});this.chain=job;return job;}
 flush(){return this.chain;}
}
export async function readStartupDiagnostics(root:string){const text=await readFile(join(root,'startup-events.jsonl'),'utf8').catch(()=>'');return text.slice(-256*1024).split('\n').flatMap(line=>{try{const r=JSON.parse(line);if(r.schema!==1||!STAGES.includes(r.stage)||!Number.isSafeInteger(r.pid)||typeof r.utc!=='string'||!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(r.utc)||typeof r.hidden!=='boolean'||typeof r.version!=='string'||!/^(?:\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:beta|rc)\.\d{1,4})?|unknown)$/.test(r.version))return [];return [{schema:1,utc:r.utc,stage:r.stage,pid:r.pid,version:r.version,hidden:r.hidden}];}catch{return [];}}).slice(-200);}
