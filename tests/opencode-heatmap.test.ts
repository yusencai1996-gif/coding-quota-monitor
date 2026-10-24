import test from 'node:test';
import assert from 'node:assert/strict';
import {activityView} from '../src/activity-view';
import {aggregate,mergeHistory} from '../src/activity-parsers';
import {parseOpenCodeContext} from '../src/opencode-usage';
import {SafeError} from '../src/model';
import type {TokenHistory} from '../src/activity-model';

const now=Date.parse('2026-10-24T17:00:00Z'); // Already Oct 25 in Beijing, still Oct 24 in UTC.
const history:TokenHistory={schema:1,source:'opencode-export-v2',sourceTimezone:'UTC',updatedAt:now,days:[{date:'2026-10-22',tokens:'10000'},{date:'2026-10-23',tokens:'1000000'},{date:'2026-10-24',tokens:'100000000',partial:true}]};
test('OpenCode export heatmap keeps UTC day boundaries and aggregates real rows by week and month',()=>{
 const daily=aggregate(history,'day',now);assert.equal(daily.at(-1)?.start,'2026-10-24');assert.equal(daily.at(-1)?.tokens,'100000000');assert.equal(daily.at(-1)?.partial,true);
 assert.equal(aggregate(history,'week',now).at(-1)?.tokens,'101010000');assert.equal(aggregate(history,'month',now).at(-1)?.tokens,'101010000');assert.equal(daily.find(d=>d.start==='2026-10-21')?.tokens,null);
 const merged=mergeHistory(history,{...history,days:[{date:'2026-10-25',tokens:'1'}]},now);assert.ok(!merged.days.some(d=>d.date==='2026-10-25'));
});
test('OpenCode uses shared heatmap controls and compact hover units with explicit UTC source',()=>{
 for(const mode of ['day','week','month'] as const){
  const html=activityView('opencode',{history:{status:'ok',busy:false,data:history},cards:{status:'unsupported',busy:false}},mode);
  assert.ok(html.includes('data-heat-mode="day"'));assert.ok(html.includes('data-heat-mode="week"'));assert.ok(html.includes('data-heat-mode="month"'));assert.ok(html.includes('role="gridcell"'));assert.ok(html.includes('data-tooltip='));assert.ok(html.includes('UTC 自然日'));assert.ok(!html.includes('北京时间日'));
  if(mode==='day'){assert.ok(html.includes('1万 tokens'));assert.ok(html.includes('1M tokens'));assert.ok(html.includes('1亿 tokens'));}
 }
});
test('OpenCode context projects identity only and rejects invalid workspace scope',()=>{
 const result={structuredContent:{user:{id:'USER',email:'PRIVATE'},workspace:{id:'wrk_TEST',name:'PRIVATE',role:'owner'}}};
 assert.deepEqual(parseOpenCodeContext(result),{userId:'USER',orgId:'wrk_TEST'});
 for(const id of ['','https://evil.test','wrk_bad\r\nAuthorization:secret','abc'])assert.throws(()=>parseOpenCodeContext({structuredContent:{user:{id:'USER'},workspace:{id}}}),SafeError);
 assert.throws(()=>parseOpenCodeContext({structuredContent:{user:{id:'OTHER\nUSER'},workspace:{id:'wrk_TEST'}}}),SafeError);
});
