import{createHash,randomUUID}from'node:crypto';import{execFileSync}from'node:child_process';
import{existsSync,readFileSync,writeFileSync,mkdirSync,realpathSync,readdirSync,unlinkSync,lstatSync}from'node:fs';import{join,resolve,relative,isAbsolute,dirname,sep}from'node:path';
export const PRODUCT='quota-monitor-portable-v1';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export function windowsIdentity(){const system=process.env.SystemRoot;if(!system)throw Error('identity');const output=execFileSync(join(system,'System32','whoami.exe'),['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true,timeout:10000});const sid=output.match(/S-1-5-[0-9-]+/i)?.[0];if(!sid)throw Error('identity');return sid;}
export function canonical(path:string){return resolve(path).toLowerCase();}
export function selectionFile(bundleRoot:string,sid:string){return join(bundleRoot,'quota-location-'+hash(sid).slice(0,24)+'.json');}
function contained(parent:string,child:string){const r=relative(parent,child);return !r||(!r.startsWith('..'+sep)&&r!=='..'&&!isAbsolute(r));}
export function checkAncestors(path:string){let p=resolve(path);while(!existsSync(p)){const next=dirname(p);if(next===p)throw Error('data-missing');p=next;}if(lstatSync(p).isSymbolicLink()||canonical(realpathSync(p))!==canonical(p))throw Error('data-redirect');}
export interface Profile{dataRoot:string;directory:string;owner:string;id:string;taskName:string;appId:string;firstRun:boolean}
export function prepareProfile(appDirectory:string,bundleRoot:string,args:string[],sid:string):Profile{
 const options=args.flatMap((a,i)=>a==='--data-dir'?[args[i+1]]:[]);if(options.length>1||options.some(v=>!v||v.startsWith('--')||!isAbsolute(v)))throw Error('data-config');
 let configured='data';const selected=selectionFile(bundleRoot,sid),file=existsSync(selected)?selected:join(bundleRoot,'quota-monitor.json');if(!options.length&&existsSync(file)){if(lstatSync(file).size>4096)throw Error('data-config');let value;try{value=JSON.parse(readFileSync(file,'utf8'));}catch{throw Error('data-config');}if(value.schema!==1||typeof value.dataRoot!=='string'||!value.dataRoot.trim())throw Error('data-config');configured=value.dataRoot;}
 const dataRoot=resolve(options[0]??resolve(bundleRoot,configured));if(/["\r\n\0]/.test(dataRoot)||contained(appDirectory,dataRoot)||contained(dataRoot,appDirectory))throw Error('data-location');
 // Canonical local paths prevent two aliases from opening one Chromium encryption context.
 if(!existsSync(dataRoot)&&(options.length||existsSync(file)))throw Error('data-missing');checkAncestors(dataRoot);mkdirSync(dataRoot,{recursive:true});if(canonical(realpathSync(dataRoot))!==canonical(dataRoot))throw Error('data-redirect');
 const owner=hash(sid),directory=join(dataRoot,'users',owner.slice(0,24)),id=hash(PRODUCT+'\0'+sid+'\0'+canonical(dataRoot));
 checkAncestors(directory);mkdirSync(directory,{recursive:true});if(canonical(realpathSync(directory))!==canonical(directory))throw Error('data-redirect');
 const marker=join(directory,'profile.json');let firstRun=false;
 const valid=(saved:any)=>saved.schema===1&&saved.product===PRODUCT&&saved.owner===owner&&typeof saved.id==='string'&&/^[a-f0-9-]{36}$/.test(saved.id);
 if(existsSync(marker)){checkAncestors(marker);if(lstatSync(marker).size>4096)throw Error('data-owner');const saved=JSON.parse(readFileSync(marker,'utf8'));if(!valid(saved))throw Error('data-owner');}
 else{if(readdirSync(directory).length)throw Error('data-owner');try{writeFileSync(marker,JSON.stringify({schema:1,product:PRODUCT,owner,id:randomUUID()}),{flag:'wx'});firstRun=true;}catch{const saved=JSON.parse(readFileSync(marker,'utf8'));if(!valid(saved))throw Error('data-owner');}}
 const probe=join(directory,'.write-check-'+randomUUID());try{writeFileSync(probe,'',{flag:'wx'});}finally{if(existsSync(probe))unlinkSync(probe);}
 for(const part of ['electron','session','logs']){const p=join(directory,part);checkAncestors(p);mkdirSync(p,{recursive:true});if(canonical(realpathSync(p))!==canonical(p))throw Error('data-redirect');}
 return {dataRoot,directory,owner,id,taskName:'Senge.QuotaMonitor.Portable.'+id.slice(0,24),appId:'local.quota-monitor.'+id.slice(0,24),firstRun:!existsSync(join(directory,'settings.json'))};
}
