import {mkdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {SafeError,provider,type Provider} from './model';
export interface CryptoPort {available():Promise<boolean>;encrypt(value:string):Promise<Buffer>;decrypt(value:Buffer):Promise<string>}
export async function atomicWrite(path:string,value:string|Buffer){const temp=path+'.pending';await writeFile(temp,value,{mode:0o600});await rename(temp,path);}
// Store writes are serialized. Public methods never return plaintext, except the internal adapter reader.
export class KeyStore {
 private chain:Promise<unknown>=Promise.resolve();
 constructor(private root:string,private crypto:CryptoPort){}
 private path(id:Provider){return join(this.root,provider(id)+'.sealed');}
 private serial<T>(work:()=>Promise<T>):Promise<T>{const next=this.chain.then(work);this.chain=next.catch(()=>{});return next;}
 async has(id:Provider){try{const b=await readFile(this.path(id));return b.length>0;}catch{return false;}}
 save(id:Provider,key:unknown){return this.serial(async()=>{try{if(typeof key!=='string'||key.length<8||key.length>8192||/[\r\n\0]/.test(key))throw new SafeError('schema');if(!await this.crypto.available())throw new SafeError('storage');const encrypted=await this.crypto.encrypt(key);if(!encrypted.length)throw new SafeError('storage');await mkdir(this.root,{recursive:true});await atomicWrite(this.path(id),encrypted);}catch{throw new SafeError('storage');}});}
 remove(id:Provider){return this.serial(async()=>{try{await unlink(this.path(id));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw new SafeError('storage');}});}
 async readForRequest(id:Provider):Promise<string>{await this.chain;try{if(!await this.crypto.available())throw new SafeError('storage');const b=await readFile(this.path(id));return await this.crypto.decrypt(b);}catch(e){throw new SafeError((e as NodeJS.ErrnoException).code==='ENOENT'?'unconfigured':'storage');}}
}
