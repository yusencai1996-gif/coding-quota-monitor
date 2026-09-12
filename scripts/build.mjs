import {build} from 'esbuild';
import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('dist',{recursive:true});
await build({entryPoints:['src/main.ts'],outfile:'dist/main.cjs',bundle:true,platform:'node',target:'node24',external:['electron']});
await build({entryPoints:['src/preload.ts'],outfile:'dist/preload.cjs',bundle:true,platform:'node',external:['electron']});
await build({entryPoints:['src/renderer.ts'],outfile:'dist/renderer.js',bundle:true,platform:'browser',target:'chrome140'});
for(const name of ['index.html','style.css']) await copyFile('src/'+name,'dist/'+name);
await copyFile('node_modules/acorn/LICENSE','dist/ACORN-LICENSE.txt');
