export const IDS=['glm','minimax','kimi','codex','deepseek','opencode'] as const;
export type Provider=typeof IDS[number];
export const NAMES:Record<Provider,string>={glm:'GLM',minimax:'MiniMax',kimi:'Kimi',codex:'Codex',deepseek:'DeepSeek',opencode:'OpenCode Go'};
export type ErrorCode='unconfigured'|'auth'|'network'|'timeout'|'rateLimit'|'schema'|'storage'|'autostart';
export class SafeError extends Error {constructor(public code:ErrorCode){super(code);}}
export const MESSAGES:Record<ErrorCode|string,string>={autostart:'Windows 登录启动设置未完成，请稍后重试',unconfigured:'待连接：请在设置中填写 Key',auth:'登录失效或 Key 无效，请更新凭据',network:'网络连接失败，请稍后重试',timeout:'请求超时，将自动重试',rateLimit:'平台限流，已降低刷新频率',schema:'接口字段暂不兼容，暂无可靠读数',storage:'Windows 加密存储不可用，请重试',idle:'等待刷新',ok:'已更新',disabled:'已停用',refreshing:'刷新中'};
export interface WindowQuota {id?:string;label:string;remaining:number|null;resetAt:number|null;unlimited?:boolean}
export interface Balance {label:string;currency:string;total:number;granted?:number;paid?:number}
export interface McpQuota {used:number|null;limit:number|null;details:{used:number|null;limit:number|null}[]}
export interface Snapshot {kind:'quota'|'balance';windows:WindowQuota[];balances:Balance[];updatedAt:number;mcp?:McpQuota}
export interface ProviderState {id:Provider;enabled:boolean;busy:boolean;status:string;failures:number;data?:Snapshot;nextAt?:number}
export interface Settings {theme:'day'|'night';pinned:boolean;launchAtLogin:boolean;notifications:boolean;detailedTokens:boolean;intervalMinutes:number;enabled:Record<Provider,boolean>}
export const defaults=():Settings=>({theme:'day',pinned:false,launchAtLogin:false,notifications:false,detailedTokens:false,intervalMinutes:5,enabled:Object.fromEntries(IDS.map(id=>[id,true])) as Record<Provider,boolean>});
export function provider(value:unknown):Provider {if(typeof value!=='string'||!IDS.includes(value as Provider))throw new SafeError('schema');return value as Provider;}
export function settings(value:unknown):Settings {const v=value as Settings;if(!v||(v.detailedTokens!==undefined&&typeof v.detailedTokens!=="boolean")||!['day','night'].includes(v.theme)||!Number.isInteger(v.intervalMinutes)||v.intervalMinutes<1||v.intervalMinutes>120||['pinned','launchAtLogin','notifications'].some(k=>typeof (v as any)[k]!=='boolean')||!v.enabled||IDS.some(id=>typeof v.enabled[id]!=='boolean'))throw new SafeError('schema');return {theme:v.theme,pinned:v.pinned,launchAtLogin:v.launchAtLogin,notifications:v.notifications,detailedTokens:v.detailedTokens??false,intervalMinutes:v.intervalMinutes,enabled:Object.fromEntries(IDS.map(id=>[id,v.enabled[id]])) as Record<Provider,boolean>};}
export function safeCode(e:unknown):ErrorCode{return e instanceof SafeError?e.code:'network';}
export function beijing(value:number|null|undefined){return value==null?'时间未知':new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(value)+' 北京时间';}
