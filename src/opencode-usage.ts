import {SafeError} from './model';
import type {McpToolResult} from './opencode-mcp';

export const OPENCODE_USAGE_RANGES=['24h','7d','30d','all'] as const;
export type OpenCodeUsageRange=typeof OPENCODE_USAGE_RANGES[number];
/** Independent official totals for one rolling period; these are neither daily buckets nor Go quota. */
export interface OpenCodeUsagePeriod {
 range:OpenCodeUsageRange;
 requests:string;
 inputTokens:string;
 outputTokens:string;
 cacheReadTokens:string;
 cacheWriteTokens:string;
 costUsd:number;
}
/** Renderer-safe projection. Account identifiers and model/budget details stay in the main process. */
export interface OpenCodeUsageSummary {periods:OpenCodeUsagePeriod[];updatedAt:number}

const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const schema=()=>new SafeError('schema');
function count(value:unknown):string {
 if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw schema();
 return String(value);
}
function payload(result:McpToolResult):Record<string,unknown> {
 if(!object(result)||(result.isError!==undefined&&result.isError!==false))throw schema();
 if(result.structuredContent!==undefined){if(!object(result.structuredContent))throw schema();return result.structuredContent;}
 if(!Array.isArray(result.content)||result.content.length!==1)throw schema();
 const block=result.content[0];
 if(!object(block)||block.type!=='text'||typeof block.text!=='string'||Buffer.byteLength(block.text)>2*1024*1024)throw schema();
 const value:unknown=JSON.parse(block.text);
 if(!object(value))throw schema();
 return value;
}

/** The returned userId is for internal consistency checks only; never include it in renderer state. */
export function parseOpenCodeUsage(result:McpToolResult,expectedRange:OpenCodeUsageRange):{userId:string;period:OpenCodeUsagePeriod} {
 try{
  if(!(OPENCODE_USAGE_RANGES as readonly unknown[]).includes(expectedRange))throw schema();
  const value=payload(result),userId=value.user_id;
  if(typeof userId!=='string'||!userId||userId.length>256||userId.trim()!==userId||/[\p{Cc}\p{Cf}]/u.test(userId)||value.range!==expectedRange)throw schema();
  const cost=value.cost_usd;
  if(typeof cost!=='number'||!Number.isFinite(cost)||cost<0)throw schema();
  return {userId,period:{range:expectedRange,requests:count(value.requests),inputTokens:count(value.input_tokens),outputTokens:count(value.output_tokens),cacheReadTokens:count(value.cache_read_tokens),cacheWriteTokens:count(value.cache_write_tokens),costUsd:cost===0?0:cost}};
 }catch{throw schema();}
}
