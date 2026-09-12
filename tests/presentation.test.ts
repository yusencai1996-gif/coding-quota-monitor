import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tokenText,glmExpiryMs,usableCards} from '../src/presentation';

test('Token display uses 万 M 亿 without losing stored integer precision',()=>{
  for(const [value,expected]of [['0','0万'],['1','0.0001万'],['5000','0.5万'],['16000','1.6万'],['12345678','12.35M'],['160000000','1.6亿'],['999999','1M'],['99999999','1亿']])assert.equal(tokenText(value),expected);
  assert.equal(tokenText('12345678901234567890',true),'12,345,678,901,234,567,890');
  assert.equal(tokenText(null),'暂无数据');
});

test('GLM naive expiry uses Beijing and explicit timezone remains authoritative',()=>{
  assert.equal(glmExpiryMs('2026-09-15 23:59:59'),Date.parse('2026-09-15T15:59:59Z'));
  assert.equal(glmExpiryMs('2026-09-15T23:59:59Z'),Date.parse('2026-09-15T23:59:59Z'));
  for(const value of ['2026-02-30 12:00:00','2026-09-15 24:00:00','2026-09-15 12:99:00','n/a'])assert.equal(glmExpiryMs(value),null);
});

test('Used expired and status-unknown cards are not displayed; incomplete counts stay authoritative',()=>{
  const now=Date.parse('2026-09-09T12:00:00Z');
  const data={availableCount:5,detailsComplete:true,updatedAt:now,cards:[
    {kind:'weekly' as const,available:true,expiresAt:now+1000},
    {kind:'weekly' as const,available:true,expiresAt:now},
    {kind:'weekly' as const,available:false,expiresAt:now+10000},
    {kind:'weekly' as const,available:null,expiresAt:now+10000},
    {kind:'weekly' as const,available:true,expiresAt:null,expiresLocal:'2026-09-08 23:59:59'},
    {kind:'weekly' as const,available:true,expiresAt:null}
  ]};
  assert.equal(usableCards(data,'glm',now).cards.length,2);
  assert.equal(usableCards(data,'glm',now).availableCount,2);
  assert.equal(usableCards({...data,detailsComplete:false,availableCount:9},'glm',now).availableCount,9);
  assert.equal(data.cards.length,6);
});
