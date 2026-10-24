import type {Provider} from './model';
export type ActivityProvider='glm'|'codex';
export type ActivityKind='history'|'cards';
export interface DayBucket {date:string;tokens:string;partial?:boolean}
export interface TokenHistory {schema:1;source:'codex-profile-v1'|'glm-activity-v1'|'deepseek-web-v1'|'opencode-web-v1'|'opencode-export-v2'|'kimi-local-v1'|'zcode-local-v1';sourceTimezone:'platform-date'|'Asia/Shanghai'|'UTC';days:DayBucket[];updatedAt:number}
export interface ResetCard {kind:'five-hour'|'weekly'|'codex'|'other';available:boolean|null;expiresAt:number|null;expiresLocal?:string}
export interface ResetCards {availableCount:number|null;cards:ResetCard[];detailsComplete:boolean;updatedAt:number}
export interface AuxiliaryResource<T> {status:string;busy:boolean;data?:T;nextAt?:number}
export interface AuxiliaryState {history:AuxiliaryResource<TokenHistory>;cards:AuxiliaryResource<ResetCards>}
export type AuxiliaryPublic=Record<Provider,AuxiliaryState>;
export interface AggregateCell {start:string;end:string;tokens:string|null;knownDays:number;expectedDays:number;partial:boolean}
