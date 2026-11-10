import assert from 'node:assert/strict';
import { initDatabase, closeDatabase } from '../../src/db/index.ts';
import { tryRecordTurn } from '../../src/domain/work-record-chat.ts';
import { changeWorkRecord, recordHistory, searchWorkRecords, interpretRecord } from '../../src/domain/work-records.ts';
import { authorizeRequest, decideRequest, pendingRequests } from '../../src/ai/consent.ts';

initDatabase(process.env.WORKBENCH_DB!);
try {
  const message = '记一下：计划核对样例清单';
  const input = {message, requestKey:'synthetic-record-1'};
  const note = tryRecordTurn(input)!;
  assert.equal(note.model, '本地工作记录');
  assert.equal(tryRecordTurn(input)!.messageId, note.messageId);
  const [row] = searchWorkRecords().items;
  assert.equal(row!.occurred_from, null);
  assert.equal(row!.nature, 'plan');
  const correction = changeWorkRecord(row!.id, {revision: row!.revision, text:'已核对样例清单', nature:'done', occurred_from:'2024-02-29', occurred_to:'2024-02-29'});
  assert.equal(recordHistory(row!.id)[0]!.text, message);
  assert.throws(() => changeWorkRecord(row!.id, {revision:row!.revision, text:'过时的改动'}), /更正/);
  assert.match(tryRecordTurn(input)!.text, /已更正或撤回/);
  changeWorkRecord(row!.id, {revision:correction.revision, status:'withdrawn'});
  assert.equal(searchWorkRecords().total, 0);
  assert.equal(interpretRecord('如果计划整理资料', '2024-03-02').nature, 'unknown');
  assert.equal(interpretRecord('2月29日整理资料', '2024-03-02').occurred_from, null);
  assert.equal(interpretRecord('今年2月29日整理资料', '2024-03-02').occurred_from, '2024-02-29');
  // Exercise the consent boundary without sending a request or loading credentials.
  const waiting = authorizeRequest('https://model.invalid', '{"model":"synthetic"}', '生成草稿');
  const [request] = pendingRequests();
  assert.throws(() => decideRequest(request!.id, 'wrong digest', true), /变更/);
  decideRequest(request!.id, request!.digest, false);
  await assert.rejects(waiting, /取消/);
  console.log('工作记录重试、更正、撤回、原话引用与模型外发拒绝');
} finally { closeDatabase(); }
