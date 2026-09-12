import{parse as parseJS}from'acorn';import{SafeError}from'./model';
export const OPCODE_USAGE_REFERENCE='bfd684bfc2e4eed05cd0b518f5e4eafd3f3376e3938abb9e536e7c03df831e5c';
export const OPCODE_USAGE_ASSET='https://opencode.ai/_build/assets/index-_j7dlUrM.js';
const fail=()=>{throw new SafeError('schema');};
export function encodeUsageArgs(workspace:string,page:number){if(!/^[A-Za-z0-9_-]{1,160}$/.test(workspace)||!Number.isInteger(page)||page<0||page>2000)return fail();return JSON.stringify({t:{t:9,i:0,l:2,a:[{t:1,s:workspace},{t:0,s:page}],o:0},f:31,m:[]});}
export function workspaceFromURL(value:string){try{const u=new URL(value),m=/^\/workspace\/([A-Za-z0-9_-]{1,160})(?:\/|$)/.exec(u.pathname);return u.origin==='https://opencode.ai'?m?.[1]:undefined;}catch{return;}}
export function publicUsageReference(source:string):string|null{
 if(source.length>2*1024*1024)return null;let ast:any;try{ast=parseJS(source,{ecmaVersion:'latest',sourceType:'module'});}catch{return null;}
 const factories=new Set<string>(),bindings=new Map<string,any>();let target:string|undefined;
 for(const n of ast.body){if(n.type==='ImportDeclaration'&&/^\.\/server-runtime-[A-Za-z0-9_-]+\.js$/.test(n.source.value))for(const s of n.specifiers)if(s.type==='ImportSpecifier'&&['a','createServerReference'].includes(s.imported.name))factories.add(s.local.name);
 if(n.type==='VariableDeclaration')for(const d of n.declarations){if(d.id.type!=='Identifier')continue;bindings.set(d.id.name,d.init);const c=d.init;if(c?.type==='CallExpression'&&c.arguments?.[1]?.value==='usage.list'&&c.arguments[0].type==='Identifier')target=c.arguments[0].name;}}
 for(let i=0;target&&i<4;i++){const n=bindings.get(target);if(n?.type==='Identifier'){target=n.name;continue;}if(n?.type==='CallExpression'&&n.callee.type==='Identifier'&&factories.has(n.callee.name)&&n.arguments.length===1&&/^[a-f0-9]{64}$/.test(n.arguments[0].value))return n.arguments[0].value;return null;}return null;
}
// Data-only Seroval interpreter. No eval/vm/Function, global objects, methods, prototypes or loops.
// The supported subset covers plain arrays/objects, references, dates and scalar values.
class DataInterpreter {
 private owned=new WeakSet<object>();private lambdas=new WeakSet<object>();private steps=0;private root:Record<string,unknown>;private env:Map<string,unknown>;
 constructor(){this.root=this.object();const self=this.object();self.$R=this.root;this.env=new Map([['$R',this.root],['self',self],['undefined',undefined]]);}
 private object(){const value=Object.create(null);this.owned.add(value);return value;}
 private key(value:unknown){if((typeof value!=='string'&&typeof value!=='number')||String(value).length>256||['__proto__','prototype','constructor'].includes(String(value)))return fail();return String(value);}
 private container(value:any){if(!value||typeof value!=='object'||!this.owned.has(value))return fail();return value;}
 private property(n:any,env:Map<string,unknown>,depth:number){return this.key(n.computed?this.visit(n.property,env,depth+1):n.property.name);}
 run(code:string){let ast:any;try{ast=parseJS(code,{ecmaVersion:'latest'});}catch{return fail();}return this.visit(ast,this.env,0);}
 private visit(n:any,env:Map<string,unknown>,depth:number):any{
  if(!n||depth>120||++this.steps>200000)return fail();const v=(x:any)=>this.visit(x,env,depth+1);
  switch(n.type){
   case'Program':{let result;for(const s of n.body)result=v(s);return result;}
   case'ExpressionStatement':return v(n.expression);
   case'Literal':if(n.regex)return fail();if(n.bigint!==undefined)return n.bigint;if(typeof n.value==='number'&&!Number.isFinite(n.value))return fail();return n.value;
   case'Identifier':if(!env.has(n.name))return fail();return env.get(n.name);
   case'ArrayExpression':{if(n.elements.length>100000)return fail();const a:any[]=[];this.owned.add(a);for(const e of n.elements)a.push(e?v(e):undefined);return a;}
   case'ObjectExpression':{const o=this.object();for(const p of n.properties){if(p.type!=='Property'||p.kind!=='init'||p.method)return fail();const key=this.key(p.computed?v(p.key):p.key.name??p.key.value);o[key]=v(p.value);}return o;}
   case'MemberExpression':{const o=this.container(v(n.object)),key=this.property(n,env,depth);return Object.hasOwn(o,key)?o[key]:undefined;}
   case'AssignmentExpression':{if(n.operator!=='=')return fail();const value=v(n.right);if(n.left.type==='Identifier'){if(!env.has(n.left.name))return fail();env.set(n.left.name,value);return value;}if(n.left.type!=='MemberExpression')return fail();const o=this.container(v(n.left.object)),key=this.property(n.left,env,depth);if(Array.isArray(o)&&((/^\d+$/.test(key)&&Number(key)>100000)||(key==='length'&&(!Number.isInteger(value)||value<0||value>100000))))return fail();o[key]=value;return value;}
   case'SequenceExpression':{let result;for(const e of n.expressions)result=v(e);return result;}
   case'LogicalExpression':{const left=v(n.left);if(n.operator==='||')return left||v(n.right);if(n.operator==='&&')return left&&v(n.right);return fail();}
   case'UnaryExpression':{const x=v(n.argument);if(n.operator==='void')return undefined;if(n.operator==='!')return !x;if(n.operator==='-'&&typeof x==='number')return -x;return fail();}
   case'ArrowFunctionExpression':{if(n.async||n.params.some((p:any)=>p.type!=='Identifier'))return fail();const fn={lambda:true,node:n,env:new Map(env)};this.lambdas.add(fn);return fn;}
   case'CallExpression':{const f=v(n.callee);if(!f||!this.lambdas.has(f)||!f.node||n.arguments.some((a:any)=>a.type==='SpreadElement'))return fail();const args=n.arguments.map(v),scope=new Map<string,unknown>(f.env);f.node.params.forEach((p:any,i:number)=>scope.set(p.name,args[i]));return this.visit(f.node.body,scope,depth+1);}
   case'NewExpression':{if(n.callee.type!=='Identifier'||n.callee.name!=='Date'||n.arguments.length!==1)return fail();const x=v(n.arguments[0]);if(typeof x!=='number'&&typeof x!=='string')return fail();const date=new Date(x);if(!Number.isFinite(date.getTime()))return fail();return date.toISOString();}
   default:return fail();
  }
 }
}
export function decodeUsageResponse(body:string,contentType:string):unknown{
 if(Buffer.byteLength(body)>2*1024*1024)return fail();if(contentType.startsWith('application/json')){try{return JSON.parse(body);}catch{return fail();}}
 if(!contentType.startsWith('text/javascript'))return fail();const buffer=Buffer.from(body),interpreter=new DataInterpreter();let cursor=0,result:unknown;
 while(cursor<buffer.length){if(buffer.length-cursor<12)return fail();const header=buffer.subarray(cursor,cursor+12).toString('ascii');if(!/^;0x[\da-f]{8};$/i.test(header))return fail();const size=parseInt(header.slice(1,11),16);if(size>2*1024*1024||cursor+12+size>buffer.length)return fail();result=interpreter.run(buffer.subarray(cursor+12,cursor+12+size).toString('utf8'));cursor+=12+size;}return result;
}
