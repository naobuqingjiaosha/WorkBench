import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';

const parent = resolve('.tmp');
mkdirSync(parent, { recursive: true });
const tmp = process.env.WORKBENCH_ISOLATION_ROOT!;


process.env.WORKBENCH_TEST_MODE = '1';
const db = await import('../src/db/index.ts');
const { purgeFromTrash } = await import('../src/core/trash.ts');
try {
  if (process.argv.includes('--snapshot')) {
    const source = new DatabaseSync(resolve('data/runtime/workbench.db'), { readOnly: true });
    try { await backup(source, process.env.WORKBENCH_DB!); } finally { source.close(); }
    db.openDatabase(process.env.WORKBENCH_DB!);
    // 仅在一致性副本上重现截图中的外键错误，不执行任何磁盘文件删除。
    assert.throws(() => db.run('DELETE FROM artifact WHERE id=265'), /FOREIGN KEY/);
    purgeFromTrash('artifact', 265, { withFile: false });
    assert.equal(db.get('SELECT id FROM artifact WHERE id=265'), undefined);
    purgeFromTrash('workbench', 98, { withFile: false });
    assert.equal(db.get('SELECT id FROM workbench WHERE id=98'), undefined);
    assert.equal(db.get('SELECT id FROM artifact WHERE id=266'), undefined);
    console.log('真实数据副本：重现外键失败；文件 #265 与工作台 #98 修复后清理成功');
  } else {
    const { bootstrap } = await import('../src/core/bootstrap.ts');
    const { createWorkbench, upsertWorkType, deleteWorkbench } = await import('../src/domain/service.ts');
    bootstrap();
    const type = upsertWorkType({ code: 'trash-review', name: '删除测试', category: '项目实施', mode: 'process' });
    const w = createWorkbench({ name: '测试', code: 'TRASH-1', workTypeId: type });
    const insert = () => {
      const id = Number(db.run("INSERT INTO artifact(workbench_id,title,file_rel,file_name) VALUES(?,'缺失文件','missing.docx','missing.docx')", [w.id]).lastInsertRowid);
      db.run("INSERT INTO artifact_fact_review(artifact_id,snapshot) VALUES(?,'{}')", [id]);
      return id;
    };
    const a = insert();
    const b = insert();
    assert.throws(() => purgeFromTrash('artifact', a), /还没有移到回收站/);
    assert.ok(db.get('SELECT artifact_id FROM artifact_fact_review WHERE artifact_id=?', [a]));
    deleteWorkbench(w.id);
    assert.equal(purgeFromTrash('artifact', a).filesRemoved, 0);
    assert.equal(db.get('SELECT artifact_id FROM artifact_fact_review WHERE artifact_id=?', [a]), undefined);
    assert.ok(db.get('SELECT artifact_id FROM artifact_fact_review WHERE artifact_id=?', [b]));
    purgeFromTrash('workbench', w.id);
    assert.equal(db.get('SELECT id FROM workbench WHERE id=?', [w.id]), undefined);
    assert.equal(db.get('SELECT artifact_id FROM artifact_fact_review WHERE artifact_id=?', [b]), undefined);
    console.log('回收站：拒绝直接删除、缺失文件清理、核对快照清理、整工作台清理均通过');
  }
  assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
} finally {
  db.closeDatabase();
  // Cleanup belongs to the parent launcher.
}
