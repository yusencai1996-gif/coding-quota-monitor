import{tmpdir}from'node:os';import{join,isAbsolute}from'node:path';import{mkdirSync}from'node:fs';
export function testPrefix(name:string){const root=process.env.QUOTA_TEST_TEMP??join(tmpdir(),'coding-quota-monitor-tests');if(!isAbsolute(root)||!/^[a-z0-9-]+$/i.test(name))throw Error('invalid test temp');mkdirSync(root,{recursive:true});return join(root,name);}
