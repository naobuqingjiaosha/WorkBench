import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const parent = resolve('.tmp');
mkdirSync(parent, { recursive: true });
const tmp = process.env.WORKBENCH_ISOLATION_ROOT!;


process.env.WORKBENCH_TEST_MODE = '1';
const { bootstrap } = await import('../src/core/bootstrap.ts');
const { run, closeDatabase } = await import('../src/db/index.ts');
const { createWorkbench, upsertWorkType } = await import('../src/domain/service.ts');
const { registerWorkRoutes } = await import('../src/api/routes-work.ts');
const Fastify = (await import('fastify')).default;
const app = Fastify();
try {
  bootstrap();
  registerWorkRoutes(app);
  const count = async () => {
    const res = await app.inject('/api/workbenches/count');
    assert.equal(res.statusCode, 200);
    return res.json().data.total;
  };
  assert.equal(await count(), 0);
  assert.deepEqual((await app.inject('/api/workbenches/count')).json().data, { total: 0, project: 0, admin: 0 });
  const type = upsertWorkType({ code: 'count-test', name: '角标测试', category: '行政管理', mode: 'document' });
  const w = createWorkbench({ name: '测试工作', code: 'COUNT-1', workTypeId: type });
  assert.equal(await count(), 1);
  run("UPDATE workbench SET status='done' WHERE id=?", [w.id]);
  assert.equal(await count(), 0, '已完成任务不显示角标');
  run("UPDATE workbench SET status='paused' WHERE id=?", [w.id]);
  assert.equal(await count(), 1, '暂停仍属于未完成');
  run("UPDATE workbench SET archived_at=datetime('now') WHERE id=?", [w.id]);
  assert.equal(await count(), 0, '归档任务不计数');
  run("UPDATE workbench SET archived_at=NULL, deleted_at=datetime('now') WHERE id=?", [w.id]);
  assert.equal(await count(), 0, '回收站任务不计数');
  run("UPDATE workbench SET deleted_at=NULL, status='active', recurrence='monthly', schedule_due_date='2099-01-01' WHERE id=?", [w.id]);
  assert.equal(await count(), 1, '未来周期工作仍属于未完成');
  const projectType = upsertWorkType({ code: 'count-project', name: '项目计数测试', category: '项目', domain:'project', mode: 'process' });
  const project = createWorkbench({ name: '待处理项目', code: 'COUNT-P1', workTypeId: projectType });
  assert.deepEqual((await app.inject('/api/workbenches/count')).json().data, { total: 2, project: 1, admin: 1 }, '两类未结束工作统一统计');
  run("UPDATE workbench SET status='done' WHERE id=?", [project.id]);
  assert.deepEqual((await app.inject('/api/workbenches/count')).json().data, { total: 1, project: 0, admin: 1 }, '已完成项目不计入待处理');
  console.log('待处理与工作台角标：两类工作合并、空列表、进行中、已完成、暂停、归档、回收站、未来周期均通过');
} finally {
  await app.close();
  closeDatabase();
  // Cleanup belongs to the parent launcher.
}
