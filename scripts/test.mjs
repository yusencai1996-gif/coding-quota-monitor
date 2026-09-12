import {build} from 'esbuild';
import {mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
await mkdir('dist/tests',{recursive:true});
await build({entryPoints:['tests/core.test.ts'],outfile:'dist/tests/core.test.cjs',bundle:true,platform:'node',external:['electron']});
const p=spawnSync(process.execPath,['--test','--test-concurrency=1',...process.argv.slice(2),'dist/tests/core.test.cjs','tests/package-safety.test.mjs'],{stdio:'inherit'});process.exitCode=p.status??1;
