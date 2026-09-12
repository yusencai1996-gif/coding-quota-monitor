import{existsSync}from'node:fs';import{resolve}from'node:path';import{spawnSync}from'node:child_process';
// Electron 44 exposes install-electron separately from npm dependency installation.
if(!existsSync(resolve('node_modules/electron/dist/electron.exe'))){const result=spawnSync(process.execPath,[resolve('node_modules/electron/install.js')],{stdio:'inherit',windowsHide:true});if(result.status!==0)process.exit(result.status??1);}
