import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {bootstrap} from '../../src/core/bootstrap.ts';
import {closeDatabase, get, run} from '../../src/db/index.ts';
import {archiveWorkbench, completeWorkbench, createWorkbench, getWorkbenchDetail, registerTemplate, setBoundTemplateIds, setPositionStatus, unarchiveWorkbench} from '../../src/domain/service.ts';
import {dossierReadiness} from '../../src/domain/dossier.ts';
import {reviewProjectMaterial} from '../../src/domain/workflow.ts';
import {projectFixture, publishProject} from './project-fixture.ts';

bootstrap();
try {
  const config=projectFixture();
  const base={workTypeId:config.typeId,publishedConfigId:config.publishedId};
  const active=createWorkbench({...base,name:'合成在办项目'});
  const history=createWorkbench({...base,name:'合成历史项目',historical:true});
  assert.equal(history.status,'done');
  assert.equal(history.actual_end_date,null);
  assert.equal(history.start_date,null);
  const detail=(id:number)=>getWorkbenchDetail(id,false)!;
  const stage=detail(history.id).positions[0]!;
  assert.equal(stage.status,'pending');
  assert.equal(stage.description,'核对外部交付材料');
  assert.equal(stage.started_at,null);
  assert.equal(stage.finished_at,null);
  assert.deepEqual(dossierReadiness(history.id).missing,['交付核验 · 交付证明：待提供或核对']);
  assert.throws(()=>archiveWorkbench(history.id), /交付证明/);
  assert.throws(()=>reviewProjectMaterial(stage.checklist[0]!.id,{status:'verified'}), /材料数量不足/);
  assert.throws(()=>setPositionStatus(stage.id,'skipped',{note:' '}), /原因/);
  setPositionStatus(stage.id,'skipped',{note:'合成项目明确不适用'});
  assert.equal(dossierReadiness(history.id).canArchive,true);
  assert.equal(detail(history.id).positions[0]!.finished_at,null);

  // One required document belongs to the whole project in addition to its stages.
  const templatePath=join(process.env.WORKBENCH_ISOLATION_ROOT!, '合成材料.txt');
  writeFileSync(templatePath,'合成模板');
  const template=registerTemplate({absSourcePath:templatePath,workTypeId:config.typeId,name:'合成整体说明'});
  setBoundTemplateIds(history.id,[template.id],[template.id]);
  for (const archived of [null,'2025-01-01']) {
    run('UPDATE template SET archived_at=? WHERE id=?',[archived,template.id]);
    assert.equal(dossierReadiness(history.id).canArchive,false);
    assert.match(dossierReadiness(history.id).missing.join(' '),/工作级必备文书.*合成整体说明/);
    assert.throws(()=>archiveWorkbench(history.id),/合成整体说明/);
  }
  assert.throws(()=>completeWorkbench(active.id),/阶段未结束/);
  archiveWorkbench(active.id);
  assert.equal(detail(active.id).workbench.archive_status,'active');
  unarchiveWorkbench(active.id);
  assert.equal(detail(active.id).workbench.status,'active');
  const originalSnapshot=get<{rules_snapshot:string}>('SELECT rules_snapshot FROM workbench WHERE id=?',[active.id])!.rules_snapshot;
  config.payload.stages[0]!.name='新工作使用的新阶段';
  const changed=publishProject(config);
  assert.equal(detail(active.id).positions[0]!.name,'交付核验');
  const newer=createWorkbench({workTypeId:changed.typeId,publishedConfigId:changed.publishedId,name:'新流程合成项目'});
  assert.equal(detail(newer.id).positions[0]!.name,'新工作使用的新阶段');
  assert.equal(get<{rules_snapshot:string}>('SELECT rules_snapshot FROM workbench WHERE id=?',[active.id])!.rules_snapshot,originalSnapshot);
  console.log('项目验收通过：历史未知日期、在办收起恢复、阶段与工作级材料门槛、停用模板与旧快照均核对。');
} finally {
  closeDatabase();
}
