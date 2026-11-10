import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import ExcelJS from 'exceljs';
import {bootstrap} from '../../src/core/bootstrap.ts';
import {closeDatabase,get,run} from '../../src/db/index.ts';
import {setRootGrants} from '../../src/core/paths.ts';
import {importAnnualLedger,addLedgerEntry,patchLedgerEntry,ledgerView,generateLedgerForms,setLedgerTemplate} from '../../src/domain/annual-ledger.ts';
import {emptyFields,importLedgerBook,readLedgerRows,writeLedgerEntry,saveBookVersion} from '../../src/domain/ledger-office.ts';
import {ledgerBooks,ledgerScopeFixture} from './ledger-fixture.ts';

bootstrap();
try {
  const {work,period}=ledgerScopeFixture();
  for (const row of [1,4,10]){
    const book=new ExcelJS.Workbook();await book.xlsx.load((await ledgerBooks(row)).ledger as never);
    const {meta,entries}=importLedgerBook(book);
    assert.equal(entries.length,1);const original=entries[0]!;
    assert.equal(readLedgerRows(book,meta).rows.get(original.id)?.row,row+1);
    writeLedgerEntry(book,meta,'synthetic-new',{...emptyFields(),project:'合成新项目',subject:'合成新事项'});
    assert.equal(book.getWorksheet('合成新项目')!.getCell(row,3).text,'监督事项');
    const reread=readLedgerRows(book,meta);
    assert.deepEqual(reread.issues,[]);assert.equal(reread.rows.size,2);
    assert.equal(reread.rows.get('synthetic-new')?.fields.subject,'合成新事项');
    book.getWorksheet('合成项目')!.getCell(row,4).value='意外换列';
    assert.match(readLedgerRows(book,meta).issues.join(''),/列位置或名称/);
  }
  const files=await ledgerBooks(),root=process.env.WORKBENCH_ISOLATION_ROOT!;
  const bound=mkdtempSync(join(root,'bound-')),path=join(bound,'年度合成.xlsx');writeFileSync(path,files.ledger);
  run('UPDATE workbench SET external_root=? WHERE id=?',[bound,work.id]);
  setRootGrants([{root:bound,purpose:'readonly'}]);
  await assert.rejects(importAnnualLedger(period.id,'年度合成.xlsx',files.ledger,path), /只读/);
  assert.deepEqual(readFileSync(path),files.ledger);
  assert.deepEqual(readdirSync(bound),['年度合成.xlsx']);
  setRootGrants([{root:bound,purpose:'writable'}]);
  await importAnnualLedger(period.id,'年度合成.xlsx',files.ledger,path);
  assert.notDeepEqual(readFileSync(path),files.ledger);
  assert.deepEqual(readFileSync(join(bound,'.versions',readdirSync(join(bound,'.versions'))[0]!)),files.ledger);
  const entered=await addLedgerEntry(period.id,{project:'合成项目',subject:'其他合成事项',content:'合成具体内容',findings:'合成结果'});
  await assert.rejects(patchLedgerEntry(period.id,entered.id,entered.revision,{inspection_date:'2028-12-09'},true),/期次/);
  const current=(await ledgerView(period.id)).entries.find(e=>e.id===entered.id)!;
  assert.equal(current.revision,entered.revision);assert.equal(current.inspection_id,null);assert.equal(current.status,'draft');
  assert.equal(get<{n:number}>('SELECT COUNT(*) n FROM inspection_record')!.n,0);
  run("UPDATE ledger_entry SET status='confirmed' WHERE id=?",[entered.id]); // Legacy orphan.
  assert.equal((await ledgerView(period.id)).entries.find(e=>e.id===entered.id)?.status,'draft');
  assert.equal(get('SELECT status FROM ledger_entry WHERE id=?',[entered.id])!.status,'confirmed');
  await Promise.all(['work','supervision'].map(kind=>setLedgerTemplate(period.id,kind,kind+'.xlsx',files[kind as 'work'|'supervision'])));
  const generated=await generateLedgerForms(period.id,entered.id);
  assert.equal(generated.documents.length,2);assert.equal(get<{n:number}>('SELECT COUNT(*) n FROM inspection_record')!.n,0);
  const existing=readFileSync(path);
  await assert.rejects(saveBookVersion(path,new ExcelJS.Workbook(),'stale'),/变化/);
  assert.deepEqual(readFileSync(path),existing);assert.equal(readdirSync(bound).some(s=>s.endsWith('.tmp')),false);
  setRootGrants([{root:bound,purpose:'readonly'}]);
  await assert.rejects(saveBookVersion(path,new ExcelJS.Workbook(),'stale'),/只读/);
  console.log('年度台账表头1/4/10行、新项目关联、原件只读、备份、并发双模板、跨月登记回滚、未生成实际检查和冲突临时文件清理通过。');
} finally {closeDatabase();}
