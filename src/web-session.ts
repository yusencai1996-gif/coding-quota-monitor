import{session}from'electron';import type{WebProvider}from'./web-history-data';
const PARTITIONS={deepseek:'persist:quota-deepseek-v1',opencode:'persist:quota-opencode-v1'};
export function persistentSession(id:WebProvider){return session.fromPartition(PARTITIONS[id]);}
